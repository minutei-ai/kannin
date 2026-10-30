import { Effect, Exit } from "effect";
import { servePortable, serverConfig } from "./server";

const exit = await Effect.runPromiseExit(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* serverConfig;
      yield* servePortable(config);
      yield* Effect.callback<void>((resume) => {
        const shutdown = () => resume(Effect.void);
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
        return Effect.sync(() => {
          process.removeListener("SIGTERM", shutdown);
          process.removeListener("SIGINT", shutdown);
        });
      });
    }),
  ).pipe(Effect.tapCause((cause) => Effect.logError("kannin.startup", cause))),
);
if (Exit.isFailure(exit)) process.exitCode = 1;
