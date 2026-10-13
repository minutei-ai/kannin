import Turbopuffer from "@turbopuffer/turbopuffer";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { createHash } from "node:crypto";
import type { Filter } from "../src/protocol";
import { Query, QueryResult, Write, Metadata } from "../src/protocol";
import { corpus } from "./corpus";

const url = new URL(Effect.runSync(Config.String("RAIO_URL")));
const raioToken = Effect.runSync(Config.Redacted("RAIO_API_TOKEN"));
const turboToken = Effect.runSync(Config.Redacted("TURBOPUFFER_API_KEY"));
const size = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1000000 })),
)(Number(process.env.RAIO_BENCH_DOCUMENTS ?? 10000));
const freshNamespace = `raio-bench-${crypto.randomUUID()}`;
const reuse = Effect.runSync(Config.option(Config.String("RAIO_BENCH_REUSE_NAMESPACE")));
const namespace = Option.match(reuse, {
  onNone: () => freshNamespace,
  onSome: Schema.decodeSync(Schema.String.check(Schema.isPattern(/^raio-bench-[a-f0-9-]{36}$/))),
});
const region = "aws-sa-east-1";
const client = new Turbopuffer({ apiKey: Redacted.value(turboToken), region, maxRetries: 0 });
const comparator = client.namespace(freshNamespace);
const headers = new Headers({
  authorization: `Bearer ${Redacted.value(raioToken)}`,
  "content-type": "application/json",
});
await using cleanup = new AsyncDisposableStack();
cleanup.defer(async () => {
  await comparator.deleteAll().catch((cause: unknown) => {
    if (Schema.is(Schema.Struct({ status: Schema.Literal(404) }))(cause)) return;
    throw cause;
  });
});
const report = await (async () => {
  const hash = createHash("sha256");
  const ingestion = { raioMs: 0, turbopufferMs: 0 };
  const rays = new Set<string>();
  console.error(
    `Benchmark namespace: ${namespace}; documents: ${size}; comparator region: ${region}`,
  );
  for (const offset of Array.from(
    { length: Math.ceil(size / 500) },
    (_, ordinal) => ordinal * 500,
  )) {
    const documents = corpus(offset, size);
    hash.update(JSON.stringify(documents));
    if (Option.isNone(reuse)) {
      const started = performance.now();
      const response = await fetch(new URL(`/v1/namespaces/${namespace}/write`, url), {
        method: "POST",
        headers,
        body: Schema.encodeSync(Schema.fromJsonString(Write))({
          requestId: `batch-${offset}`,
          upserts: documents,
          deletes: [],
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Raio ingestion failed: ${response.status} ${body}`);
      ingestion.raioMs += performance.now() - started;
    }
    const begin = performance.now();
    const parameters: Turbopuffer.NamespaceWriteParams = {
      upsert_rows: documents.map((document) => ({
        id: document.id,
        text: document.text,
        title: "",
        group: document.attributes.group,
        year: document.attributes.year,
      })),
    };
    if (offset === 0)
      parameters.schema = {
        text: {
          type: "string",
          full_text_search: {
            stemming: false,
            remove_stopwords: false,
            ascii_folding: true,
            k1: 1.2,
            b: 0.75,
          },
        },
        title: { type: "string" },
        group: { type: "uint" },
        year: { type: "uint" },
      };
    await comparator.write(parameters);
    ingestion.turbopufferMs += performance.now() - begin;
    if (offset % 5000 === 0) console.error(`Ingested ${offset + documents.length}/${size}`);
  }
  const metadataResponse = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, url), {
    headers,
  });
  const metadata = Schema.decodeUnknownSync(Metadata)(await metadataResponse.json());
  if (metadata.documents !== size) throw new Error("Raio document count mismatch");
  const indexing = { polls: 0, ready: false, waitedMs: 0 };
  const indexingStarted = performance.now();
  for (const attempt of Array.from({ length: 180 }, (_, index) => index)) {
    const state = await comparator.metadata();
    indexing.polls += 1;
    if (state.index.status === "up-to-date") {
      indexing.ready = true;
      break;
    }
    console.error(`Comparator indexing status: ${state.index.status}`);
    if (attempt < 179) await Effect.runPromise(Effect.sleep("2 seconds"));
  }
  indexing.waitedMs = performance.now() - indexingStarted;
  if (!indexing.ready)
    throw new Error("Comparator did not finish indexing within observation window");
  const reports = [];
  for (const [name, text] of [
    ["rare", "unique42"],
    ["selective", "group42"],
    ["common", "cloudflare rust"],
    ["filtered", "cloudflare"],
  ] as const) {
    const filters: Array<typeof Filter.Type> = [];
    if (name === "filtered") filters.push({ field: "group", op: "eq", value: 42 });
    const query: typeof Query.Type = { kind: "text", text, topK: 10, filters };
    const parameters: Turbopuffer.NamespaceQueryParams = {
      consistency: { level: "strong" },
      top_k: 10,
      rank_by: ["text", "BM25", text],
      include_attributes: ["text", "title", "group", "year"],
    };
    if (name === "filtered") parameters.filters = ["group", "Eq", 42];
    const raioSamples: number[] = [];
    const turboSamples: number[] = [];
    const edgeSamples: number[] = [];
    const samples = { raio: raioSamples, edge: edgeSamples, turbopuffer: turboSamples };
    const server = [];
    const cold = { raio: 0, edge: 0, turbopuffer: 0 };
    for (const iteration of Array.from({ length: 56 }, (_, ordinal) => ordinal)) {
      const first = performance.now();
      const response = await fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
        method: "POST",
        headers,
        body: Schema.encodeSync(Schema.fromJsonString(Query))(query),
      });
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      const raioMs = performance.now() - first;
      if (!result.rows.length) throw new Error("Empty Raio result");
      const ray = response.headers.get("cf-ray");
      if (ray) rays.add(ray.split("-").at(-1) ?? ray);
      const edgeStarted = performance.now();
      const edgeResponse = await fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
        method: "POST",
        headers,
        body: Schema.encodeSync(Schema.fromJsonString(Query))({
          ...query,
          consistency: "edge-eventual",
          minimumSequence: metadata.sequence,
        }),
      });
      const edge = Schema.decodeUnknownSync(QueryResult)(await edgeResponse.json());
      const edgeMs = performance.now() - edgeStarted;
      if (
        edge.sequence < metadata.sequence ||
        JSON.stringify(edge.rows) !== JSON.stringify(result.rows)
      )
        throw new Error("Edge snapshot differs from the acknowledged corpus");
      const second = performance.now();
      const turbo = await comparator.query(parameters);
      const turboMs = performance.now() - second;
      if (!turbo.rows?.length) throw new Error("Empty Turbopuffer result");
      if (iteration === 0) {
        cold.raio = raioMs;
        cold.edge = edgeMs;
        cold.turbopuffer = turboMs;
      }
      if (iteration >= 6) {
        samples.raio.push(raioMs);
        samples.edge.push(edgeMs);
        samples.turbopuffer.push(turboMs);
        server.push(turbo.performance);
      }
    }
    const percentiles = Object.fromEntries(
      Object.entries(samples).map(([engine, values]) => {
        const ordered = values.toSorted((a, b) => a - b);
        return [engine, { p50: ordered[24], p95: ordered[47], p99: ordered[49] }];
      }),
    );
    reports.push({
      name,
      firstQueryMs: cold,
      percentiles,
      samples,
      turbopufferPerformance: server,
    });
    console.error(`${name}: ${JSON.stringify(percentiles)}`);
  }
  const final = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, url), {
    headers,
  });
  const finalMetadata = Schema.decodeUnknownSync(Metadata)(await final.json());
  return {
    runtime: "deployed-cloudflare-vs-turbopuffer",
    namespace,
    documents: size,
    corpusSha256: hash.digest("hex"),
    region,
    cloudflareColos: [...rays],
    bun: Bun.version,
    consistency: {
      raio: "strong",
      edge: "edge-eventual with acknowledged sequence barrier",
      turbopuffer: "strong",
    },
    concurrency: 1,
    batchSize: 500,
    samplesPerQuery: 50,
    warmupsPerQuery: 5,
    ingestion: {
      ...ingestion,
      raioMs: Option.match(reuse, { onNone: () => ingestion.raioMs, onSome: () => null }),
      reusedRaioCorpus: Option.isSome(reuse),
    },
    reports,
    comparatorIndexing: indexing,
    finalMetadata,
    comparatorNamespace: freshNamespace,
  };
})();
await cleanup.disposeAsync();
console.log(JSON.stringify({ ...report, comparatorDeleted: true }, null, 2));
