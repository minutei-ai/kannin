import { Effect, Redacted, Schema, Semaphore } from "effect";
import {
  CacheClientConfig,
  CacheDeleteResultJson,
  CacheFailure,
  CacheHeadersJson,
  CacheObjectId,
  ImmutableCacheName,
} from "../../src/protocol";
import { sha256, sha256Bytes } from "../../src/hash";
import type { CacheProvider } from "../../src/platform";
import { readCacheBody } from "./body";
import { matchCachedResponse } from "./match";

export const disabledCache: CacheProvider = {
  open: async () => ({
    match: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
  }),
};

export const cdnCache = Effect.fn("kannin.cache.client")(function* (
  configuration: typeof CacheClientConfig.Type,
  scope: string,
) {
  const config = yield* Schema.decodeEffect(CacheClientConfig)(configuration);
  const capacity = Semaphore.makeUnsafe(4);
  const run = Effect.runPromiseWith(yield* Effect.context());
  const request = Effect.fn("kannin.cache.request")(function* (
    name: typeof ImmutableCacheName.Type,
    key: Request | URL | string,
    method: "GET" | "PUT" | "DELETE",
    value?: Response,
  ) {
    const input = new Request(key);
    if (input.headers.has("authorization") || input.headers.has("cookie"))
      return yield* new CacheFailure({
        operation: "initialize",
        cause: new Error("Authenticated requests cannot enter the shared cache"),
      });
    if (input.method !== "GET")
      return yield* new CacheFailure({
        operation: "initialize",
        cause: new Error("Cache keys must be GET requests"),
      });
    const id = yield* Effect.tryPromise(() => sha256(`${scope}\0${name}\0${input.url}`));
    const url = new URL(`v1/cache/${name}/${id}`, `${config.endpoint.replace(/\/$/, "")}/`);
    const headers = new Headers({
      "x-kannin-cache-token": Redacted.value(config.token),
      "accept-encoding": "identity",
    });
    const body: { bytes?: Uint8Array<ArrayBuffer> } = {};
    if (value !== undefined) {
      if (value.status !== 200 || value.headers.has("vary"))
        return yield* new CacheFailure({
          operation: "put",
          cause: new Error("Only invariant immutable cache responses are supported"),
        });
      const encoded = yield* Schema.encodeEffect(CacheHeadersJson)(
        Object.fromEntries(value.headers),
      );
      if (encoded.length > 8192)
        return yield* new CacheFailure({
          operation: "put",
          cause: new Error("Cache headers exceed their byte budget"),
        });
      headers.set(
        "x-kannin-cache-headers",
        yield* Schema.encodeEffect(Schema.StringFromBase64)(encoded),
      );
      body.bytes = yield* readCacheBody(value.body, config.maxEntryBytes);
      headers.set(
        "x-kannin-cache-sha256",
        yield* Effect.tryPromise(() => sha256Bytes(body.bytes ?? new Uint8Array())),
      );
      headers.set("content-type", "application/octet-stream");
    }
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        fetch(url, {
          method,
          headers,
          signal,
          ...(body.bytes !== undefined && { body: body.bytes }),
        }),
      ).pipe(Effect.interruptible),
      (response) =>
        Effect.gen(function* () {
          if (response.status === 404) return undefined;
          if (!response.ok)
            return yield* new CacheFailure({
              operation: "initialize",
              cause: new Error(`Cache service returned HTTP ${response.status}`),
            });
          if (method === "PUT") return undefined;
          if (method === "DELETE") {
            const result = yield* readCacheBody(response.body, 1024).pipe(
              Effect.flatMap((bytes) =>
                Schema.decodeEffect(CacheDeleteResultJson)(new TextDecoder().decode(bytes)),
              ),
            );
            return result.deleted;
          }
          const encoded = yield* Schema.decodeUnknownEffect(Schema.StringFromBase64)(
            response.headers.get("x-kannin-cache-headers"),
          );
          const stored = yield* Schema.decodeEffect(CacheHeadersJson)(encoded);
          const checksum = yield* Schema.decodeUnknownEffect(CacheObjectId)(
            response.headers.get("x-kannin-cache-sha256"),
          );
          const bytes = yield* readCacheBody(response.body, config.maxEntryBytes);
          if ((yield* Effect.tryPromise(() => sha256Bytes(bytes))) !== checksum)
            return yield* new CacheFailure({
              operation: "match",
              cause: new Error("Cache response checksum mismatch"),
            });
          return matchCachedResponse(input, bytes, stored);
        }),
      (response) =>
        Effect.promise(async () => {
          await response.body?.cancel();
        }),
    );
  });
  const provider: CacheProvider = {
    async open(name) {
      if (!Schema.is(ImmutableCacheName)(name)) return disabledCache.open(name);
      return {
        async match(key) {
          const result = await run(
            request(name, key, "GET").pipe(
              (work) => capacity.withPermit(work),
              Effect.timeout(`${config.timeoutMillis} millis`),
              Effect.mapError((cause) => new CacheFailure({ operation: "match", cause })),
            ),
          );
          if (typeof result === "boolean") return undefined;
          return result;
        },
        async put(key, value) {
          await run(
            request(name, key, "PUT", value).pipe(
              (work) => capacity.withPermit(work),
              Effect.timeout(`${Math.max(1000, config.timeoutMillis)} millis`),
              Effect.mapError((cause) => new CacheFailure({ operation: "put", cause })),
            ),
          );
        },
        async delete(key) {
          const result = await run(
            request(name, key, "DELETE").pipe(
              (work) => capacity.withPermit(work),
              Effect.timeout(`${config.timeoutMillis} millis`),
              Effect.mapError((cause) => new CacheFailure({ operation: "delete", cause })),
            ),
          );
          return result === true;
        },
      };
    },
  };
  return provider;
});
