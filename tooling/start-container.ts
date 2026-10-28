import { Cause, Config, Effect, Exit } from "effect";

const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const binary = yield* Config.String("DOCKER_BIN").pipe(Config.withDefault("docker"));
    const id = yield* Config.String("KANNIN_OWNED_CONTAINER_ID");
    for (const args of [
      [
        "update",
        "--cpus",
        "0.5",
        "--memory",
        "512m",
        "--memory-swap",
        "512m",
        "--pids-limit",
        "128",
        id,
      ],
      ["start", id],
    ]) {
      const child = yield* Effect.sync(() =>
        Bun.spawn([binary, ...args], { stdout: "inherit", stderr: "inherit" }),
      );
      const code = yield* Effect.promise(() => child.exited);
      if (code !== 0)
        return yield* new Cause.UnknownError(
          new Error(`Owned container operation failed with code ${code}`),
        );
    }
    return undefined;
  }),
);
if (Exit.isFailure(exit)) process.exitCode = 1;
