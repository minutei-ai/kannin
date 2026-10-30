import { Cause, Config, Effect, Exit } from "effect";

const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const port = yield* Config.Int("PORT").pipe(Config.withDefault(3000));
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/health`));
    yield* Effect.tryPromise(() => response.arrayBuffer());
    if (!response.ok) return yield* new Cause.UnknownError(new Error("API is not healthy"));
    return undefined;
  }).pipe(Effect.timeout("5 seconds")),
);
if (Exit.isFailure(exit)) process.exitCode = 1;
