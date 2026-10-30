import { Effect, Schema } from "effect";
import { verifyBenchmarkReports } from "./benchmark-report";
import { benchmarkMeasurement } from "./benchmark-measurement";

const paths = Schema.decodeSync(Schema.Array(Schema.String).check(Schema.isMinLength(2)))(
  process.argv.slice(2),
);
const coldSamples = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
)(Number(process.env.RAIO_BENCH_COLD_SAMPLES ?? 3));
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const reports = [];
    for (const path of paths) {
      const text = yield* Effect.tryPromise(() => Bun.file(path).text());
      reports.push(
        yield* Schema.decodeEffect(Schema.fromJsonString(benchmarkMeasurement(coldSamples)))(text),
      );
    }
    return yield* verifyBenchmarkReports(reports);
  }),
);
console.log(JSON.stringify({ integrity: "verified", ...result }));
