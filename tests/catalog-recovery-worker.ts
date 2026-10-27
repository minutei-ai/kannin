import { Effect, Schema } from "effect";
import Worker, { Terms as NativeTerms, Segments as NativeSegments } from "../src/worker";
import { TermProjectionProps } from "../src/protocol";
import type { Env } from "../alchemy.run";

export { KanninRpc, SearchNamespace } from "../src/worker";

const state = {
  active: 0,
  peak: 0,
  bytes: 0,
  peakBytes: 0,
  started: 0,
  large: 0,
  overlap: false,
  firstCompleted: false,
  reordered: false,
};
const wrapped = new WeakSet<R2Bucket>();

function instrument(bucket: R2Bucket) {
  if (wrapped.has(bucket)) return;
  wrapped.add(bucket);
  const get = bucket.get.bind(bucket);
  Object.defineProperty(bucket, "get", {
    value: async (...args: Parameters<R2Bucket["get"]>) => {
      if (args[0].startsWith("cache/")) return null;
      const object = await get(...args);
      const range = args[1]?.range;
      if (
        object === null ||
        !("body" in object) ||
        range === undefined ||
        !("offset" in range) ||
        !("length" in range) ||
        range.offset !== 0 ||
        range.length === undefined
      )
        return object;
      const length = range.length;
      const read = object.arrayBuffer.bind(object);
      Object.defineProperty(object, "arrayBuffer", {
        value: () => {
          const large = length > 64 * 1024;
          if (state.large > 0 || (large && state.active > 0)) state.overlap = true;
          if (large) state.large += 1;
          state.active += 1;
          state.bytes += length;
          state.started += 1;
          state.peak = Math.max(state.peak, state.active);
          state.peakBytes = Math.max(state.peakBytes, state.bytes);
          return Effect.runPromise(
            Effect.gen(function* () {
              if (args[0].endsWith("/0.rsix")) yield* Effect.sleep("300 millis");
              else yield* Effect.sleep("100 millis");
              const bytes = yield* Effect.tryPromise(read);
              if (args[0].endsWith("/0.rsix")) state.firstCompleted = true;
              else if (!state.firstCompleted) state.reordered = true;
              return bytes;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  state.active -= 1;
                  state.bytes -= length;
                  if (large) state.large -= 1;
                }),
              ),
            ),
          );
        },
      });
      return object;
    },
  });
}

export class Terms extends NativeTerms {
  override fetch(request: Request) {
    instrument(this.env.STORAGE);
    return super.fetch(request);
  }
}

export class Segments extends NativeSegments {
  override fetch(request: Request) {
    instrument(this.env.STORAGE);
    return super.fetch(request);
  }
}

export default {
  ...Worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__state")
      return new Response(null, {
        headers: {
          "x-started": String(state.started),
          "x-active": String(state.active),
          "x-peak": String(state.peak),
          "x-peak-bytes": String(state.peakBytes),
          "x-large-overlap": String(state.overlap),
          "x-reordered": String(state.reordered),
        },
      });
    if (new URL(request.url).pathname !== "/__catalog") return Worker.fetch(request, env, ctx);
    const props = Schema.decodeUnknownSync(TermProjectionProps)(await request.json());
    return ctx.exports
      .Terms({ props: Schema.encodeSync(TermProjectionProps)(props) })
      .fetch("https://terms.internal/catalog-v12", { headers: request.headers });
  },
};
