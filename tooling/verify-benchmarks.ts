import { Effect, Schema } from "effect";
import { BenchmarkReport, verifyBenchmarkReports } from "./benchmark-report";

const paths = Schema.decodeSync(Schema.Array(Schema.String).check(Schema.isMinLength(2)))(
  process.argv.slice(2),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const reports = [];
    for (const path of paths) {
      const text = yield* Effect.tryPromise(() => Bun.file(path).text());
      reports.push(yield* Schema.decodeEffect(Schema.fromJsonString(BenchmarkReport))(text));
    }
    return yield* verifyBenchmarkReports(reports);
  }),
);
console.log(JSON.stringify({ integrity: "verified", ...result }));
