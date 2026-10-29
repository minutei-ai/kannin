import { createHash } from "node:crypto";
import { Cause, Effect, Schema } from "effect";
import { Query, QueryResult, Row, Write, WriteResult } from "../src/protocol";
import { write } from "../tests/harness";
import { benchmarkQueries } from "./benchmark-queries";
import { corpus } from "./corpus";

export const HttpBenchmarkConfig = Schema.Struct({
  endpoint: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:\d+$/)),
  token: Schema.String.check(Schema.isMinLength(1)),
  documents: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1000000 })),
  coldSamples: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
});

const encodeQuery = Schema.encodeSync(Schema.fromJsonString(Query));
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Row)));
const encodeWrite = Schema.encodeSync(Schema.fromJsonString(Write));

const post = Effect.fn("kannin.benchmark.http")(function* (
  config: typeof HttpBenchmarkConfig.Type,
  operation: "write" | "query",
  body: string,
) {
  return yield* Effect.tryPromise(async () => {
    const response = await fetch(`${config.endpoint}/v1/namespaces/benchmark/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(`Benchmark ${operation} failed: ${response.status} ${await response.text()}`);
    return response.text();
  });
});

export function benchmarkHttpApi<E, R>(
  configuration: typeof HttpBenchmarkConfig.Type,
  restart: Effect.Effect<unknown, E, R>,
) {
  return Effect.gen(function* () {
    const config = yield* Schema.decodeEffect(HttpBenchmarkConfig)(configuration);
    const batches = Math.ceil(config.documents / 500);
    const corpusHash = createHash("sha256");
    const ingestion = performance.now();
    for (const ordinal of Array.from({ length: batches }, (_, index) => index)) {
      const documents = corpus(ordinal * 500, config.documents);
      corpusHash.update(JSON.stringify(documents));
      const input = Schema.decodeSync(Write)(write(documents));
      const encoded = yield* post(config, "write", encodeWrite(input));
      const acknowledged = yield* Schema.decodeEffect(Schema.fromJsonString(WriteResult))(encoded);
      if (acknowledged.sequence !== ordinal + 1 || acknowledged.requestId !== input.requestId)
        return yield* new Cause.UnknownError(
          new Error("Benchmark ingestion differs from the acknowledged write sequence"),
        );
    }
    const ingestMs = performance.now() - ingestion;
    const reports = [];
    for (const [name, selected] of benchmarkQueries) {
      const input = Schema.decodeUnknownSync(Query, { onExcessProperty: "error" })({
        ...selected,
        consistency: "strong",
        minimumSequence: batches,
      });
      const encodedQuery = encodeQuery(input);
      const baselines = new Set<string>();
      const query = Effect.gen(function* () {
        const started = performance.now();
        const encoded = yield* post(config, "query", encodedQuery);
        const result = yield* Schema.decodeEffect(Schema.fromJsonString(QueryResult))(encoded);
        const readMs = performance.now() - started;
        if (result.sequence !== batches || result.consistency !== "strong")
          return yield* new Cause.UnknownError(
            new Error("Benchmark query differs from the acknowledged strong snapshot"),
          );
        if (result.rows.length === 0)
          return yield* new Cause.UnknownError(new Error("Empty container benchmark result"));
        baselines.add(encodeRows(result.rows));
        if (baselines.size !== 1)
          return yield* new Cause.UnknownError(
            new Error("Container benchmark rows or scores changed"),
          );
        return readMs;
      });
      const cold = [];
      for (const repetition of Array.from({ length: config.coldSamples }, (_, index) => index)) {
        const starting = performance.now();
        yield* restart;
        const restartMs = performance.now() - starting;
        const readMs = yield* query;
        cold.push({ repetition, restartMs, readMs });
      }
      for (const _warmup of Array.from({ length: 5 }, (_, index) => index)) yield* query;
      const warm = [];
      for (const _iteration of Array.from({ length: 50 }, (_, index) => index))
        warm.push(yield* query);
      const baseline = baselines.values().next().value;
      if (baseline === undefined)
        return yield* new Cause.UnknownError(
          new Error("Missing verified container benchmark rows"),
        );
      const ordered = warm.toSorted((left, right) => left - right);
      reports.push({
        name,
        consistency: "strong",
        querySha256: Bun.CryptoHasher.hash("sha256", encodedQuery, "hex"),
        rowsSha256: Bun.CryptoHasher.hash("sha256", baseline, "hex"),
        cold,
        warm: { p50: ordered[24], p95: ordered[47], samples: warm },
      });
    }
    return {
      documents: config.documents,
      corpusSha256: corpusHash.digest("hex"),
      sequence: batches,
      ingestMs,
      resultCheck:
        "identical rows and scores across cold and warm strong reads; write acknowledgements verified",
      reports,
    };
  });
}
