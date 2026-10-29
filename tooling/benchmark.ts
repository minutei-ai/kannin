import { createHash } from "node:crypto";
import { availableParallelism, cpus } from "node:os";
import { Schema } from "effect";
import { Query, QueryResult, Health, Row } from "../src/protocol";
import { request, startWorker, write } from "../tests/harness";
import { corpus } from "./corpus";
import { benchmarkQueries } from "./benchmark-queries";

const size = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1000000 })),
)(Number(process.env.RAIO_BENCH_DOCUMENTS ?? 10000));
const worker = await startWorker();
await using cleanup = new AsyncDisposableStack();
cleanup.defer(() => worker.dispose());
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
const ingestion = performance.now();
const corpusHash = createHash("sha256");
for (const offset of Array.from({ length: Math.ceil(size / 500) }, (_, ordinal) => ordinal * 500)) {
  const documents = corpus(offset, size);
  corpusHash.update(JSON.stringify(documents));
  const response = await request(worker, "benchmark", "write", write(documents));
  if (!response.ok)
    throw new Error(`Ingestion failed: ${response.status} ${await response.text()}`);
}
const ingestMs = performance.now() - ingestion;
const reports = [];
const baselines = new Map<string, string>();
const encodeQuery = Schema.encodeSync(Schema.fromJsonString(Query));

for (const consistency of ["strong", "edge-eventual"] as const)
  for (const [name, selected] of benchmarkQueries) {
    const query = { ...selected, consistency, minimumSequence: Math.ceil(size / 500) };
    for (const _warmup of Array.from({ length: 5 }, (_, ordinal) => ordinal)) {
      const response = await request(worker, "benchmark", "query", query);
      if (!response.ok) throw new Error(`Warmup failed ${response.status}`);
      await response.arrayBuffer();
    }
    const samples = [];
    for (const _iteration of Array.from({ length: 50 }, (_, ordinal) => ordinal)) {
      const start = performance.now();
      const response = await request(worker, "benchmark", "query", query);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      if (result.rows.length === 0) throw new Error("Empty benchmark result");
      if (result.consistency !== consistency)
        throw new Error("Benchmark consistency differs from requested contract");
      const elapsed = performance.now() - start;
      if (result.sequence !== Math.ceil(size / 500))
        throw new Error("Benchmark sequence differs from acknowledged ingestion");
      const encodedRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Row)))(result.rows);
      const expected = baselines.get(name);
      if (expected === undefined) baselines.set(name, encodedRows);
      else if (expected !== encodedRows)
        throw new Error("Benchmark ranking changed across requests or consistency modes");
      samples.push(elapsed);
    }
    const baseline = baselines.get(name);
    if (baseline === undefined) throw new Error("Missing verified benchmark rows");
    const ordered = [...samples].sort((a, b) => a - b);
    reports.push({
      name,
      consistency,
      querySha256: Bun.CryptoHasher.hash("sha256", encodeQuery(query), "hex"),
      rowsSha256: Bun.CryptoHasher.hash("sha256", baseline, "hex"),
      p50: ordered[24],
      p95: ordered[47],
      p99: ordered[49],
      samples,
    });
  }
const health = Schema.decodeUnknownSync(Health)(
  await (await fetch(new URL("/health", await worker.ready))).json(),
);
await cleanup.disposeAsync();
console.log(
  JSON.stringify(
    {
      runtime: "local-workerd",
      cpu: cpus()[0]?.model,
      availableParallelism: availableParallelism(),
      bun: Bun.version,
      bundleSha256,
      wasmSha256,
      documents: size,
      corpusSha256: corpusHash.digest("hex"),
      resultCheck:
        "identical rows and scores across requests and consistency modes; acknowledged sequence verified",
      ingestMs,
      documentsPerSecond: (size / ingestMs) * 1000,
      reports,
      health,
      turbopufferComparison: "not measured",
    },
    null,
    2,
  ),
);
