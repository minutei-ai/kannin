import Turbopuffer from "@turbopuffer/turbopuffer";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { createHash } from "node:crypto";
import type { Filter } from "../src/protocol";
import { Query, QueryResult, Write, Metadata } from "../src/protocol";
import { corpus } from "./corpus";

class ComparisonFailure extends Schema.TaggedError<ComparisonFailure>()("ComparisonFailure", {
  phase: Schema.Literals(["metadata", "strong", "edge", "final-metadata"]),
  status: Schema.Int,
  body: Schema.String,
  ray: Schema.Union([Schema.String, Schema.Null]),
  serverTiming: Schema.Union([Schema.String, Schema.Null]),
}) {}

const url = new URL(Effect.runSync(Config.String("RAIO_URL")));
const raioToken = Effect.runSync(Config.Redacted("RAIO_API_TOKEN"));
const turboToken = Effect.runSync(Config.Redacted("TURBOPUFFER_API_KEY"));
const size = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1000000 })),
)(Number(process.env.RAIO_BENCH_DOCUMENTS ?? 10000));
const freshNamespace = `raio-bench-${crypto.randomUUID()}`;
const reuse = Effect.runSync(Config.option(Config.String("RAIO_BENCH_REUSE_NAMESPACE")));
const resume = Effect.runSync(Config.option(Config.String("RAIO_BENCH_RESUME_NAMESPACE")));
if (Option.isSome(reuse) && Option.isSome(resume))
  throw new Error("Choose reuse or resume, not both");
