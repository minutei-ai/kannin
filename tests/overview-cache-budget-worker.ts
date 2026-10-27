import { Effect, Schema } from "effect";
import worker from "../src/worker";
import { clearImmutableCache } from "../src/storage";
import { NamespaceName } from "../src/protocol";
import type { Env } from "../alchemy.run";
export { SearchNamespace, Segments, Terms } from "../src/worker";

const Arm = Schema.Struct({
  phase: Schema.Literals(["open", "headers", "body"]),
  namespace: NamespaceName,
});
const state = { phase: "none", started: 0, completed: 0, published: 0, cancelled: 0 };
const opened = new WeakSet<Cache>();
const open = caches.open.bind(caches);
caches.open = async (name) => {
  if (name === "raio-overview-batches-v8" && state.phase === "open") {
    state.started += 1;
    await Effect.runPromise(Effect.sleep("1600 millis"));
    state.completed += 1;
  }
  const cache = await open(name);
  if (name !== "raio-overview-batches-v8" || opened.has(cache)) return cache;
  opened.add(cache);
  const put = cache.put.bind(cache);
  cache.put = async (input, response) => {
    await put(input, response);
    state.published += 1;
  };
  const match = cache.match.bind(cache);
  cache.match = async (input, options) => {
    if (state.phase === "headers") {
      state.started += 1;
      await Effect.runPromise(Effect.sleep("1600 millis"));
      state.completed += 1;
    }
    const response = await match(input, options);
    if (response === undefined || response.body === null || state.phase !== "body") return response;
    const reader = response.body.getReader();
    const progress = { started: false, settled: false };
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (!progress.started) {
              progress.started = true;
              state.started += 1;
              await Effect.runPromise(Effect.sleep("1600 millis"));
              if (progress.settled) return;
              progress.settled = true;
              state.completed += 1;
            }
            const chunk = await reader.read();
            if (chunk.done) controller.close();
            else controller.enqueue(Schema.decodeUnknownSync(Schema.Uint8Array)(chunk.value));
          },
          cancel(reason) {
            state.cancelled += 1;
            if (progress.started && !progress.settled) {
              progress.settled = true;
              state.completed += 1;
            }
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      ),
      response,
    );
  };
  return cache;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/clear") {
      clearImmutableCache(
        `namespaces/${Schema.decodeUnknownSync(NamespaceName)(await request.json())}`,
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/arm") {
      const input = Schema.decodeUnknownSync(Arm)(await request.json());
      clearImmutableCache(`namespaces/${input.namespace}`);
      state.phase = input.phase;
      state.started = 0;
      state.completed = 0;
      state.cancelled = 0;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/state")
      return new Response(null, {
        headers: {
          "x-fixture-started": String(state.started),
          "x-fixture-completed": String(state.completed),
          "x-fixture-published": String(state.published),
          "x-fixture-cancelled": String(state.cancelled),
        },
      });
    return worker.fetch(request, env, ctx);
  },
};
