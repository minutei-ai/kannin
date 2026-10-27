import { Effect } from "effect";
import worker, { Terms as Catalogs } from "../src/worker";
import type { Env } from "../alchemy.run";
export { SearchNamespace, Segments } from "../src/worker";

const state = {
  started: 0,
  active: 0,
  peak: 0,
  firstCompleted: false,
  refilled: false,
  termMatches: 0,
};
const wrapped = new WeakSet<R2Bucket>();
const opened = new WeakSet<Cache>();
const open = caches.open.bind(caches);
caches.open = async (name) => {
  const cache = await open(name);
  if (name !== "raio-terms-v7" || opened.has(cache)) return cache;
  opened.add(cache);
  const match = cache.match.bind(cache);
  cache.match = async (input, options) => {
    state.termMatches += 1;
    await Effect.runPromise(Effect.sleep("200 millis"));
    return match(input, options);
  };
  return cache;
};

export class Terms extends Catalogs {
  override async fetch(request: Request) {
    if (!wrapped.has(this.env.STORAGE)) {
      wrapped.add(this.env.STORAGE);
      const get = this.env.STORAGE.get.bind(this.env.STORAGE);
      Object.defineProperty(this.env.STORAGE, "get", {
        value: async (...args: Parameters<R2Bucket["get"]>) => {
          if (args[0].startsWith("cache/correlated-pool-batches-v3/")) return null;
          if (!args[0].startsWith("cache/correlated-pool-v3/")) return get(...args);
          state.started += 1;
          state.active += 1;
          state.peak = Math.max(state.peak, state.active);
          const ordinal = state.started;
          if (ordinal > 4 && !state.firstCompleted) state.refilled = true;
          return Effect.runPromise(
            Effect.gen(function* () {
              if (ordinal % 4 === 1) yield* Effect.sleep("500 millis");
              else yield* Effect.sleep("40 millis");
              return yield* Effect.tryPromise(() => get(...args));
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  state.active -= 1;
                  if (ordinal === 1) state.firstCompleted = true;
                }),
              ),
            ),
          );
        },
      });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/fixture/state")
      return new Response(null, {
        headers: {
          "x-fixture-started": String(state.started),
          "x-fixture-active": String(state.active),
          "x-fixture-peak": String(state.peak),
          "x-fixture-refilled": String(state.refilled),
          "x-fixture-term-matches": String(state.termMatches),
        },
      });
    return worker.fetch(request, env, ctx);
  },
};
