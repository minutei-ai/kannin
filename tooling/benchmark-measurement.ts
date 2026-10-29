import { Schema } from "effect";
import { BenchmarkReport } from "./benchmark-report";

const duration = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const warmFields = {
  p50: duration,
  p95: duration,
  samples: Schema.Array(duration).check(Schema.isBetweenLength(50, 50)),
};
const validWarm = Schema.makeFilter(
  (value: { readonly samples: readonly number[]; readonly p50: number; readonly p95: number }) => {
    const ordered = value.samples.toSorted((left, right) => left - right);
    return (
      (value.p50 === ordered[24] && value.p95 === ordered[47]) ||
      "Warm percentiles differ from raw samples"
    );
  },
);
const warm = Schema.Struct(warmFields).check(validWarm);
const queryIdentity = BenchmarkReport.fields.reports.value;
const cold = Schema.Struct({
  repetition: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  readMs: duration,
});
const validCold = Schema.makeFilter(
  (values: readonly (typeof cold.Type)[]) =>
    values.every((value, index) => value.repetition === index) ||
    "Cold repetitions must be complete and ordered",
);
const workerdCold = Schema.Array(Schema.Struct({ ...cold.fields, startupMs: duration })).check(
  Schema.isBetweenLength(1, 20),
  validCold,
);
const containerCold = Schema.Array(Schema.Struct({ ...cold.fields, restartMs: duration })).check(
  Schema.isBetweenLength(1, 5),
  validCold,
);
const common = {
  ...BenchmarkReport.fields,
  bundleSha256: BenchmarkReport.fields.wasmSha256,
};
const cacheMode = Schema.Literals(["retained", "empty"]);
export const BenchmarkMeasurement = Schema.Union([
  Schema.Struct({
    ...common,
    runtime: Schema.Literal("local-workerd"),
    phase: Schema.optional(Schema.Never),
    resourceConditions: Schema.String.check(Schema.isMinLength(1)),
    reports: Schema.Array(
      Schema.Struct({ ...queryIdentity.fields, ...warmFields }).check(validWarm),
    ),
  }),
  Schema.Struct({
    ...common,
    runtime: Schema.Literal("local-workerd"),
    cacheMode,
    phase: Schema.String.check(Schema.isMinLength(1)),
    resourceConditions: Schema.String.check(Schema.isMinLength(1)),
    reports: Schema.Array(
      Schema.Struct({
        ...queryIdentity.fields,
        samples: workerdCold,
      }),
    ),
  }),
  Schema.Struct({
    ...common,
    runtime: Schema.Literal("docker-engine-bun-s3-varnish"),
    phase: Schema.String.check(Schema.isMinLength(1)),
    cacheMode,
    configuredResourceLimits: Schema.Struct({
      api: Schema.String,
      s3: Schema.String,
      cdn: Schema.String,
    }),
    reports: Schema.Array(
      Schema.Struct({
        ...queryIdentity.fields,
        cold: containerCold,
        warm,
      }),
    ),
  }),
]);

export const benchmarkMeasurement = (coldSamples: number) =>
  BenchmarkMeasurement.check(
    Schema.makeFilter((report) => {
      if (report.runtime === "docker-engine-bun-s3-varnish")
        return (
          report.reports.every((query) => query.cold.length === coldSamples) ||
          "Container cold sample count differs from the requested run"
        );
      if ("cacheMode" in report)
        return (
          report.reports.every((query) => query.samples.length === coldSamples) ||
          "Workerd cold sample count differs from the requested run"
        );
      return true;
    }),
  );
