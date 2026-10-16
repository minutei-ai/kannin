import { Effect, Schema } from "effect";
import { Segments as CachedSegments, SearchNamespace as Namespace } from "../src/worker";
import { range, cacheUsage } from "../src/storage";
import type { Env } from "../alchemy.run";
import { DirectoryBudgetInput } from "./range-contract";

const state = {
  cacheCompleted: 0,
  active: 0,
  peak: 0,
  started: 0,
  completed: 0,
  cacheDelay: 5000,
  bodyDelay: 80,
};
const wrapped = new WeakSet<R2Bucket>();

export class Segments extends CachedSegments {
  override async fetch(request: Request) {
    const key = new URL(request.url).searchParams.get("key");
    if (key?.endsWith("/body.rsix") === true) {
      const response = await super.fetch(request);
      const body = response.body;
      if (body === null) return response;
      const stall = { delayed: false };
      return new Response(
        body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            async transform(chunk, controller) {
              if (!stall.delayed) {
                stall.delayed = true;
                await Effect.runPromise(Effect.sleep(state.cacheDelay));
                state.cacheCompleted += 1;
              }
              controller.enqueue(chunk);
            },
          }),
        ),
        response,
      );
    }
    await Effect.runPromise(Effect.sleep(state.cacheDelay));
    const response = await super.fetch(request);
    state.cacheCompleted += 1;
    return response;
  }
}

async function probe(request: Request, env: Env) {
  if (!wrapped.has(env.STORAGE)) {
    wrapped.add(env.STORAGE);
    const get = env.STORAGE.get.bind(env.STORAGE);
    Object.defineProperty(env.STORAGE, "get", {
      value: async (...args: Parameters<R2Bucket["get"]>) => {
        const object = await get(...args);
        if (object === null || !("body" in object)) return object;
        const read = object.arrayBuffer.bind(object);
        Object.defineProperty(object, "arrayBuffer", {
          value: async () => {
            state.started += 1;
            state.active += 1;
            state.peak = Math.max(state.peak, state.active);
            return Effect.runPromise(
              Effect.sleep(state.bodyDelay).pipe(
                Effect.andThen(Effect.tryPromise(read)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    state.completed += 1;
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    state.active -= 1;
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
  if (new URL(request.url).pathname === "/race") {
    state.cacheDelay = 400;
    state.bodyDelay = 1600;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/busy") {
    state.bodyDelay = 1600;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/state")
    return new Response(null, {
      headers: {
        "x-cache-completed": String(state.cacheCompleted),
        "x-r2-started": String(state.started),
        "x-r2-completed": String(state.completed),
        "x-r2-active": String(state.active),
        "x-r2-peak": String(state.peak),
      },
    });
  const input = Schema.decodeUnknownSync(DirectoryBudgetInput)(await request.json());
  const before = cacheUsage();
  return Effect.runPromise(
    Effect.tryPromise(() =>
      Promise.all(
        Array.from({ length: input.count }, () =>
          range(input.key, input.offset, input.length, true),
        ),
      ),
    ).pipe(
      Effect.map((bodies) => {
        const first = bodies[0];
        if (first === undefined) return new Response(null, { status: 500 });
        const after = cacheUsage();
        return new Response(new Uint8Array(first), {
          headers: {
            "x-distinct-bodies": String(new Set(bodies).size),
            "x-cache-completed": String(state.cacheCompleted),
            "x-timeouts": String(after.rangeCacheTimeouts - before.rangeCacheTimeouts),
            "x-fallbacks": String(after.rangeR2FallbackReads - before.rangeR2FallbackReads),
            "x-fallback-bytes": String(after.rangeR2FallbackBytes - before.rangeR2FallbackBytes),
          },
        });
      }),
      Effect.orElseSucceed(() => new Response(null, { status: 503 })),
    ),
  );
}

export class SearchNamespace extends Namespace {
  override fetch(request: Request) {
    return probe(request, this.env);
  }
}

export default { fetch: probe };
