import { expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { BenchmarkReport, verifyBenchmarkReports } from "../tooling/benchmark-report";
import { benchmarkQueries } from "../tooling/benchmark-queries";

const baseline = Schema.decodeSync(BenchmarkReport)({
  documents: 1000,
  sequence: 2,
  corpusSha256: "a".repeat(64),
  wasmSha256: "b".repeat(64),
  reports: benchmarkQueries.map(([name]) => ({
    name,
    consistency: "strong" as const,
    querySha256: "c".repeat(64),
    rowsSha256: "d".repeat(64),
  })),
});

test("benchmark integrity accepts the complete same workload regardless of report order", async () => {
  expect(
    await Effect.runPromise(
      verifyBenchmarkReports([baseline, { ...baseline, reports: baseline.reports.toReversed() }]),
    ),
  ).toEqual({ reports: 2, strongQueries: benchmarkQueries.length });
});

test("benchmark integrity rejects changed state, queries, scores and incomplete workloads", async () => {
  for (const changed of [
    { ...baseline, documents: 1500 },
    { ...baseline, sequence: 3 },
    { ...baseline, corpusSha256: "e".repeat(64) },
    { ...baseline, wasmSha256: "e".repeat(64) },
    { ...baseline, reports: baseline.reports.slice(1) },
    { ...baseline, reports: [...baseline.reports, ...baseline.reports] },
    {
      ...baseline,
      reports: baseline.reports.map((query) => ({ ...query, querySha256: "e".repeat(64) })),
    },
    {
      ...baseline,
      reports: baseline.reports.map((query) => ({ ...query, rowsSha256: "e".repeat(64) })),
    },
  ])
    expect(
      Exit.isFailure(await Effect.runPromiseExit(verifyBenchmarkReports([baseline, changed]))),
    ).toBe(true);
  expect(Exit.isFailure(await Effect.runPromiseExit(verifyBenchmarkReports([baseline])))).toBe(
    true,
  );
  expect(Exit.isFailure(await Effect.runPromiseExit(verifyBenchmarkReports([])))).toBe(true);
});
