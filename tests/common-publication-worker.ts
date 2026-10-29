import { Effect, Schema } from "effect";
import type { Env } from "../alchemy.run";
import { Directory, PreparedQuery } from "../dist/wasm/raio_engine";
import { RankingInput, TermProjectionRange } from "../src/protocol";
import { clearImmutableCache, storeSegmentCaches, withDirectory } from "../src/storage";
export { Segments, Terms, SearchNamespace, KanninRpc } from "../src/worker";

const state = {
  key: "",
  miss: false,
  blocked: false,
  headerStarted: 0,
  headerFinished: 0,
  hotStarted: 0,
  hotFinished: 0,
  budgetReject: false,
};
const decodeCommon = Directory.common.bind(Directory);
Directory.common = (bytes, length, budget) => {
  if (state.budgetReject) {
    state.budgetReject = false;
    return decodeCommon(bytes, length, 1);
  }
  return decodeCommon(bytes, length, budget);
};
const wrapped = new WeakSet<R2Bucket>();
function instrument(bucket: R2Bucket) {
  if (wrapped.has(bucket)) return;
  wrapped.add(bucket);
  const get = bucket.get.bind(bucket);
  const put = bucket.put.bind(bucket);
  Object.defineProperty(bucket, "get", {
    value: async (...args: Parameters<R2Bucket["get"]>) => {
      if (state.miss && args[0] === state.key) {
        state.miss = false;
        return null;
      }
      return get(...args);
    },
  });
  Object.defineProperty(bucket, "put", {
    value: async (...args: Parameters<R2Bucket["put"]>) => {
      if (args[0] !== state.key) return put(...args);
      if (args[2]?.onlyIf !== undefined) {
        state.headerStarted += 1;
        await Effect.runPromise(
          Effect.sleep("10 millis").pipe(Effect.repeat({ while: () => state.blocked })),
        );
        const result = await put(...args);
        state.headerFinished += 1;
        return result;
      }
      state.hotStarted += 1;
      const result = await put(...args);
      state.hotFinished += 1;
      return result;
    },
  });
}
const Probe = Schema.Struct({
  source: TermProjectionRange,
  input: RankingInput,
  miss: Schema.Boolean,
  budgetReject: Schema.Boolean,
  saturate: Schema.Boolean,
});

export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
      return new Response(null, { status: 401 });
    instrument(env.STORAGE);
    const path = new URL(request.url).pathname;
    if (path === "/state")
      return new Response(null, {
        headers: {
          "x-header-started": String(state.headerStarted),
          "x-header-finished": String(state.headerFinished),
          "x-hot-started": String(state.hotStarted),
          "x-hot-finished": String(state.hotFinished),
        },
      });
    if (path === "/block") {
      state.blocked = true;
      return new Response(null, { status: 204 });
    }
    if (path === "/release") {
      state.blocked = false;
      return new Response(null, { status: 204 });
    }
    if (path === "/probe") {
      const input = Schema.decodeUnknownSync(Probe)(await request.json());
      state.key = `cache/directory-common-v4/${input.source.key}/${input.source.headerBytes}`;
      state.miss = input.miss;
      state.budgetReject = input.budgetReject;
      clearImmutableCache(input.source.key);
      using query = new PreparedQuery(
        Schema.encodeSync(Schema.fromJsonString(RankingInput))(input.input),
      );
      const probe = withDirectory(
        input.source.key,
        input.source.headerBytes,
        (directory) => Effect.sync(() => directory.covers_query(query)),
        undefined,
        false,
        false,
        query,
      );
      const held = { count: 0 };
      const saturate = (index: number): typeof probe => {
        if (index === 64) return probe;
        return withDirectory(
          input.source.key.replace(/[^/]+$/, `hold-${index}.rsix`),
          input.source.headerBytes,
          () =>
            Effect.gen(function* () {
              held.count += 1;
              return yield* saturate(index + 1);
            }),
          undefined,
          true,
        );
      };
      const covered = await Effect.runPromise(
        Effect.gen(function* () {
          if (input.saturate) return yield* saturate(0);
          return yield* probe;
        }),
      );
      if (!covered) return new Response(null, { status: 500 });
      return new Response(null, {
        status: 204,
        headers: { "x-held-directories": String(held.count) },
      });
    }
    if (path === "/hot") {
      const source = Schema.decodeUnknownSync(TermProjectionRange)(await request.json());
      state.key = `cache/directory-common-v4/${source.key}/${source.headerBytes}`;
      const object = await env.STORAGE.get(source.key);
      if (object === null) return new Response(null, { status: 404 });
      const bytes = new Uint8Array(await object.arrayBuffer());
      await Effect.runPromise(storeSegmentCaches(source.key, source.headerBytes, bytes, true));
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  },
};
