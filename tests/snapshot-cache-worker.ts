import { Effect } from "effect";
import worker from "../src/worker";
import type { Env } from "../alchemy.run";
export { SearchNamespace, Segments, Terms } from "../src/worker";

const state = { blocked: true, started: 0, completed: 0 };
const opened = new WeakSet<Cache>();
const open = caches.open.bind(caches);
caches.open = async (name) => {
  const cache = await open(name);
  if (name !== "raio-snapshots-v7" || opened.has(cache)) return cache;
  opened.add(cache);
  const match = cache.match.bind(cache);
  cache.match = async (input, options) => {
    const response = await match(input, options);
    if (!state.blocked) return response;
    state.started += 1;
    await Effect.runPromise(Effect.sleep("800 millis"));
    state.completed += 1;
    return response;
  };
  return cache;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/release") {
      state.blocked = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/state")
      return new Response(null, {
        headers: {
          "x-fixture-started": String(state.started),
          "x-fixture-completed": String(state.completed),
        },
      });
    return worker.fetch(request, env, ctx);
  },
};
