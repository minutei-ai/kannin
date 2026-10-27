import type { Env } from "../alchemy.run";
import { Effect, Match, Schema, Semaphore } from "effect";
import {
  readDocumentHits,
  readDocuments,
  documentReadConcurrency,
  clearImmutableCache,
  cacheUsage,
} from "../src/storage";
import {
  MetadataAcquisitionHitProbe,
  MetadataAcquisitionPageProbe,
  MetadataAcquisitionHitResult,
  MetadataAcquisitionPageResult,
  MetadataAcquisitionState,
  MetadataAcquisitionSource,
} from "./metadata-acquisition-contract";
export { Segments, Terms, SearchNamespace, KanninRpc } from "../src/worker";
const lengths: number[] = [];
const state = {
  active: 0,
  peak: 0,
  reads: 0,
  bytes: 0,
  lengths,
  wideKey: "",
  holdWide: false,
  wideStarted: 0,
  wideFinished: 0,
};
const wrapped = new WeakSet<R2Bucket>();
function instrument(bucket: R2Bucket) {
  if (wrapped.has(bucket)) return;
  wrapped.add(bucket);
  const get = bucket.get.bind(bucket);
  Object.defineProperty(bucket, "get", {
    value: async (...args: Parameters<R2Bucket["get"]>) => {
      if (!args[0].startsWith("namespaces/wide-") || !args[0].endsWith(".rsix"))
        return get(...args);
      const requestRange = args[1]?.range;
      const wide =
        args[0] === state.wideKey &&
        requestRange !== undefined &&
        "length" in requestRange &&
        typeof requestRange.length === "number" &&
        requestRange.length > 4096;
      state.reads += 1;
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      if (wide) state.wideStarted += 1;
      return Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.sleep("80 millis");
          if (wide)
            yield* Effect.sleep("5 millis").pipe(Effect.repeat({ while: () => state.holdWide }));
          const object = yield* Effect.tryPromise(() => get(...args));
          if (object !== null) {
            const requested = args[1]?.range;
            if (
              requested !== undefined &&
              "length" in requested &&
              typeof requested.length === "number"
            ) {
              state.bytes += requested.length;
              state.lengths.push(requested.length);
            } else {
              state.bytes += object.size;
              state.lengths.push(object.size);
            }
          }
          return object;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.active -= 1;
              if (wide) state.wideFinished += 1;
            }),
          ),
        ),
      );
    },
  });
}
function reset() {
  clearImmutableCache("namespaces");
  state.peak = 0;
  state.reads = 0;
  state.bytes = 0;
  state.lengths.length = 0;
  state.wideKey = "";
  state.holdWide = false;
  state.wideStarted = 0;
  state.wideFinished = 0;
}
export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
      return new Response(null, { status: 401 });
    instrument(env.STORAGE);
    const path = new URL(request.url).pathname;
    if (path === "/state")
      return new Response(
        Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionState))(state),
        { headers: { "content-type": "application/json" } },
      );
    if (path === "/release-wide") {
      state.holdWide = false;
      return new Response(null, { status: 204 });
    }
    if (path === "/arm-wide") {
      const input = Schema.decodeUnknownSync(MetadataAcquisitionSource)(await request.json());
      reset();
      state.wideKey = input.key;
      state.holdWide = true;
      return new Response(null, { status: 204 });
    }
    if (path === "/hits") {
      const input = Schema.decodeUnknownSync(MetadataAcquisitionHitProbe)(await request.json());
      if (input.clear) reset();
      const before = cacheUsage();
      const response = await Effect.runPromise(
        readDocumentHits(input.locations).pipe(
          Effect.match({
            onFailure: () => new Response(null, { status: 503 }),
            onSuccess: (rows) =>
              new Response(
                Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionHitResult))(rows),
                { headers: { "content-type": "application/json" } },
              ),
          }),
        ),
      );
      const after = cacheUsage();
      response.headers.set("x-reads", String(after.rangeReads - before.rangeReads));
      response.headers.set(
        "x-charged",
        String(after.rangeCacheChargedBytes - before.rangeCacheChargedBytes),
      );
      response.headers.set("x-cache-hits", String(after.rangeCacheHits - before.rangeCacheHits));
      return response;
    }
    if (path === "/pages" || path === "/mutate-payload") {
      const input = Schema.decodeUnknownSync(MetadataAcquisitionPageProbe)(await request.json());
      if (input.clear) reset();
      const before = cacheUsage();
      const offsets = { normal: 0, nan: NaN, fraction: 0.5, infinity: Infinity };
      const payload = Match.value(input.payload).pipe(
        Match.when(undefined, () => undefined),
        Match.orElse((bytes) => new Uint8Array(bytes)),
      );
      if (path === "/mutate-payload" && payload === undefined)
        return new Response(null, { status: 400 });
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          const permits = yield* Semaphore.make(documentReadConcurrency(input.pages));
          const documents = yield* readDocuments(
            input.source.key,
            input.source.headerBytes,
            input.pages,
            input.source.bytes,
            input.source.metadataEnd,
            permits,
            payload,
            offsets[input.payloadOffset],
          );
          if (path === "/mutate-payload" && payload !== undefined) {
            payload.fill(0);
            return yield* readDocuments(
              input.source.key,
              input.source.headerBytes,
              input.pages,
              input.source.bytes,
              input.source.metadataEnd,
              permits,
            );
          }
          return documents;
        }).pipe(
          Effect.match({
            onFailure: () => new Response(null, { status: 503 }),
            onSuccess: (rows) =>
              new Response(
                Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionPageResult))(rows),
                { headers: { "content-type": "application/json" } },
              ),
          }),
        ),
      );
      const after = cacheUsage();
      response.headers.set("x-reads", String(after.rangeReads - before.rangeReads));
      response.headers.set(
        "x-charged",
        String(after.rangeCacheChargedBytes - before.rangeCacheChargedBytes),
      );
      response.headers.set("x-cache-hits", String(after.rangeCacheHits - before.rangeCacheHits));
      return response;
    }
    return new Response(null, { status: 404 });
  },
};
