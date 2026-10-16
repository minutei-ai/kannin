import { Effect } from "effect";
import worker from "../src/worker";
import type { Env } from "../alchemy.run";
export { SearchNamespace, Segments, Terms } from "../src/worker";

const state = {
  blocked: false,
  started: 0,
  completed: 0,
  cancelled: 0,
  conditionals: 0,
  headerDelay: 0,
  bodyDelay: 1600,
  corrupt: false,
  oversized: false,
};
const wrapped = new WeakSet<R2Bucket>();
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!wrapped.has(env.STORAGE)) {
      wrapped.add(env.STORAGE);
      const get = env.STORAGE.get.bind(env.STORAGE);
      Object.defineProperty(env.STORAGE, "get", {
        value: async (...args: Parameters<R2Bucket["get"]>) => {
          if (args[0].endsWith("/root.json") && args[1]?.onlyIf !== undefined)
            state.conditionals += 1;
          const object = await get(...args);
          if (
            object === null ||
            !("body" in object) ||
            !state.blocked ||
            !args[0].endsWith("/root.json")
          )
            return object;
          await Effect.runPromise(Effect.sleep(state.headerDelay));
          if (state.oversized) Object.defineProperty(object, "size", { value: 7 * 1024 * 1024 });
          else if (args[0].includes("/root-budget-pooled-"))
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
              await Effect.runPromise(Effect.sleep(state.bodyDelay));
              const bytes = await read();
              state.completed += 1;
              if (state.corrupt) return new TextEncoder().encode("{}").buffer;
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
    if (url.pathname === "/fixture/headers") {
      state.blocked = true;
      state.headerDelay = 1600;
      state.bodyDelay = 0;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/corrupt") {
      state.blocked = true;
      state.corrupt = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/oversized") {
      state.blocked = true;
      state.oversized = true;
      state.headerDelay = 1600;
      state.bodyDelay = 0;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/disarm") {
      state.blocked = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/state")
      return new Response(null, {
        headers: {
          "x-fixture-started": String(state.started),
          "x-fixture-completed": String(state.completed),
          "x-fixture-cancelled": String(state.cancelled),
          "x-fixture-conditionals": String(state.conditionals),
        },
      });
    return worker.fetch(request, env, ctx);
  },
};
