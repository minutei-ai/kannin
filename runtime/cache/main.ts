import { Config, Effect, Exit, Schedule } from "effect";
import { CacheFailure } from "../../src/protocol";
import { cacheGateway } from "./gateway";

const exit = await Effect.runPromiseExit(
  Effect.scoped(
    Effect.gen(function* () {
      const token = yield* Config.Redacted("KANNIN_CACHE_TOKEN");
      const port = yield* Config.Int("PORT").pipe(Config.withDefault(3000));
      const gateway = yield* cacheGateway({
        token,
        port,
        host: "0.0.0.0",
        edgeEndpoint: "http://127.0.0.1:6081",
        maxEntries: 4096,
        maxMetadataBytes: 8 * 1024 * 1024,
        maxStagingBytes: 32 * 1024 * 1024,
        maxEntryBytes: 8 * 1024 * 1024,
        maxTtlSeconds: 86400,
      });
      const origin = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 6082, fetch: gateway.origin })),
        (server) => Effect.promise(() => server.stop(true)),
      );
      const varnish = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(
            [
              "varnishd",
              "-F",
              "-n",
              "/var/lib/varnish/varnishd",
              "-a",
              "127.0.0.1:6081",
              "-T",
              "none",
              "-f",
              "/etc/varnish/default.vcl",
              "-s",
              "malloc,64m",
              "-p",
              "vsl_space=16m",
              "-p",
              "thread_pool_min=10",
              "-p",
              "thread_pool_max=50",
              "-p",
              "thread_pools=1",
              "-p",
              "workspace_client=64k",
              "-p",
              "default_grace=0",
              "-p",
              "default_keep=0",
              "-p",
              "http_gzip_support=off",
            ],
            {
              stdout: "inherit",
              stderr: "inherit",
              env: {
                PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                VARNISH_VSM_NOPID: "1",
              },
            },
          ),
        ),
        (child) =>
          Effect.promise(async () => {
            child.kill("SIGTERM");
            await child.exited;
          }),
      );
      const died = Effect.tryPromise(() => varnish.exited).pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            new CacheFailure({
              operation: "initialize",
              cause: new Error(`Varnish exited with code ${code}`),
            }),
          ),
        ),
      );
      yield* Effect.tryPromise(async () => {
        const response = await fetch(`http://127.0.0.1:6081/health`);
        await response.arrayBuffer();
        if (response.status !== 404) throw new Error("Unexpected cache origin health response");
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
        Effect.raceFirst(died),
      );
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "0.0.0.0",
            port,
            maxRequestBodySize: 8 * 1024 * 1024,
            fetch: gateway.fetch,
          }),
        ),
        (owned) => Effect.promise(() => owned.stop(true)),
      );
      yield* Effect.logInfo("kannin.cache.listening", { port: server.port, origin: origin.port });
      const shutdown = Effect.callback<void>((resume) => {
        const stop = () => resume(Effect.void);
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        return Effect.sync(() => {
          process.removeListener("SIGTERM", stop);
          process.removeListener("SIGINT", stop);
        });
      });
      yield* Effect.raceFirst(shutdown, died);
    }),
  ).pipe(Effect.tapCause((cause) => Effect.logError("kannin.cache.startup", cause))),
);
if (Exit.isFailure(exit)) process.exitCode = 1;
