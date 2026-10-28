import { expect, test } from "bun:test";
import { Cause, Effect, Redacted, Schedule } from "effect";
import { cdnCache } from "../runtime/cache/client";
import { containerCommand } from "./container-command";

const image = `localhost/kannin-cache-contract:${crypto.randomUUID()}`;

test("official Varnish image implements CachePort and loses only cache data on restart", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          containerCommand([
            "podman",
            "build",
            "--memory=512m",
            "--memory-swap=512m",
            "--cpu-period=100000",
            "--cpu-quota=50000",
            "--file",
            "Dockerfile.cache",
            "--tag",
            image,
            ".",
          ]),
          () => containerCommand(["podman", "image", "rm", image]).pipe(Effect.orDie),
        );
        const id = yield* Effect.acquireRelease(
          containerCommand([
            "podman",
            "run",
            "--timeout=180",
            "--detach",
            "--memory=512m",
            "--memory-swap=512m",
            "--cpus=0.5",
            "--pids-limit=128",
            "--tmpfs=/var/lib/varnish/varnishd:rw,exec,size=64m,mode=1777",
            "--publish=127.0.0.1::3000",
            "--env=KANNIN_CACHE_TOKEN=container-cache-secret",
            image,
          ]),
          (owned) =>
            containerCommand(["podman", "rm", "--force", "--time", "10", owned]).pipe(Effect.orDie),
        );
        const address = yield* containerCommand(["podman", "port", id, "3000/tcp"]);
        const endpoint = `http://${address}`;
        const ready = Effect.tryPromise(async () => {
          const response = await fetch(`${endpoint}/health`);
          await response.arrayBuffer();
          if (!response.ok) throw new Error("CDN is not ready");
        }).pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }));
        yield* ready.pipe(
          Effect.tapError(() =>
            containerCommand(["podman", "logs", id]).pipe(
              Effect.flatMap((logs) => new Cause.UnknownError(new Error(logs))),
            ),
          ),
        );
        const provider = yield* cdnCache(
          {
            endpoint,
            token: Redacted.make("container-cache-secret"),
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
        yield* containerCommand(["podman", "restart", "--time", "10", id]);
        yield* ready;
        expect(yield* Effect.promise(() => cache.match(key))).toBeUndefined();
        yield* Effect.promise(put);
        expect(yield* Effect.promise(() => cache.match(key))).toBeDefined();
        return undefined;
      }),
    ),
  );
}, 180000);
