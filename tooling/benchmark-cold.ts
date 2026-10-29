import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Query, QueryResult, Row } from "../src/protocol";
import { request, startWorker, write } from "../tests/harness";
import { benchmarkQueries } from "./benchmark-queries";
import { corpus } from "./corpus";

const size = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1000000 })),
)(Number(process.env.RAIO_BENCH_DOCUMENTS ?? 10000));
const repetitions = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
)(Number(process.env.RAIO_BENCH_COLD_SAMPLES ?? 5));
const cacheMode = Schema.decodeUnknownSync(Schema.Literals(["retained", "empty"]))(
  process.env.RAIO_BENCH_CACHE_MODE ?? "retained",
);
const cacheConditions = {
  retained:
    "canonical R2, derived objects and any persisted Cache API state retained; OS/backend caches uncontrolled; no host cache flush",
  empty:
    "fresh Cache API and coordination state per sample; canonical R2 and derived objects retained through an R2-only symlink; OS/backend caches uncontrolled; no host cache flush",
};
await using cleanup = new AsyncDisposableStack();
const persistence = await mkdtemp(join(tmpdir(), "kannin-process-cold-"));
cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Row)));
const encodeQuery = Schema.encodeSync(Schema.fromJsonString(Query));
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
  const input = Schema.decodeUnknownSync(Query, { onExcessProperty: "error" })({
    ...selected,
    consistency: "strong",
    minimumSequence: batches,
  });
  const samples = [];
  const baselines = new Set<string>();
  for (const repetition of Array.from({ length: repetitions }, (_, ordinal) => ordinal)) {
    await using sampleCleanup = new AsyncDisposableStack();
    const samplePersistence = { path: persistence };
    if (cacheMode === "empty") {
      const isolated = await mkdtemp(join(tmpdir(), "kannin-cache-cold-"));
      sampleCleanup.defer(() => rm(isolated, { recursive: true, force: true }));
      await symlink(join(persistence, "r2"), join(isolated, "r2"), "dir");
      samplePersistence.path = isolated;
    }
    const starting = performance.now();
    const worker = await startWorker(samplePersistence.path);
    sampleCleanup.defer(() => worker.dispose());
    const startupMs = performance.now() - starting;
    const started = performance.now();
    const response = await request(worker, "benchmark", "query", input);
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
  const baseline = baselines.values().next().value;
  if (baseline === undefined) throw new Error("Missing verified cold benchmark rows");
  reports.push({
    name,
    consistency: "strong",
    querySha256: Bun.CryptoHasher.hash("sha256", encodeQuery(input), "hex"),
    rowsSha256: Bun.CryptoHasher.hash("sha256", baseline, "hex"),
    samples,
  });
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
      cacheMode,
      cacheConditions: cacheConditions[cacheMode],
      queueConsumers: false,
      cpu: cpus()[0]?.model,
      availableParallelism: availableParallelism(),
      resourceConditions:
        "workerd and R2 emulator inherit runner limits; no per-service CPU or memory cap; resource equivalence with containers not established",
      bun: Bun.version,
      documents: size,
      sequence: Math.ceil(size / 500),
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
