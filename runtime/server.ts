import { Config, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { PortableServerConfig } from "../src/protocol";
import { sha256 } from "../src/hash";
import { s3ObjectStore } from "./s3-object-store";
import { qdrantVectorStore } from "./qdrant-vector-store";
import { portableApplication } from "./application";

export const serverConfig = Config.all({
  token: Config.Redacted("RAIO_API_TOKEN"),
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.Int("PORT").pipe(Config.withDefault(3000)),
  wasmPath: Config.String("KANNIN_WASM_PATH").pipe(
    Config.withDefault("./dist/wasm/raio_engine_bg.wasm"),
  ),
  objectStore: Config.all({
    bucket: Config.String("KANNIN_STORAGE_BUCKET"),
    endpoint: Config.String("KANNIN_STORAGE_ENDPOINT"),
    region: Config.String("KANNIN_STORAGE_REGION").pipe(Config.withDefault("us-east-1")),
    accessKeyId: Config.Redacted("KANNIN_STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: Config.Redacted("KANNIN_STORAGE_SECRET_ACCESS_KEY"),
  }),
  vectorStore: Config.all({
    endpoint: Config.String("KANNIN_VECTOR_ENDPOINT"),
    collection: Config.String("KANNIN_VECTOR_COLLECTION").pipe(
      Config.withDefault("kannin_vectors"),
    ),
    dimensions: Config.succeed(768),
    apiKey: Config.Redacted("KANNIN_VECTOR_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
  }),
});

export const servePortable = Effect.fn("kannin.servePortable")(function* (
  configuration: typeof PortableServerConfig.Type,
) {
  const config = yield* Schema.decodeEffect(PortableServerConfig)(configuration);
  const context = yield* Layer.build(
    Layer.merge(s3ObjectStore(config.objectStore), qdrantVectorStore(config.vectorStore)),
  );
  const module = yield* Effect.tryPromise(async () =>
    WebAssembly.compile(await Bun.file(config.wasmPath).arrayBuffer()),
  );
  const scope = yield* Effect.tryPromise(() =>
    sha256(`${config.objectStore.endpoint}\0${config.objectStore.bucket}`),
  );
  const app = yield* portableApplication({
    token: Redacted.value(config.token),
    scope,
    module,
  }).pipe(Effect.provideContext(context));
  yield* Effect.tryPromise(app.recover).pipe(
    Effect.catch((cause) => Effect.logError("kannin.recovery", cause)),
    Effect.repeat(Schedule.spaced("30 seconds")),
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
    vectors: "qdrant",
  });
  return { server, app };
});
