import { Cause, Effect, Schema } from "effect";
import { benchmarkQueries } from "./benchmark-queries";

const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const BenchmarkReport = Schema.Struct({
  documents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  corpusSha256: sha256,
  wasmSha256: sha256,
  reports: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      consistency: Schema.Literals(["strong", "edge-eventual"]),
      querySha256: sha256,
      rowsSha256: sha256,
    }),
  ),
});

export const verifyBenchmarkReports = Effect.fn("kannin.benchmark.verify")(function* (
  input: readonly (typeof BenchmarkReport.Type)[],
) {
  const reports = yield* Schema.decodeEffect(Schema.Array(BenchmarkReport))(input);
  if (reports.length < 2)
    return yield* new Cause.UnknownError(new Error("At least two benchmark reports are required"));
  const baseline = reports[0];
  if (baseline === undefined)
    return yield* new Cause.UnknownError(new Error("Missing benchmark baseline"));
  const expectedNames = benchmarkQueries.map(([name]) => name).toSorted();
  const baselineQueries = new Map(
    baseline.reports
      .filter((query) => query.consistency === "strong")
      .map((query) => [query.name, query]),
  );
  for (const report of reports) {
    for (const field of ["documents", "sequence", "corpusSha256", "wasmSha256"] as const)
      if (report[field] !== baseline[field])
        return yield* new Cause.UnknownError(new Error(`Benchmark mismatch: ${field}`));
    const queries = report.reports.filter((query) => query.consistency === "strong");
    const names = queries.map((query) => query.name).toSorted();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames))
      return yield* new Cause.UnknownError(
        new Error("Missing or duplicate strong benchmark queries"),
      );
    for (const query of queries) {
      const expected = baselineQueries.get(query.name);
      if (expected === undefined || expected.querySha256 !== query.querySha256)
        return yield* new Cause.UnknownError(new Error(`Benchmark query mismatch: ${query.name}`));
      if (expected.rowsSha256 !== query.rowsSha256)
        return yield* new Cause.UnknownError(
          new Error(`Benchmark rows or scores mismatch: ${query.name}`),
        );
    }
  }
  return { reports: reports.length, strongQueries: expectedNames.length };
});
