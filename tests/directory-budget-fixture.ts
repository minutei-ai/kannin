import { Effect, Match, Option, Schema } from "effect";
import { exports } from "cloudflare:workers";
import { Segments as CachedSegments, SearchNamespace as Namespace } from "../src/worker";
import {
  range,
  cacheUsage,
  withDirectory,
  acquireDirectoryFrame,
  waitDirectoryFrame,
} from "../src/storage";
import type { Env } from "../alchemy.run";
import { DirectoryBudgetInput } from "./range-contract";
import { Directory, CompressedDirectory } from "../dist/wasm/raio_engine";

const state = {
  cacheCompleted: 0,
  active: 0,
  peak: 0,
  started: 0,
  completed: 0,
  holdCache: false,
  cacheDelay: 5000,
  bodyDelay: 80,
  directoryBodyDelay: 80,
  holdDirectoryBody: false,
  directoryHeaderDelay: 0,
  failDirectoryCache: false,
  failDirectoryWrites: false,
  rejectedWrites: 0,
  canonicalReads: 0,
  directoryParses: 0,
  canonicalParses: 0,
  corruptDirectory: false,
};
const parseDirectory = Directory.compressed.bind(Directory);
const parseCanonical = Directory.canonical.bind(Directory);
Object.defineProperty(Directory, "canonical", {
  value: (...input: Parameters<typeof Directory.canonical>) => {
    state.canonicalParses += 1;
    return parseCanonical(...input);
  },
});
Object.defineProperty(Directory, "compressed", {
  value: (...input: Parameters<typeof Directory.compressed>) => {
    state.directoryParses += 1;
    return parseDirectory(...input);
  },
});
const parseFrame = Object.getOwnPropertyDescriptors(CompressedDirectory.prototype).directory.value;
if (parseFrame === undefined) throw new Error("Missing native compressed-directory decoder");
Object.defineProperty(CompressedDirectory.prototype, "directory", {
  value(this: CompressedDirectory, ...input: Parameters<CompressedDirectory["directory"]>) {
    state.directoryParses += 1;
    return parseFrame.call(this, ...input);
  },
});
const wrapped = new WeakSet<R2Bucket>();

export class Segments extends CachedSegments {
  override async fetch(request: Request) {
    if (new URL(request.url).searchParams.has("direct-origin")) return super.fetch(request);
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
    if (state.holdCache)
      await Effect.runPromise(
        Effect.sleep("10 millis").pipe(Effect.repeat({ while: () => state.holdCache })),
      );
    else await Effect.runPromise(Effect.sleep(state.cacheDelay));
    const response = await super.fetch(request);
    state.cacheCompleted += 1;
    if (
      state.corruptDirectory &&
      response.ok &&
      new URL(request.url).pathname === "/directory-v6"
    ) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(12, 0xffffffff, true);
      return new Response(bytes, response);
    }
    return response;
  }
}

