import { timingSafeEqual } from "node:crypto";
import { Clock, Effect, Option, Redacted, Schema, Semaphore } from "effect";
import {
  CacheHeadersJson,
  CacheObjectId,
  CacheServerConfig,
  ImmutableCacheName,
} from "../../src/protocol";
import { sha256Bytes } from "../../src/hash";
import { readCacheBody } from "./body";
import { cacheState } from "./state";

const reply = (status: number, body?: BodyInit, headers?: HeadersInit) => {
  const output = new Headers(headers);
  output.set("cache-control", "no-store");
  return new Response(body, { status, headers: output });
};

const generationId = () => crypto.randomUUID();

export const cacheGateway = Effect.fn("kannin.cache.gateway")(function* (
  configuration: typeof CacheServerConfig.Type,
) {
  const config = yield* Schema.decodeEffect(CacheServerConfig)(configuration);
  const state = cacheState(config);
  const capacity = Semaphore.makeUnsafe(4);
  const secret = new TextEncoder().encode(Redacted.value(config.token));
  const edge = Effect.fn("kannin.cache.edge")(function* (path: string) {
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        fetch(new URL(path, config.edgeEndpoint), {
          signal,
          headers: { "accept-encoding": "identity" },
        }),
      ).pipe(Effect.interruptible),
      (response) =>
        Effect.gen(function* () {
          if (response.status !== 200) return undefined;
          return yield* readCacheBody(response.body, config.maxEntryBytes);
        }),
      (response) =>
        Effect.promise(async () => {
          await response.body?.cancel();
        }),
    ).pipe(Effect.timeout("2 seconds"));
  });
  const handle = Effect.fn("kannin.cache.handle")(function* (request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return reply(200, "ok");
    const supplied = new TextEncoder().encode(request.headers.get("x-kannin-cache-token") ?? "");
    if (supplied.byteLength !== secret.byteLength || !timingSafeEqual(secret, supplied))
      return reply(401);
    const parts = url.pathname.split("/");
    if (
      parts.length !== 5 ||
      parts[1] !== "v1" ||
      parts[2] !== "cache" ||
      !Schema.is(ImmutableCacheName)(parts[3]) ||
      !Schema.is(CacheObjectId)(parts[4]) ||
      url.search !== ""
    )
      return reply(404);
    const key = `${parts[3]}/${parts[4]}`;
    const now = yield* Clock.currentTimeMillis;
    if (request.method === "DELETE")
      return reply(200, JSON.stringify({ deleted: state.remove(key, now) }), {
        "content-type": "application/json",
      });
    if (request.method === "GET") {
      const entry = state.read(key, now);
      if (entry === undefined) return reply(404);
      const bytes = yield* edge(`/objects/${key}/${entry.generation}`);
      if (
        bytes === undefined ||
        bytes.byteLength !== entry.length ||
        (yield* Effect.tryPromise(() => sha256Bytes(bytes))) !== entry.checksum ||
        state.read(key, yield* Clock.currentTimeMillis) !== entry
      )
        return reply(404);
      return reply(200, bytes, {
        "content-type": "application/octet-stream",
        "x-kannin-cache-headers": entry.headers,
        "x-kannin-cache-sha256": entry.checksum,
      });
    }
    if (request.method !== "PUT") return reply(405);
    const encoded = request.headers.get("x-kannin-cache-headers");
    if (encoded === null || encoded.length > 11000) return reply(400);
    const json = yield* Schema.decodeEffect(Schema.StringFromBase64)(encoded);
    if (json.length > 8192) return reply(400);
    const headers = yield* Schema.decodeEffect(CacheHeadersJson)(json);
    if (headers.vary !== undefined) return reply(400);
    const control = headers["cache-control"] ?? "";
    if (/(?:^|,)\s*(?:private|no-store|no-cache)(?:\s|,|=|$)/i.test(control)) return reply(400);
    const shared = /(?:^|,)\s*s-maxage\s*=\s*(\d+)\s*(?:,|$)/i.exec(control);
    const local = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(control);
    const ttl = Number(shared?.[1] ?? local?.[1] ?? "0");
    if (!Number.isSafeInteger(ttl) || ttl <= 0) return reply(400);
    const checksum = yield* Schema.decodeUnknownEffect(CacheObjectId)(
      request.headers.get("x-kannin-cache-sha256"),
    );
    const bytes = yield* readCacheBody(request.body, config.maxEntryBytes);
    if ((yield* Effect.tryPromise(() => sha256Bytes(bytes))) !== checksum) return reply(400);
    const generation = yield* Effect.sync(generationId);
    const write = state.begin(
      {
        key,
        generation,
        headers: encoded,
        checksum,
        length: bytes.byteLength,
        expiresAt: now + Math.min(ttl, config.maxTtlSeconds) * 1000,
      },
      bytes,
    );
    if (write === undefined) return reply(503);
    return yield* Effect.gen(function* () {
      const warmed = yield* edge(`/objects/${write.origin}`);
      if (
        warmed === undefined ||
        (yield* Effect.tryPromise(() => sha256Bytes(warmed))) !== checksum ||
        !state.finish(write, yield* Clock.currentTimeMillis)
      )
        return reply(503);
      return reply(204);
    }).pipe(Effect.ensuring(Effect.sync(() => state.release(write))));
  });
  const origin = (request: Request) => {
    if (request.method !== "GET") return reply(405);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/objects/") || url.search !== "") return reply(404);
    const payload = state.origin(url.pathname.slice(9), Date.now());
    if (payload === undefined) return reply(404);
    const ttl = Math.max(0, Math.floor((payload.entry.expiresAt - Date.now()) / 1000));
    return new Response(payload.bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(payload.bytes.byteLength),
        "cache-control": `public, max-age=${ttl}`,
      },
    });
  };
  const run = Effect.runPromiseWith(yield* Effect.context());
  const handler = (request: Request) =>
    run(
      handle(request).pipe(
        capacity.withPermitsIfAvailable(1),
        Effect.map((response) => Option.getOrElse(response, () => reply(503))),
        Effect.orElseSucceed(() => reply(502)),
      ),
    );
  return { fetch: handler, origin, usage: state.usage };
});
