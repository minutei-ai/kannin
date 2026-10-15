import { Effect } from "effect";
import worker from "../src/worker";
export { SearchNamespace, Segments, Terms } from "../src/worker";

const state = { delay: 800, started: 0, completed: 0, failed: 0, fail: false };
const wrapped = new WeakSet<Cache>();
const open = caches.open.bind(caches);
Object.defineProperty(caches, "open", {
  value: async (...args: Parameters<CacheStorage["open"]>) => {
    const cache = await open(...args);
    if (args[0] !== "kannin-vectors-v2" || wrapped.has(cache)) return cache;
    wrapped.add(cache);
    const put = cache.put.bind(cache);
    Object.defineProperty(cache, "put", {
      value: async (...input: Parameters<Cache["put"]>) => {
        state.started += 1;
        if (state.delay > 0) await Effect.runPromise(Effect.sleep(state.delay));
        if (state.fail) {
          state.failed += 1;
          throw new Error("Injected optional cache publication failure");
        }
        await put(...input);
        state.completed += 1;
      },
    });
    return cache;
  },
});

export default {
  async fetch(...args: Parameters<typeof worker.fetch>) {
    const url = new URL(args[0].url);
    if (url.pathname === "/fixture/slow") state.delay = 5000;
    if (url.pathname === "/fixture/fail") {
      state.delay = 0;
      state.fail = true;
    }
    if (url.pathname === "/fixture/healthy") {
      state.delay = 0;
      state.fail = false;
    }
    if (url.pathname.startsWith("/fixture/"))
      return new Response(null, {
        headers: {
          "x-fixture-started": String(state.started),
          "x-fixture-completed": String(state.completed),
          "x-fixture-failed": String(state.failed),
        },
      });
    const response = await worker.fetch(...args);
    const headers = new Headers(response.headers);
    headers.set("x-fixture-started", String(state.started));
    headers.set("x-fixture-completed", String(state.completed));
    return new Response(response.body, { status: response.status, headers });
  },
};
