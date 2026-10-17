import { Clock, Effect } from "effect";
import worker, { Terms as Catalogs } from "../src/worker";
import type { Env } from "../alchemy.run";
export { SearchNamespace, Segments } from "../src/worker";
const state = {
  headerDelay: 0,
  bodyDelay: 0,
  failPut: false,
  gets: 0,
  headerActive: 0,
  bodyActive: 0,
  bodyCompleted: 0,
  bodyReleasedAt: 0n,
  bodyHandoffMs: 0,
  bodyPeak: 0,
  headerPeak: 0,
  apiEnabled: false,
  apiPuts: 0,
};
const opened = new WeakSet<Cache>();
const wrapped = new WeakSet<R2Bucket>();
const open = caches.open.bind(caches);
caches.open = async (name) => {
  if (name === "kannin-text-plans-v1")
    return Promise.reject(new Error("Projected caches disabled for overview fixture"));
  const cache = await open(name);
  if (name !== "raio-overview-batches-v6" || opened.has(cache)) return cache;
  opened.add(cache);
  const match = cache.match.bind(cache);
  const put = cache.put.bind(cache);
  cache.match = async (input, options) => {
    if (state.apiEnabled) return match(input, options);
    return undefined;
  };
  cache.put = async (input, response) => {
    if (state.apiEnabled) {
      await put(input, response);
      state.apiPuts += 1;
    }
  };
  return cache;
};
export class Terms extends Catalogs {
  override async fetch(request: Request) {
    const bucket = this.env.STORAGE;
    if (!wrapped.has(bucket)) {
      wrapped.add(bucket);
      const get = bucket.get.bind(bucket);
      const put = bucket.put.bind(bucket);
      Object.defineProperty(bucket, "put", {
        value: (...args: Parameters<R2Bucket["put"]>) => {
          if (state.failPut && args[0].startsWith("cache/correlated-pool-batches-v1/"))
            return Promise.reject(new Error("Injected batch publication failure"));
          return put(...args);
        },
      });
      Object.defineProperty(bucket, "get", {
        value: async (...args: Parameters<R2Bucket["get"]>) => {
          if (!args[0].startsWith("cache/correlated-pool-batches-v1/")) return get(...args);
          state.gets += 1;
          state.headerActive += 1;
          state.headerPeak = Math.max(state.headerPeak, state.headerActive);
          const object = await Effect.runPromise(
            Effect.sleep(state.headerDelay).pipe(
              Effect.andThen(Effect.tryPromise(() => get(...args))),
              Effect.ensuring(
                Effect.sync(() => {
                  state.headerActive -= 1;
                }),
              ),
            ),
          );
          if (object === null || !("body" in object)) return object;
          const read = object.arrayBuffer.bind(object);
          Object.defineProperty(object, "arrayBuffer", {
            value: () => {
              if (state.bodyReleasedAt > 0n)
                state.bodyHandoffMs = Math.max(
                  state.bodyHandoffMs,
                  Number(Effect.runSync(Clock.currentTimeNanos) - state.bodyReleasedAt) / 1e6,
                );
              state.bodyActive += 1;
              state.bodyPeak = Math.max(state.bodyPeak, state.bodyActive);
              return Effect.runPromise(
                Effect.sleep(state.bodyDelay).pipe(
                  Effect.andThen(Effect.tryPromise(read)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      state.bodyCompleted += 1;
                    }),
                  ),
                  Effect.ensuring(
                    Effect.gen(function* () {
                      state.bodyReleasedAt = yield* Clock.currentTimeNanos;
                      state.bodyActive -= 1;
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
    return super.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture/normal") {
      state.failPut = false;
      state.headerDelay = 0;
      state.bodyDelay = 0;
    }
    if (path === "/fixture/slow-headers") state.headerDelay = 80;
    if (path === "/fixture/api") state.apiEnabled = true;
    if (path === "/fixture/headers") state.headerDelay = 1600;
    if (path === "/fixture/slow-body") {
      state.bodyDelay = 300;
      state.bodyReleasedAt = 0n;
      state.bodyHandoffMs = 0;
    }
    if (path === "/fixture/body") state.bodyDelay = 1600;
    if (path === "/fixture/fail-put") state.failPut = true;
    if (path.startsWith("/fixture/"))
      return new Response(null, {
        headers: {
          "x-gets": String(state.gets),
          "x-header-active": String(state.headerActive),
          "x-body-active": String(state.bodyActive),
          "x-body-completed": String(state.bodyCompleted),
          "x-body-handoff-ms": String(state.bodyHandoffMs),
          "x-body-peak": String(state.bodyPeak),
          "x-header-peak": String(state.headerPeak),
          "x-api-puts": String(state.apiPuts),
        },
      });
    return worker.fetch(request, env, ctx);
  },
};
