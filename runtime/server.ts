import { Config, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect";
import { PortableServerConfig } from "../src/protocol";
import { sha256 } from "../src/hash";
import { s3ObjectStore } from "./s3-object-store";
import { storageConfig } from "./storage-config";
import { portableApplication } from "./application";
import { cdnCache, disabledCache } from "./cache/client";

export const serverConfig = Config.all({
  token: Config.Redacted("RAIO_API_TOKEN"),
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.Int("PORT").pipe(Config.withDefault(3000)),
  wasmPath: Config.String("KANNIN_WASM_PATH").pipe(
    Config.withDefault("./dist/wasm/raio_engine_bg.wasm"),
  ),
  objectStore: storageConfig,
  cache: Config.option(Config.String("KANNIN_CACHE_ENDPOINT")).pipe(
    Config.flatMap((endpoint) => {
      if (Option.isNone(endpoint)) return Config.succeed(undefined);
      return Config.all({
        endpoint: Config.succeed(endpoint.value),
        token: Config.Redacted("KANNIN_CACHE_TOKEN"),
        timeoutMillis: Config.Int("KANNIN_CACHE_TIMEOUT_MS").pipe(Config.withDefault(250)),
        maxEntryBytes: Config.succeed(8 * 1024 * 1024),
      });
    }),
  ),
});

export const servePortable = Effect.fn("kannin.servePortable")(function* (
  configuration: typeof PortableServerConfig.Type,
) {
  const config = yield* Schema.decodeEffect(PortableServerConfig)(configuration);
  const context = yield* Layer.build(s3ObjectStore(config.objectStore));
  const module = yield* Effect.tryPromise(async () =>
    WebAssembly.compile(await Bun.file(config.wasmPath).arrayBuffer()),
  );
  const scope = yield* Effect.tryPromise(() =>
    sha256(`${config.objectStore.endpoint}\0${config.objectStore.bucket}`),
  );
  const cache = yield* Effect.gen(function* () {
    if (config.cache === undefined) return disabledCache;
    return yield* cdnCache(config.cache, scope);
  });
  const app = yield* portableApplication({
    cache,
    token: Redacted.value(config.token),
    scope,
    module,
  }).pipe(Effect.provideContext(context));
  yield* Effect.tryPromise(app.recover).pipe(
    Effect.catch((cause) => Effect.logError("kannin.recovery", cause)),
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.delay("30 seconds"),
    Effect.forkScoped,
  );
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: config.host,
        port: config.port,
        maxRequestBodySize: 1_900_000,
        idleTimeout: 60,
        fetch: app.fetch,
      }),
    ),
    (owned) => Effect.promise(() => owned.stop()),
  );
  yield* Effect.logInfo("kannin.listening", {
    port: server.port,
    host: config.host,
    engine: "rust-wasm-object-storage",
    vectors: "rust-wasm-object-storage",
  });
  return { server, app };
});
