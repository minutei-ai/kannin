import { Effect, Schema } from "effect";
import worker, { SearchNamespace as ProductionNamespace } from "../src/worker";
import { clearImmutableCache } from "../src/storage";
import { NamespaceName, SharedTextPlan, SharedTextPlanCacheHeaders } from "../src/protocol";
import { pack, unpack } from "../dist/wasm/raio_engine";
import type { Env } from "../alchemy.run";
export { Segments, Terms } from "../src/worker";

const Arm = Schema.Struct({
  phase: Schema.Literals(["open", "headers", "body", "body-failure", "undercharged"]),
  namespace: NamespaceName,
  expanded: Schema.optional(Schema.Boolean),
});
const ExpandedPlan = SharedTextPlan.mapFields((fields) => ({ ...fields, padding: Schema.String }));
const state = {
  phase: "none",
  started: 0,
  completed: 0,
  published: 0,
  lookups: 0,
  active: 0,
  peak: 0,
  cancelled: 0,
  expanded: false,
};
const opened = new WeakSet<Cache>();
const open = caches.open.bind(caches);
caches.open = async (name) => {
  if (name === "kannin-text-plans-v1" && state.phase === "open") {
    state.started += 1;
    await Effect.runPromise(Effect.sleep("1600 millis"));
    state.completed += 1;
  }
  const cache = await open(name);
  if (name !== "kannin-text-plans-v1" || opened.has(cache)) return cache;
  opened.add(cache);
  const put = cache.put.bind(cache);
  cache.put = async (input, response) => {
    await put(input, response);
    state.published += 1;
  };
  const match = cache.match.bind(cache);
  cache.match = async (input, options) => {
    state.lookups += 1;
    if (state.phase === "headers") {
      state.started += 1;
      await Effect.runPromise(Effect.sleep("1600 millis"));
      state.completed += 1;
    }
    const response = await match(input, options);
    if (response === undefined || response.body === null) return response;
    if (state.phase === "undercharged") {
      const headers = new Headers(response.headers);
      headers.set("x-kannin-plan-bytes", "1");
      return new Response(response.body, { headers });
    }
    if (state.phase !== "body" && state.phase !== "body-failure") return response;
    const selected = { response };
    if (state.expanded) {
      const original = new Uint8Array(await response.arrayBuffer());
      const envelope = Schema.decodeSync(Schema.fromJsonString(SharedTextPlan))(unpack(original));
      const empty = Schema.encodeSync(Schema.fromJsonString(ExpandedPlan))({
        ...envelope,
        padding: "",
      });
      const encoded = Schema.encodeSync(Schema.fromJsonString(ExpandedPlan))({
        ...envelope,
        padding: "x".repeat(256 * 1024 - new TextEncoder().encode(empty).byteLength),
      });
      const packed = pack(encoded);
      const headers = new Headers(response.headers);
      for (const [headerName, value] of Object.entries(
        Schema.encodeSync(SharedTextPlanCacheHeaders)({
          "content-length": packed.byteLength,
          "x-kannin-plan-bytes": new TextEncoder().encode(encoded).byteLength,
        }),
      ))
        headers.set(headerName, value);
      selected.response = new Response(new Uint8Array(packed), { headers });
    }
    const fail = state.phase === "body-failure";
    const source = selected.response.body;
    if (source === null) return selected.response;
    const reader = source.getReader();
    const progress = { started: false, settled: false };
    const wrapped = new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (!progress.started) {
              progress.started = true;
              state.started += 1;
              state.active += 1;
              state.peak = Math.max(state.peak, state.active);
              if (fail) {
                await Effect.runPromise(Effect.sleep("50 millis"));
                progress.settled = true;
                state.completed += 1;
                state.active -= 1;
                await reader.cancel();
                controller.error(new Error("Fixture plan body failure"));
                return;
              }
              await Effect.runPromise(Effect.sleep("1600 millis"));
            }
            const chunk = await reader.read();
            if (chunk.done) {
              progress.settled = true;
              state.completed += 1;
              state.active -= 1;
              controller.close();
            } else controller.enqueue(Schema.decodeUnknownSync(Schema.Uint8Array)(chunk.value));
          },
          cancel(reason) {
            if (progress.started && !progress.settled) {
              progress.settled = true;
              state.completed += 1;
              state.active -= 1;
            }
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      ),
      selected.response,
    );
    const body = wrapped.body;
    if (body !== null) {
      const cancel = body.cancel.bind(body);
      Object.defineProperty(body, "cancel", {
        value: (reason?: unknown) => {
          state.cancelled += 1;
          return cancel(reason);
        },
      });
    }
    return wrapped;
  };
  return cache;
};

async function control(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/fixture/arm") {
    const input = Schema.decodeUnknownSync(Arm)(await request.json());
    clearImmutableCache(`namespaces/${input.namespace}`);
    state.phase = input.phase;
    state.expanded = input.expanded ?? false;
    state.started = 0;
    state.completed = 0;
    state.lookups = 0;
    state.active = 0;
    state.peak = 0;
    state.cancelled = 0;
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/fixture/clear") {
    const namespace = Schema.decodeUnknownSync(NamespaceName)(await request.json());
    clearImmutableCache(`namespaces/${namespace}`);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/fixture/release") {
    state.phase = "none";
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/fixture/state")
    return new Response(null, {
      headers: {
        "x-fixture-started": String(state.started),
        "x-fixture-completed": String(state.completed),
        "x-fixture-published": String(state.published),
        "x-fixture-lookups": String(state.lookups),
        "x-fixture-active": String(state.active),
        "x-fixture-peak": String(state.peak),
        "x-fixture-cancelled": String(state.cancelled),
      },
    });
  return undefined;
}

export class SearchNamespace extends ProductionNamespace {
  override async fetch(request: Request) {
    const response = await control(request);
    if (response !== undefined) return response;
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/fixture/") && url.searchParams.get("target") === "coordinator") {
      const namespace = Schema.decodeUnknownSync(NamespaceName)(url.searchParams.get("namespace"));
      return env.NAMESPACES.get(env.NAMESPACES.idFromName(namespace)).fetch(request);
    }
    const response = await control(request);
    if (response !== undefined) return response;
    return worker.fetch(request, env, ctx);
  },
};
