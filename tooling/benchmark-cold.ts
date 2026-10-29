import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { QueryResult, Row } from "../src/protocol";
import { request, startWorker, write } from "../tests/harness";
import { benchmarkQueries } from "./benchmark-queries";
import { corpus } from "./corpus";

const size = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1000000 })),
)(Number(process.env.RAIO_BENCH_DOCUMENTS ?? 10000));
const repetitions = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
)(Number(process.env.RAIO_BENCH_COLD_SAMPLES ?? 5));
await using cleanup = new AsyncDisposableStack();
const persistence = await mkdtemp(join(tmpdir(), "kannin-process-cold-"));
cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Row)));
const corpusHash = createHash("sha256");
const batches = Math.ceil(size / 500);
const ingestion = performance.now();
await using ingestCleanup = new AsyncDisposableStack();
const ingestWorker = await startWorker(persistence);
ingestCleanup.defer(() => ingestWorker.dispose());
for (const offset of Array.from({ length: batches }, (_, ordinal) => ordinal * 500)) {
  const documents = corpus(offset, size);
  corpusHash.update(JSON.stringify(documents));
  const response = await request(ingestWorker, "benchmark", "write", write(documents));
  if (!response.ok)
    throw new Error(`Ingestion failed: ${response.status} ${await response.text()}`);
}
const ingestMs = performance.now() - ingestion;
await ingestCleanup.disposeAsync();

const reports = [];
for (const [name, selected] of benchmarkQueries) {
  const samples = [];
  const baselines = new Set<string>();
  for (const repetition of Array.from({ length: repetitions }, (_, ordinal) => ordinal)) {
    await using sampleCleanup = new AsyncDisposableStack();
    const starting = performance.now();
    const worker = await startWorker(persistence);
    sampleCleanup.defer(() => worker.dispose());
    const startupMs = performance.now() - starting;
    const started = performance.now();
    const response = await request(worker, "benchmark", "query", {
      ...selected,
      consistency: "strong",
      minimumSequence: batches,
    });
    if (!response.ok)
      throw new Error(`Cold query failed: ${response.status} ${await response.text()}`);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    const readMs = performance.now() - started;
    if (result.consistency !== "strong" || result.sequence !== batches)
      throw new Error("Cold query differs from the acknowledged strong-read snapshot");
    if (result.rows.length === 0) throw new Error("Empty cold benchmark result");
    baselines.add(encodeRows(result.rows));
    if (baselines.size !== 1) throw new Error("Cold query ranking changed across restarts");
    samples.push({ repetition, startupMs, readMs });
  }
  reports.push({ name, consistency: "strong", samples });
}
const bundleSha256 = Bun.CryptoHasher.hash(
  "sha256",
  await Bun.file(new URL("../dist/worker/worker.js", import.meta.url)).arrayBuffer(),
  "hex",
);
const wasmSha256 = Bun.CryptoHasher.hash(
  "sha256",
  await Bun.file(new URL("../dist/worker/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  "hex",
);
await cleanup.disposeAsync();
console.log(
  JSON.stringify(
    {
      runtime: "local-workerd",
      phase: "first strong query after a fresh workerd process per sample",
      cacheConditions:
        "canonical R2, derived objects and any persisted Cache API state retained; OS/backend caches uncontrolled; no host cache flush",
      queueConsumers: false,
      cpu: cpus()[0]?.model,
      availableParallelism: availableParallelism(),
      bun: Bun.version,
      documents: size,
      corpusSha256: corpusHash.digest("hex"),
      bundleSha256,
      wasmSha256,
      ingestMs,
      resultCheck:
        "identical rows and scores across process restarts; acknowledged sequence verified",
      reports,
      dockerComparison: "not measured",
      railwayComparison: "not measured",
      turbopufferComparison: "not measured",
    },
    null,
    2,
  ),
);
