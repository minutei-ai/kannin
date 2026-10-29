import { expect, test } from "bun:test";
import { Exit, Schema } from "effect";
import { benchmarkMeasurement } from "../tooling/benchmark-measurement";

const identity = {
  name: "rare",
  consistency: "strong",
  querySha256: "c".repeat(64),
  rowsSha256: "d".repeat(64),
};
const common = {
  documents: 1000,
  sequence: 2,
  corpusSha256: "a".repeat(64),
  wasmSha256: "b".repeat(64),
  bundleSha256: "e".repeat(64),
  runtime: "local-workerd",
  resourceConditions: "runner limits",
};
const warm = {
  ...identity,
  p50: 25,
  p95: 48,
  samples: Array.from({ length: 50 }, (_, index) => index + 1),
};
const cold = {
  ...identity,
  samples: Array.from({ length: 3 }, (_, repetition) => ({ repetition, startupMs: 2, readMs: 1 })),
};
const decode = Schema.decodeExit(Schema.fromJsonString(benchmarkMeasurement(3)));

test("measurement validation accepts complete warm and requested cold samples", () => {
  expect(Exit.isSuccess(decode(JSON.stringify({ ...common, reports: [warm] })))).toBe(true);
  expect(
    Exit.isSuccess(
      decode(JSON.stringify({ ...common, phase: "cold", cacheMode: "retained", reports: [cold] })),
    ),
  ).toBe(true);
});

test("measurement validation rejects missing samples, invalid timings and fabricated percentiles", () => {
  for (const invalid of [
    { ...warm, samples: [] },
    { ...warm, samples: warm.samples.slice(1) },
    { ...warm, p95: 999 },
    { ...warm, samples: warm.samples.map(() => -1) },
    { ...identity },
  ])
    expect(Exit.isFailure(decode(JSON.stringify({ ...common, reports: [invalid] })))).toBe(true);
  for (const invalid of [
    { ...cold, samples: [] },
    { ...cold, samples: cold.samples.slice(1) },
    { ...cold, samples: cold.samples.map((sample) => ({ ...sample, repetition: 0 })) },
    { ...cold, samples: cold.samples.map((sample) => ({ ...sample, startupMs: -1 })) },
    warm,
  ])
    expect(
      Exit.isFailure(
        decode(
          JSON.stringify({ ...common, phase: "cold", cacheMode: "empty", reports: [invalid] }),
        ),
      ),
    ).toBe(true);
});

test("container measurements require both restart samples and complete warm statistics", () => {
  const report = {
    ...common,
    runtime: "docker-engine-bun-s3-varnish",
    phase: "cold then warm",
    cacheMode: "retained",
    configuredResourceLimits: { api: "1 CPU", s3: "1 CPU", cdn: "0.5 CPU" },
  };
  const query = {
    ...identity,
    cold: cold.samples.map((sample) => ({
      repetition: sample.repetition,
      readMs: sample.readMs,
      restartMs: 2,
    })),
    warm,
  };
  expect(Exit.isSuccess(decode(JSON.stringify({ ...report, reports: [query] })))).toBe(true);
  for (const invalid of [
    { ...query, cold: query.cold.slice(1) },
    { ...query, warm: { ...warm, p50: 999 } },
    { ...identity },
  ])
    expect(Exit.isFailure(decode(JSON.stringify({ ...report, reports: [invalid] })))).toBe(true);
});
