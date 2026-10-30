import { Config, Console, Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { retrievalMetrics } from "./retrieval-metrics";
import {
  CompactResult,
  Document,
  Id,
  Metadata,
  QueryResult,
  Rejected,
  RpcCommand,
  sameCanonicalId,
} from "../src/protocol";
import { Miniflare } from "miniflare";
import { workerOptions, write } from "../tests/harness";

const directory = Effect.runSync(Config.String("RAIO_EVAL_DIRECTORY"));
const split = Effect.runSync(
  Config.schema(Schema.Literals(["test", "dev", "train"]), "RAIO_EVAL_SPLIT").pipe(
    Config.withDefault("test"),
  ),
);
const externalDocument = Schema.Struct({
  id: Id,
  title: Schema.String,
  text: Document.fields.text,
}).pipe(Schema.encodeKeys({ id: "_id" }));
const externalQuery = Schema.Struct({ id: Id, text: Schema.String }).pipe(
  Schema.encodeKeys({ id: "_id" }),
);
const judgment = Schema.Tuple([
  Id,
  Id,
  Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)),
]);
const corpusPath = join(directory, "corpus.jsonl");
const corpusHash = createHash("sha256");
for await (const chunk of Bun.file(corpusPath).stream()) corpusHash.update(chunk);
const queryBytes = await Bun.file(join(directory, "queries.jsonl")).text();
const qrelBytes = await Bun.file(join(directory, `qrels/${split}.tsv`)).text();
const queries = new Map(
  queryBytes
    .trim()
    .split("\n")
    .map((line) => {
      const query = Schema.decodeSync(Schema.fromJsonString(externalQuery))(line);
      return [query.id, query.text];
    }),
);
const judgments = new Map<string, Map<string, number>>();

const qrelLines = qrelBytes.trim().split(/\r?\n/);
if (qrelLines[0] !== "query-id\tcorpus-id\tscore") throw new Error("Invalid judgment header");
for (const line of qrelLines.slice(1)) {
  const [query, document, relevance] = Schema.decodeUnknownSync(judgment)(line.split("\t"));
  if (!queries.has(query)) throw new Error("Judgment references an unknown query");
  const values = judgments.get(query) ?? new Map<string, number>();
  values.set(document, relevance);
  judgments.set(query, values);
}
if (judgments.size === 0) throw new Error("No judged queries");
const clientBundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "../tests/rpc-client.ts")],
  target: "browser",
  format: "esm",
  external: ["cloudflare:workers"],
});
if (!clientBundle.success) throw new AggregateError(clientBundle.logs);
const clientArtifact = clientBundle.outputs[0];
if (clientArtifact === undefined) throw new Error("Missing SDK client artifact");
const options = await workerOptions();
const worker = new Miniflare({
  ...options,
  workers: [
    ...options.workers,
    {
      config: {
        name: "quality-client",
        compatibilityDate: "2026-10-01",
        manifest: {
          mainModule: "client.js",
          modules: {
            "client.js": { type: "esm", contents: await clientArtifact.text() },
          },
        },
        env: { KANNIN: { type: "worker", worker: "raio", exportName: "KanninRpc" } },
      },
    },
  ],
});
await using cleanup = new AsyncDisposableStack();
cleanup.defer(() => worker.dispose());
const client = await worker.getWorker("quality-client");
const call = (command: typeof RpcCommand.Type) =>
  client.fetch("https://quality.internal", {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(RpcCommand))(command),
  });