async function probe(request: Request, env: Env) {
  if (!wrapped.has(env.STORAGE)) {
    wrapped.add(env.STORAGE);
    const get = env.STORAGE.get.bind(env.STORAGE);
    const put = env.STORAGE.put.bind(env.STORAGE);
    Object.defineProperty(env.STORAGE, "put", {
      value: (...args: Parameters<R2Bucket["put"]>) => {
        if (state.failDirectoryWrites && args[0].startsWith("cache/directory-v6/")) {
          state.rejectedWrites += 1;
          return Promise.reject(new Error("Injected directory cache publication failure"));
        }
        return put(...args);
      },
    });
    Object.defineProperty(env.STORAGE, "get", {
      value: async (...args: Parameters<R2Bucket["get"]>) => {
        if (state.directoryHeaderDelay > 0 && args[0].startsWith("cache/directory-v6/"))
          await Effect.runPromise(Effect.sleep(state.directoryHeaderDelay));
        if (state.failDirectoryCache && args[0].startsWith("cache/directory-v6/"))
          return Promise.reject(new Error("Injected directory cache read failure"));
        if (args[0].startsWith("namespaces/")) state.canonicalReads += 1;
        const object = await get(...args);
        if (object === null || !("body" in object)) return object;
        const read = object.arrayBuffer.bind(object);
        Object.defineProperty(object, "arrayBuffer", {
          value: async () => {
            state.started += 1;
            state.active += 1;
            state.peak = Math.max(state.peak, state.active);
            return Effect.runPromise(
              Match.value(
                state.holdDirectoryBody && args[0].startsWith("cache/directory-v6/"),
              ).pipe(
                Match.when(true, () =>
                  Effect.sleep("10 millis").pipe(
                    Effect.repeat({ while: () => state.holdDirectoryBody }),
                  ),
                ),
                Match.orElse(() =>
                  Effect.sleep(
                    Match.value(args[0].startsWith("cache/directory-v6/")).pipe(
                      Match.when(true, () => state.directoryBodyDelay),
                      Match.orElse(() => state.bodyDelay),
                    ),
                  ),
                ),
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
  if (new URL(request.url).pathname === "/cache-failure") {
    state.failDirectoryCache = true;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/hold-cache") {
    state.holdCache = true;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/release-cache") {
    state.holdCache = false;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/corrupt-directory") {
    state.corruptDirectory = true;
    state.cacheDelay = 0;
    state.failDirectoryWrites = true;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/cache-write-failure") {
    state.failDirectoryWrites = true;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/late-frame") {
    state.cacheDelay = 0;
    state.directoryBodyDelay = 320;
    state.bodyDelay = 1000;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/cache-stall") {
    state.directoryBodyDelay = 1600;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/hold-directory-body") {
    state.holdDirectoryBody = true;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/release-directory-body") {
    state.holdDirectoryBody = false;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/fast-origin") {
    state.cacheDelay = 0;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/frame-burst") {
    state.directoryBodyDelay = 30;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname === "/frame-absent") {
    state.directoryHeaderDelay = 80;
    return new Response(null, { status: 204 });
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
        "x-canonical-reads": String(state.canonicalReads),
        "x-rejected-writes": String(state.rejectedWrites),
        "x-directory-parses": String(state.directoryParses),
        "x-canonical-parses": String(state.canonicalParses),
        "x-directory-r2-reads": String(cacheUsage().directoryR2CacheReads),
        "x-directory-r2-bytes": String(cacheUsage().directoryR2CacheBytes),
        "x-directory-publications": String(cacheUsage().directoryR2CachePublications),
      },
    });
  const input = Schema.decodeUnknownSync(DirectoryBudgetInput)(await request.json());
  if (new URL(request.url).pathname === "/frame") {
    const result = await Effect.runPromise(
      acquireDirectoryFrame(input.key, input.length).pipe(
        Effect.flatMap(waitDirectoryFrame),
        Effect.map(Option.flatten),
      ),
    );
    if (Option.isNone(result)) return new Response(null, { status: 503 });
    return new Response(new Uint8Array(result.value));
  }
  if (
    new URL(request.url).pathname === "/decoded" ||
    new URL(request.url).pathname === "/decoded-canonical" ||
    new URL(request.url).pathname === "/decoded-r2"
  ) {
    const before = cacheUsage();
    const responses = await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: input.count }, () => input),
        (entry) =>
          withDirectory(
            entry.key,
            entry.length,
            (directory) =>
              Effect.sync(() => {
                const after = cacheUsage();
                return new Response(directory.terms('["unique3711"]'), {
                  headers: {
                    "x-directory-hits": String(
                      after.directoryCacheHits - before.directoryCacheHits,
                    ),
                    "x-directory-bytes": String(after.directoryCacheChargedBytes),
                  },
                });
              }).pipe(
                Effect.tap(() => {
                  if (new URL(request.url).pathname === "/decoded-canonical")
                    return Effect.tryPromise(() => env.STORAGE.head(entry.key)).pipe(Effect.asVoid);
                  return Effect.void;
                }),
              ),
            undefined,
            new URL(request.url).pathname === "/decoded-canonical",
            new URL(request.url).pathname === "/decoded-r2",
          ),
        { concurrency: "unbounded" },
      ),
    );
    const first = responses[0];
    if (first === undefined) return new Response(null, { status: 500 });
    return first;
  }
  if (new URL(request.url).pathname === "/origin") {
    const url = new URL("https://segments.internal/directory-v6");
    url.searchParams.set("key", input.key);
    url.searchParams.set("offset", String(input.offset));
    url.searchParams.set("length", String(input.length));
    url.searchParams.set("direct-origin", "1");
    return exports
      .Segments({ props: { bucket: env.STORAGE_CACHE_SCOPE, format: "compact-json-v2" } })
      .fetch(url);
  }
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
            "x-directory-r2-hits": String(after.directoryR2CacheHits - before.directoryR2CacheHits),
            "x-directory-r2-bytes": String(
              after.directoryR2CacheBytes - before.directoryR2CacheBytes,
            ),
            "x-directory-r2-rejected": String(
              after.directoryR2CacheRejected - before.directoryR2CacheRejected,
            ),
            "x-directory-r2-timeouts": String(
              after.directoryR2CacheTimeouts - before.directoryR2CacheTimeouts,
            ),
            "x-directory-r2-origins": String(
              after.directoryR2CacheOriginResponses - before.directoryR2CacheOriginResponses,
            ),
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
