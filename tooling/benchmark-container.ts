import { availableParallelism, cpus } from "node:os";
import { Effect, Layer, Schema } from "effect";
import {
  portableApiImage,
  portableApiToken,
  startPortableApiContainer,
} from "../tests/api-container-fixture";
import { portableCacheImage, startPortableCacheContainer } from "../tests/cache-container-fixture";
import { ObjectStoreFixtureConfig, objectStoreFixtureLive } from "../tests/object-store-fixture";
import { benchmarkHttpApi } from "./benchmark-http";

const documents = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 10000 })),
)(Number(process.env.RAIO_BENCH_DOCUMENTS ?? 1000));
const coldSamples = Schema.decodeSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
)(Number(process.env.RAIO_BENCH_COLD_SAMPLES ?? 3));
const cacheMode = Schema.decodeUnknownSync(Schema.Literals(["retained", "empty"]))(
  process.env.RAIO_BENCH_CACHE_MODE ?? "retained",
);
const cacheConditions = {
  retained:
    "API restarted per cold sample; Varnish process and cache retained; canonical S3 and derived objects retained; OS/backend caches uncontrolled",
  empty:
    "API and Varnish restarted per cold sample; CDN tmpfs empty; canonical S3 and derived objects retained; OS/backend caches uncontrolled",
};

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const { image, loaded } = yield* portableApiImage;
      const cacheImage = yield* portableCacheImage;
      const context = yield* Layer.build(objectStoreFixtureLive);
      const storage = yield* ObjectStoreFixtureConfig.pipe(Effect.provideContext(context));
      const cache = yield* startPortableCacheContainer(cacheImage);
      const api = yield* startPortableApiContainer("docker", image, storage, {
        endpoint: cache.endpoint,
        token: cache.token,
        timeoutMillis: 2000,
        maxEntryBytes: 8 * 1024 * 1024,
      });
      const restart = Effect.gen(function* () {
        if (cacheMode === "empty") yield* cache.restart;
        yield* api.restart;
      });
      const measured = yield* benchmarkHttpApi(
        { endpoint: api.endpoint, token: portableApiToken, documents, coldSamples },
        restart,
      ).pipe(Effect.timeout("120 seconds"));
      const bundleSha256 = yield* Effect.tryPromise(async () =>
        Bun.CryptoHasher.hash(
          "sha256",
          await Bun.file(new URL("../dist/server/main.js", import.meta.url)).arrayBuffer(),
          "hex",
        ),
      );
      const wasmSha256 = yield* Effect.tryPromise(async () =>
        Bun.CryptoHasher.hash(
          "sha256",
          await Bun.file(
            new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url),
          ).arrayBuffer(),
          "hex",
        ),
      );
      return {
        runtime: "docker-engine-bun-s3-varnish",
        phase:
          "first strong query after API restart, followed by five warmups and fifty warm reads",
        cacheMode,
        cacheConditions: cacheConditions[cacheMode],
        restartTiming:
          "restartMs includes graceful shutdown and readiness of selected services; it is separate from readMs",
        configuredResourceLimits: {
          api: "1 CPU / 512 MiB / no swap",
          s3: "1 CPU / 512 MiB / no swap / 256 MiB tmpfs",
          cdn: "0.5 CPU / 512 MiB / no swap / 64 MiB tmpfs",
        },
        cpu: cpus()[0]?.model,
        availableParallelism: availableParallelism(),
        bun: Bun.version,
        imageLayers: loaded.RootFS.Layers,
        bundleSha256,
        wasmSha256,
        ...measured,
        railwayComparison: "same application image target only; hosted Railway not measured",
        turbopufferComparison: "not measured",
      };
    }),
  ),
);
console.log(JSON.stringify(result, null, 2));