const known = new Set<string>();
const batch: Array<typeof Document.Type> = [];
const corpus = createReadStream(corpusPath);
const rows = createInterface({ input: corpus, crlfDelay: Infinity });
await using corpusCleanup = new AsyncDisposableStack();
corpusCleanup.defer(() => {
  rows.close();
  corpus.destroy();
});
for await (const line of rows) {
  const document = Schema.decodeSync(Schema.fromJsonString(externalDocument))(line);
  if (known.has(document.id)) throw new Error("Duplicate corpus identifier");
  known.add(document.id);
  batch.push({ id: document.id, title: document.title, text: document.text, attributes: {} });
  if (batch.length === 500) {
    const response = await call({
      namespace: "quality",
      operation: "write",
      input: write(batch.splice(0)),
    });
    if (!response.ok)
      throw new Error(`Corpus ingestion failed: ${response.status} ${await response.text()}`);
    await response.arrayBuffer();
    console.error(`Indexed ${known.size} documents`);
  }
}
if (batch.length > 0) {
  const response = await call({ namespace: "quality", operation: "write", input: write(batch) });
  if (!response.ok)
    throw new Error(`Corpus ingestion failed: ${response.status} ${await response.text()}`);
  await response.arrayBuffer();
}
const missingJudgments = [...judgments.values()].reduce(
  (sum, relevance) => sum + [...relevance.keys()].filter((id) => !known.has(id)).length,
  0,
);
for (const _attempt of Array.from({ length: Math.ceil(known.size / 500) }, (_, index) => index)) {
  const response = await call({ namespace: "quality", operation: "compact" });
  if (!response.ok)
    throw new Error(`Corpus compaction failed: ${response.status} ${await response.text()}`);
  const result = Schema.decodeUnknownSync(CompactResult)(await response.json());
  if (result.compacted < 2) break;
}
const metadata = Schema.decodeUnknownSync(Metadata)(
  await (await call({ namespace: "quality", operation: "metadata" })).json(),
);
if (metadata.documents !== known.size) throw new Error("Compaction changed corpus cardinality");
console.error(`Evaluating ${judgments.size} queries over ${metadata.segments} compacted segments`);
const progress = { completed: 0, retries: 0 };
const evaluated = await Effect.runPromise(
  Effect.forEach(
    judgments,
    ([id, relevance]) =>
      Effect.gen(function* () {
        const text = queries.get(id);
        if (text === undefined) return yield* Effect.die("Missing judged query");
        const response = yield* Effect.tryPromise(() =>
          call({
            namespace: "quality",
            operation: "query",
            input: {
              kind: "text",
              text,
              topK: 11,
              filters: [],
            },
          }),
        ).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              progress.retries += 1;
            }),
          ),
          Effect.retry({ times: 2 }),
        );
        if (!response.ok) {
          const body = yield* Effect.tryPromise(() => response.text());
          return yield* new Rejected({
            status: response.status,
            message: `Evaluation query ${id} failed: ${body}`,
          });
        }
        const result = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        const ids = yield* Effect.forEach(
          result.rows
            .filter((row) => !sameCanonicalId(row.id, id))
            .slice(0, 10)
            .map((row) => row.id),
          (rowId) => Schema.decodeUnknownEffect(Id)(rowId),
        );
        progress.completed += 1;
        if (progress.completed % 100 === 0)
          yield* Console.error(`Evaluated ${progress.completed}/${judgments.size} queries`);
        return { queryId: id, ...retrievalMetrics(ids, relevance), ids };
      }),
    { concurrency: 4 },
  ),
);
const measured = evaluated.reduce(
  (sum, result) => ({
    ndcg10: sum.ndcg10 + result.ndcg10,
    recall10: sum.recall10 + result.recall10,
    mrr10: sum.mrr10 + result.mrr10,
  }),
  { ndcg10: 0, recall10: 0, mrr10: 0 },
);
console.log(
  JSON.stringify(
    {
      dataset: `BEIR ${basename(directory)}`,
      split,
      runtime: "local-workerd-rust-wasm-r2",
      documents: known.size,
      segments: metadata.segments,
      queries: judgments.size,
      missingJudgments,
      transportRetries: progress.retries,
      corpusSha256: corpusHash.digest("hex"),
      queriesSha256: createHash("sha256").update(queryBytes).digest("hex"),
      judgmentsSha256: createHash("sha256").update(qrelBytes).digest("hex"),
      ndcg10: measured.ndcg10 / judgments.size,
      recall10: measured.recall10 / judgments.size,
      mrr10: measured.mrr10 / judgments.size,
      evaluated,
    },
    null,
    2,
  ),
);
