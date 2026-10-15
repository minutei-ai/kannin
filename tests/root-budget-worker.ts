import { Effect } from "effect";
import worker from "../src/worker";
import type { Env } from "../alchemy.run";
export { SearchNamespace, Segments, Terms } from "../src/worker";

const state = { blocked: false, started: 0, completed: 0, cancelled: 0 };
const wrapped = new WeakSet<R2Bucket>();
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!wrapped.has(env.STORAGE)) {
      wrapped.add(env.STORAGE);
      const get = env.STORAGE.get.bind(env.STORAGE);
      Object.defineProperty(env.STORAGE, "get", {
        value: async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await get(...args);
          if (
            object === null ||
            !("body" in object) ||
            !state.blocked ||
            !args[0].endsWith("/root.json")
          )
            return object;
          if (args[0].includes("/root-budget-pooled-"))
            Object.defineProperty(object, "size", { value: 5 * 1024 * 1024 });
          const cancel = object.body.cancel.bind(object.body);
          Object.defineProperty(object.body, "cancel", {
            value: async () => {
              state.cancelled += 1;
              await cancel();
            },
          });
          const read = object.arrayBuffer.bind(object);
          Object.defineProperty(object, "arrayBuffer", {
            value: async () => {
              state.started += 1;
              await Effect.runPromise(Effect.sleep("1600 millis"));
              const bytes = await read();
              state.completed += 1;
              return bytes;
            },
          });
          return object;
        },
      });
    }
    const url = new URL(request.url);
    if (url.pathname === "/fixture/arm") {
      state.blocked = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/state")
      return new Response(null, {
        headers: {
          "x-fixture-started": String(state.started),
          "x-fixture-completed": String(state.completed),
          "x-fixture-cancelled": String(state.cancelled),
        },
      });
    return worker.fetch(request, env, ctx);
  },
};
