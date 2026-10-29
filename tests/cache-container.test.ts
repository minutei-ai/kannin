import { expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import { cdnCache } from "../runtime/cache/client";
import { portableCacheImage, startPortableCacheContainer } from "./cache-container-fixture";

test("official Varnish image implements CachePort and loses only cache data on restart", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const image = yield* portableCacheImage;
        const running = yield* startPortableCacheContainer(image);
        const provider = yield* cdnCache(
          {
            endpoint: running.endpoint,
            token: running.token,
            timeoutMillis: 2000,
            maxEntryBytes: 1024,
          },
          "container-bucket",
        );
        const cache = yield* Effect.promise(() => provider.open("raio-segments-v1"));
        const key = "https://segments.invalid/container-version";
        const put = () =>
          cache.put(
            key,
            new Response(new Uint8Array([255, 0, 12, 200]), {
              headers: { "cache-control": "public, max-age=60" },
            }),
          );
        yield* Effect.promise(put);
        for (const _attempt of [0, 1]) {
          const hit = yield* Effect.promise(() => cache.match(key));
          expect(hit).toBeDefined();
          if (hit === undefined)
            return yield* new Cause.UnknownError(
              new Error("Varnish failed to retain the warmed object"),
            );
          expect(new Uint8Array(yield* Effect.promise(() => hit.arrayBuffer()))).toEqual(
            new Uint8Array([255, 0, 12, 200]),
          );
        }
        expect(yield* Effect.promise(() => cache.delete(key))).toBe(true);
        expect(yield* Effect.promise(() => cache.match(key))).toBeUndefined();
        yield* Effect.promise(put);
        yield* running.restart;
        expect(yield* Effect.promise(() => cache.match(key))).toBeUndefined();
        yield* Effect.promise(put);
        expect(yield* Effect.promise(() => cache.match(key))).toBeDefined();
        return undefined;
      }),
    ),
  );
}, 180000);