const target = Option.orElse(reuse, () => resume);
const namespace = Option.match(target, {
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
console.error(`Comparator namespace: ${freshNamespace}`);
await using cleanup = new AsyncDisposableStack();
cleanup.defer(async () => {
  await comparator.deleteAll().catch((cause: unknown) => {
    if (Schema.is(Schema.Struct({ status: Schema.Literal(404) }))(cause)) return;
    throw cause;
  });
  console.error(`Comparator deletion confirmed: ${freshNamespace}`);
});
const report = await (async () => {
  const hash = createHash("sha256");
  const ingestion = { raioMs: 0, turbopufferMs: 0 };
  const rays = new Set<string>();
  console.error(
    `Benchmark namespace: ${namespace}; documents: ${size}; comparator region: ${region}`,
  );
  if (Option.isSome(resume)) {
    const existing = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, url), { headers });
    if (!existing.ok) throw new Error(`Resume metadata failed: ${existing.status}`);
    const prior = Schema.decodeUnknownSync(Metadata)(await existing.json());
    if (prior.documents === 0 || prior.documents > size)
      throw new Error("Resume requires a populated corpus no larger than the requested size");
    console.error(
      `Resuming acknowledged corpus: ${prior.documents} documents, sequence ${prior.sequence}`,
    );
  }
  const comparatorBatches = [];
  const chunks = Math.ceil(size / 500);
  const batchCount = Math.max(1, Math.floor(size / 50000));
  for (const batch of Array.from({ length: batchCount }, (_, index) => index)) {
    const first = Math.floor((batch * chunks) / batchCount);
    const end = Math.floor(((batch + 1) * chunks) / batchCount);
    const rows = [];
    for (const offset of Array.from({ length: end - first }, (_, index) => (first + index) * 500)) {
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
      rows.push(
        ...documents.map((document) => ({
          id: document.id,
          text: document.text,
          title: "",
          group: document.attributes.group,
          year: document.attributes.year,
        })),
      );
      if (offset % 5000 === 0) console.error(`Prepared ${offset + documents.length}/${size}`);
    }
    const begin = performance.now();
    const parameters: Turbopuffer.NamespaceWriteParams = { upsert_rows: rows };
    if (batch === 0)
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
    const bytes = new TextEncoder().encode(JSON.stringify(parameters)).byteLength;
    if (bytes > 64 * 1024 * 1024)
      throw new Error("Comparator batch exceeds the 64 MiB request budget");
    const written = await comparator.write(parameters, { maxRetries: 0 });
    if (written.rows_affected !== rows.length)
      throw new Error("Comparator acknowledged an unexpected row count");
    ingestion.turbopufferMs += performance.now() - begin;
    comparatorBatches.push({ rows: rows.length, bytes });
    console.error(`Comparator acknowledged ${Math.min(end * 500, size)}/${size}`);
  }
  const metadataResponse = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, url), {
    headers,
  });
  if (!metadataResponse.ok)
    throw new ComparisonFailure({
      phase: "metadata",
      status: metadataResponse.status,
      body: (await metadataResponse.text()).slice(0, 1024),
      ray: metadataResponse.headers.get("cf-ray"),
      serverTiming: metadataResponse.headers.get("server-timing"),
    });
  const metadata = Schema.decodeUnknownSync(Metadata)(await metadataResponse.json());
  if (metadata.documents !== size) throw new Error("Raio document count mismatch");
  const indexing = { polls: 0, ready: false, waitedMs: 0 };
  const indexingStarted = performance.now();
  for (const attempt of Array.from({ length: 180 }, (_, index) => index)) {
    const state = await comparator.metadata();
    indexing.polls += 1;
    if (state.index.status === "up-to-date" && state.approx_row_count === size) {
      indexing.ready = true;
      break;
    }
    console.error(
      `Comparator indexing: ${state.index.status}; rows: ${state.approx_row_count}/${size}`,
    );
    if (attempt < 179) await Effect.runPromise(Effect.sleep("2 seconds"));
  }
  indexing.waitedMs = performance.now() - indexingStarted;
  if (!indexing.ready)
    throw new Error("Comparator did not finish indexing within observation window");
  const reports = [];
  for (const [name, text, expectedRows] of [
    ["rare", "unique42", 1],
    ["selective", "group42", 10],
    ["common", "cloudflare rust", 10],
    ["filtered", "cloudflare", 10],
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
    const settled = { probes: 0, ready: false };
    for (const attempt of Array.from({ length: 360 }, (_, index) => index)) {
      const probe = await comparator.query(parameters);
      const remaining = probe.performance?.exhaustive_search_count;
      if (remaining === undefined)
        throw new Error("Comparator omitted its exhaustive-search metric");
      settled.probes += 1;
      if (remaining === 0) {
        settled.ready = true;
        break;
      }
      const state = await comparator.metadata();
      console.error(
        JSON.stringify({ case: name, index: state.index, exhaustiveSearchCount: remaining }),
      );
      if (attempt < 359) await Effect.runPromise(Effect.sleep("5 seconds"));
    }
    if (!settled.ready)
      throw new Error(
        "Comparator queries still scan unindexed rows after metadata reported readiness",
      );
    const raioSamples: number[] = [];
    const turboSamples: number[] = [];
    const edgeSamples: number[] = [];
    const samples = { raio: raioSamples, edge: edgeSamples, turbopuffer: turboSamples };
    const server = [];
    const kanninPerformance = [];
    const signatures = new Set<string>();
    const cold = { raio: 0, edge: 0, turbopuffer: 0 };
    for (const iteration of Array.from({ length: 56 }, (_, ordinal) => ordinal)) {
      const first = performance.now();
      const response = await fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
        method: "POST",
        headers,
        body: Schema.encodeSync(Schema.fromJsonString(Query))(query),
      });
      if (!response.ok)
        throw new ComparisonFailure({
          phase: "strong",
          status: response.status,
          body: (await response.text()).slice(0, 1024),
          ray: response.headers.get("cf-ray"),
          serverTiming: response.headers.get("server-timing"),
        });
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      const raioMs = performance.now() - first;
      if (
        result.rows.length !== expectedRows ||
        result.sequence !== metadata.sequence ||
        result.consistency !== "strong"
      )
        throw new Error("Kannin strong result differs from the static benchmark contract");
      const signature = JSON.stringify(result.rows);
      signatures.add(signature);
      if (signatures.size !== 1)
        throw new Error("Kannin rows or scores changed between iterations");
      const ray = response.headers.get("cf-ray");
      if (ray !== null && ray.length > 0) rays.add(ray.split("-").at(-1) ?? ray);
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
      if (!edgeResponse.ok)
        throw new ComparisonFailure({
          phase: "edge",
          status: edgeResponse.status,
          body: (await edgeResponse.text()).slice(0, 1024),
          ray: edgeResponse.headers.get("cf-ray"),
          serverTiming: edgeResponse.headers.get("server-timing"),
        });
      const edge = Schema.decodeUnknownSync(QueryResult)(await edgeResponse.json());
      const edgeMs = performance.now() - edgeStarted;
      if (
        edge.sequence !== metadata.sequence ||
        edge.consistency !== "edge-eventual" ||
        JSON.stringify(edge.rows) !== signature
      )
        throw new Error("Edge snapshot differs from the acknowledged corpus");
      const edgeRay = edgeResponse.headers.get("cf-ray");
      if (edgeRay !== null && edgeRay.length > 0) rays.add(edgeRay.split("-").at(-1) ?? edgeRay);
      const second = performance.now();
      const turbo = await comparator.query(parameters);
      const turboMs = performance.now() - second;
      if (turbo.rows === undefined || turbo.rows.length !== expectedRows)
        throw new Error("Comparator returned an unexpected row count");
      if (turbo.performance?.exhaustive_search_count !== 0)
        throw new Error("Comparator index readiness changed during measurement");
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
        kanninPerformance.push({
          strongTiming: response.headers.get("server-timing"),
          edgeTiming: edgeResponse.headers.get("server-timing"),
          strongRay: ray,
          edgeRay,
          strongPlacement: response.headers.get("cf-placement"),
          edgePlacement: edgeResponse.headers.get("cf-placement"),
        });
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
      comparatorReadiness: settled,
      firstQueryMs: cold,
      percentiles,
      samples,
      turbopufferPerformance: server,
      kanninPerformance,
    });
    console.error(`${name}: ${JSON.stringify(percentiles)}`);
  }
  const final = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, url), {
    headers,
  });
  if (!final.ok)
    throw new ComparisonFailure({
      phase: "final-metadata",
      status: final.status,
      body: (await final.text()).slice(0, 1024),
      ray: final.headers.get("cf-ray"),
      serverTiming: final.headers.get("server-timing"),
    });
  const finalMetadata = Schema.decodeUnknownSync(Metadata)(await final.json());
  if (finalMetadata.sequence !== metadata.sequence || finalMetadata.documents !== size)
    throw new Error("The benchmark corpus changed during measurement");
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
    batchSizes: { raio: 500, turbopuffer: comparatorBatches },
    samplesPerQuery: 50,
    warmupsPerQuery: 5,
    ingestion: {
      ...ingestion,
      raioMs: Option.match(reuse, { onNone: () => ingestion.raioMs, onSome: () => null }),
      reusedRaioCorpus: Option.isSome(reuse),
      resumedRaioCorpus: Option.isSome(resume),
    },
    reports,
    comparatorIndexing: indexing,
    finalMetadata,
    comparatorNamespace: freshNamespace,
  };
})();
await cleanup.disposeAsync();
console.log(JSON.stringify({ ...report, comparatorDeleted: true }, null, 2));
