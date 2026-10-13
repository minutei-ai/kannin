import { Config, Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Document, Id, QueryResult } from "../src/protocol";
import { request, startWorker, textQuery, write } from "../tests/harness";

const directory = Effect.runSync(Config.String("RAIO_EVAL_DIRECTORY"));
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
const corpusBytes = await Bun.file(join(directory, "corpus.jsonl")).text();
const queryBytes = await Bun.file(join(directory, "queries.jsonl")).text();
const qrelBytes = await Bun.file(join(directory, "qrels/test.tsv")).text();
const documents = corpusBytes
  .trim()
  .split("\n")
  .map((line) => Schema.decodeSync(Schema.fromJsonString(externalDocument))(line));
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
const known = new Set(documents.map((document) => document.id));
const qrelLines = qrelBytes.trim().split("\n");
if (qrelLines[0] !== "query-id\tcorpus-id\tscore") throw new Error("Invalid judgment header");
for (const line of qrelLines.slice(1)) {
  const [query, document, relevance] = Schema.decodeUnknownSync(judgment)(line.split("\t"));
  if (!known.has(document) || !queries.has(query))
    throw new Error("Judgment references an unknown record");
  const values = judgments.get(query) ?? new Map<string, number>();
  values.set(document, relevance);
  judgments.set(query, values);
}
if (judgments.size === 0) throw new Error("No judged queries");
const worker = await startWorker();
await using cleanup = new AsyncDisposableStack();
cleanup.defer(() => worker.dispose());
for (const offset of Array.from(
  { length: Math.ceil(documents.length / 500) },
  (_, index) => index * 500,
)) {
  const response = await request(
    worker,
    "quality-scifact",
    "write",
    write(
      documents.slice(offset, offset + 500).map((document) => ({
        id: document.id,
        title: document.title,
        text: document.text,
        attributes: {},
      })),
    ),
  );
  if (!response.ok)
    throw new Error(`Corpus ingestion failed: ${response.status} ${await response.text()}`);
  await response.arrayBuffer();
}
const measured = { ndcg10: 0, recall10: 0, mrr10: 0 };
const evaluated = [];
for (const [id, relevance] of judgments) {
  const text = queries.get(id);
  if (text === undefined) throw new Error("Missing judged query");
  const response = await request(worker, "quality-scifact", "query", textQuery(text, 10));
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  const scores = result.rows.map((row) => relevance.get(row.id) ?? 0);
  const ideal = [...relevance.values()].toSorted((a, b) => b - a).slice(0, 10);
  const denominator = ideal.reduce(
    (sum, score, index) => sum + (2 ** score - 1) / Math.log2(index + 2),
    0,
  );
  const gain = scores.reduce(
    (sum, score, index) => sum + (2 ** score - 1) / Math.log2(index + 2),
    0,
  );
  const relevant = [...relevance.values()].filter((score) => score > 0).length;
  const rank = scores.findIndex((score) => score > 0);
  const metrics = { ndcg10: 0, recall10: 0, mrr10: 0 };
  if (denominator > 0) metrics.ndcg10 = gain / denominator;
  if (relevant > 0) metrics.recall10 = scores.filter((score) => score > 0).length / relevant;
  if (rank >= 0) metrics.mrr10 = 1 / (rank + 1);
  measured.ndcg10 += metrics.ndcg10;
  measured.recall10 += metrics.recall10;
  measured.mrr10 += metrics.mrr10;
  evaluated.push({ queryId: id, ...metrics, ids: result.rows.map((row) => row.id) });
}
console.log(
  JSON.stringify(
    {
      dataset: "BEIR SciFact",
      split: "test",
      runtime: "local-workerd-rust-wasm-r2",
      documents: documents.length,
      queries: judgments.size,
      corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
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
