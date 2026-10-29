import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { s3ObjectStore } from "../runtime/s3-object-store";
import { storageConfig } from "../runtime/storage-config";
import { S3StoreConfig } from "../src/protocol";
import { checkObjectStore } from "./object-store-conformance";

const stopped: { signal: "SIGINT" | "SIGTERM" | undefined } = { signal: undefined };
const shutdown = Effect.callback<void>((resume) => {
  const interrupt = () => {
    stopped.signal = "SIGINT";
    resume(Effect.void);
  };
  const terminate = () => {
    stopped.signal = "SIGTERM";
    resume(Effect.void);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  return Effect.sync(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  });
});
const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* storageConfig;
    const checked = yield* Schema.decodeEffect(S3StoreConfig)(config);
    const context = yield* Layer.build(s3ObjectStore(checked));
    return yield* checkObjectStore().pipe(Effect.provideContext(context));
  }),
);
const exit = await Effect.runPromiseExit(Effect.raceFirst(program, shutdown));
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exitCode = 1;
} else if (stopped.signal === "SIGINT") process.exitCode = 130;
else if (stopped.signal === "SIGTERM") process.exitCode = 143;
else if (exit.value !== undefined)
  console.log(JSON.stringify({ integrity: "verified", ...exit.value }));
