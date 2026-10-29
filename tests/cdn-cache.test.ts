import { expect, test } from "bun:test";
import { Clock, Effect, Redacted, Schema } from "effect";
import { CacheServerConfig } from "../src/protocol";
import { cacheState } from "../runtime/cache/state";
import { cacheGateway } from "../runtime/cache/gateway";
import { cdnCache } from "../runtime/cache/client";

const configuration = Schema.decodeSync(CacheServerConfig)({
  token: Redacted.make("test-cache-service-secret"),
  host: "127.0.0.1",
  port: 0,
  edgeEndpoint: "http://127.0.0.1:6081",
  maxEntries: 8,
  maxMetadataBytes: 16384,
  maxStagingBytes: 1024,
  maxEntryBytes: 512,
  maxTtlSeconds: 60,
});
const entry = (key: string, expiresAt = 10000) => ({
  key,
  generation: crypto.randomUUID(),
  headers: "headers",
  checksum: "checksum",
  expiresAt,
  length: 1,
});

const value = () =>
  new Response(new Uint8Array([0, 255, 128, 20]), {
    headers: {
      "cache-control": "public, max-age=60",
      "content-type": "application/octet-stream",
      "content-length": "4",
      etag: '"version"',
    },
  });

test("deletion and superseded writes fence in-flight cache fills", () => {
  const state = cacheState(configuration);
  const old = state.begin(entry("key"), new Uint8Array([1]));
  expect(old).toBeDefined();
  if (old === undefined) return;
  expect(state.finish(old, 0)).toBe(true);
  state.release(old);
  const late = state.begin(entry("key"), new Uint8Array([2]));
  if (late === undefined) throw new Error("Missing pending cache write");
  expect(state.remove("key", 0)).toBe(true);
  expect(state.finish(late, 0)).toBe(false);
  state.release(late);
  expect(state.read("key", 0)).toBeUndefined();
  const first = state.begin(entry("key"), new Uint8Array([1]));
  const second = state.begin(entry("key"), new Uint8Array([2]));
  if (first === undefined || second === undefined) throw new Error("Missing cache writes");
  expect(state.finish(second, 0)).toBe(true);
  expect(state.finish(first, 0)).toBe(false);
  state.release(first);
  state.release(second);
  expect(state.read("key", 0)?.generation).toBe(second.entry.generation);
  expect(state.usage().staging).toBe(0);
});

test("cache metadata, staging and expiry obey hard budgets", () => {
  const state = cacheState({ ...configuration, maxEntries: 1 });
  const first = state.begin(entry("one", 10), new Uint8Array(512));
  const second = state.begin(entry("two", 20), new Uint8Array(512));
  if (first === undefined || second === undefined) throw new Error("Missing cache writes");
  expect(state.begin(entry("overflow"), new Uint8Array([1]))).toBeUndefined();
  expect(state.finish(first, 0)).toBe(false);
  expect(state.finish(second, 0)).toBe(true);
  state.release(first);
  state.release(second);
  expect(state.read("two", 20)).toBeUndefined();
  expect(state.usage()).toEqual({ entries: 0, metadata: 0, staging: 0 });
});

