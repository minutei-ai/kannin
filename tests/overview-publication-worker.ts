import { Effect } from "effect";
import worker from "../src/worker";
import type { Env } from "../alchemy.run";
export { SearchNamespace, Segments, Terms } from "../src/worker";

const state = { started: 0, completed: 0 };
const opened = new WeakSet<Cache>();
const open = caches.open.bind(caches);
caches.open = async (name) => {
  const cache = await open(name);
  if (name !== "raio-overview-batches-v4" || opened.has(cache)) return cache;
  opened.add(cache);
  const put = cache.put.bind(cache);
  cache.put = async (input, response) => {
    state.started += 1;
    await Effect.runPromise(Effect.sleep("800 millis"));
    await put(input, response);
    state.completed += 1;
  };
  return cache;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
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