test("CachePort shares immutable bytes, isolates scopes and authenticates every hit", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const retained = new Map<string, Uint8Array<ArrayBuffer>>();
        const origin = {
          fetch: (_request: Request): Response => new Response(null, { status: 404 }),
        };
        const edge = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              async fetch(request) {
                const path = new URL(request.url).pathname;
                const hit = retained.get(path);
                if (hit !== undefined) return new Response(hit);
                const response = origin.fetch(request);
                if (response.ok) {
                  const bytes = new Uint8Array(await response.arrayBuffer());
                  retained.set(path, bytes);
                  return new Response(bytes);
                }
                return response;
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        );
        const gateway = yield* cacheGateway({
          ...configuration,
          edgeEndpoint: edge.url.toString(),
        });
        origin.fetch = gateway.origin;
        const service = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: gateway.fetch,
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        );
        const client = {
          endpoint: service.url.toString(),
          token: configuration.token,
          timeoutMillis: 1000,
          maxEntryBytes: 512,
        };
        const provider = yield* cdnCache(client, "bucket-one");
        const replica = yield* cdnCache(client, "bucket-one");
        const other = yield* cdnCache(client, "bucket-two");
        const cache = yield* Effect.promise(() => provider.open("raio-segments-v1"));
        const peer = yield* Effect.promise(() => replica.open("raio-segments-v1"));
        const isolated = yield* Effect.promise(() => other.open("raio-segments-v1"));
        const key = "https://segments.invalid/immutable-version";
        expect(yield* Effect.promise(() => cache.match(key))).toBeUndefined();
        yield* Effect.promise(() => cache.put(key, value()));
        const hit = yield* Effect.promise(() => peer.match(key));
        expect(hit?.headers.get("etag")).toBe('"version"');
        expect(
          new Uint8Array(
            yield* Effect.promise(async () => (await hit?.arrayBuffer()) ?? new ArrayBuffer(0)),
          ),
        ).toEqual(new Uint8Array([0, 255, 128, 20]));
        const conditional = yield* Effect.promise(() =>
          peer.match(new Request(key, { headers: { "if-none-match": '"version"' } })),
        );
        expect(conditional?.status).toBe(304);
        const partial = yield* Effect.promise(() =>
          peer.match(new Request(key, { headers: { range: "bytes=1-2" } })),
        );
        expect(partial?.status).toBe(206);
        expect(partial?.headers.get("content-range")).toBe("bytes 1-2/4");
        expect(
          new Uint8Array(
            yield* Effect.promise(async () => (await partial?.arrayBuffer()) ?? new ArrayBuffer(0)),
          ),
        ).toEqual(new Uint8Array([255, 128]));
        expect(yield* Effect.promise(() => isolated.match(key))).toBeUndefined();
        expect(
          yield* Effect.promise(() =>
            cache.put(
              key,
              new Response(new Uint8Array(513), {
                headers: { "cache-control": "public, max-age=60" },
              }),
            ),
          ).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });
        const bad = yield* cdnCache({ ...client, token: Redacted.make("wrong") }, "bucket-one");
        const unauthorized = yield* Effect.promise(() => bad.open("raio-segments-v1"));
        expect(
          yield* Effect.promise(() => unauthorized.match(key)).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });
        const snapshots = yield* Effect.promise(() => provider.open("raio-snapshots-v6"));
        yield* Effect.promise(() => snapshots.put(key, value()));
        expect(yield* Effect.promise(() => snapshots.match(key))).toBeUndefined();
        expect(
          yield* Effect.promise(() =>
            cache.put(new Request(key, { headers: { authorization: "Bearer user" } }), value()),
          ).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* Effect.promise(() =>
            cache.put(
              key,
              new Response("private", {
                headers: { "set-cookie": "secret", "cache-control": "public, max-age=60" },
              }),
            ),
          ).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });
        for (const bytes of retained.values()) bytes.fill(0);
        expect(yield* Effect.promise(() => cache.match(key))).toBeUndefined();
        retained.clear();
        expect(yield* Effect.promise(() => cache.match(key))).toBeUndefined();
        yield* Effect.promise(() => cache.put(key, value()));
        expect(yield* Effect.promise(() => cache.delete(key))).toBe(true);
        expect(yield* Effect.promise(() => peer.match(key))).toBeUndefined();
        expect(yield* Effect.promise(() => cache.delete(key))).toBe(false);
        expect(gateway.usage().staging).toBe(0);
      }),
    ),
  );
});

test("an unavailable cache has an abortable foreground deadline", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pending = { complete: (_response: Response) => {} };
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: () =>
                new Promise<Response>((resolve) => {
                  pending.complete = resolve;
                }),
            }),
          ),
          (owned) =>
            Effect.promise(async () => {
              pending.complete(new Response());
              await owned.stop(true);
            }),
        );
        const provider = yield* cdnCache(
          {
            endpoint: server.url.toString(),
            token: configuration.token,
            timeoutMillis: 25,
            maxEntryBytes: 512,
          },
          "timeout-bucket",
        );
        const cache = yield* Effect.promise(() => provider.open("raio-segments-v1"));
        const start = yield* Clock.currentTimeMillis;
        const result = yield* Effect.promise(() =>
          cache.match("https://segments.invalid/timeout"),
        ).pipe(Effect.exit);
        expect(result).toMatchObject({ _tag: "Failure" });
        expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(5000);
      }),
    ),
  );
});
