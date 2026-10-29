import { expect, test } from "bun:test";
import { Deferred, Effect, Option, Stream } from "effect";
import { ObjectBucket } from "../runtime/object-bucket";
import { createApplication } from "../src/core/application";
import { createStorage } from "../src/core/storage";
import { ObjectStore } from "../src/object-store";
import type { SearchRuntime } from "../src/platform";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);

test("an immutable origin fill survives cancellation of its cache lookup caller", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const reads = { count: 0, interrupted: false };
  const bytes = new Uint8Array([255, 0, 12, 200]);
  const key = "namespaces/cache-cancellation/segments/fixture.rsix";
  const bucket = new ObjectBucket(
    ObjectStore.of({
      read: () =>
        Effect.gen(function* () {
          reads.count += 1;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                reads.interrupted = true;
              }),
            ),
          );
          return Option.some({
            metadata: {
              key,
              etag: "fixture",
              size: bytes.length,
              uploaded: new Date(0),
              customMetadata: {},
            },
            body: Stream.make(bytes),
          });
        }),
      head: () => Effect.die("Unexpected head"),
      list: () => Effect.die("Unexpected list"),
      write: () => Effect.die("Unexpected write"),
      remove: () => Effect.die("Unexpected remove"),
    }),
  );
  const retained = new Map<string, Response>();
  const background: Array<Promise<unknown>> = [];
  const waitUntil = (pending: Promise<unknown>) => {
    background.push(pending);
  };
  const runtime: SearchRuntime = {
    env: {
      API_TOKEN: "fixture-token",
      STORAGE: bucket,
      STORAGE_CACHE_SCOPE: "fixture-bucket",
      VECTOR_JOBS: { send: async () => undefined },
      INDEX_JOBS: { send: async () => undefined },
    },
    cache: {
      open: async () => ({
        match: async (input) => retained.get(input.toString())?.clone(),
        put: async (input, response) => {
          retained.set(input.toString(), response.clone());
        },
        delete: async (input) => retained.delete(input.toString()),
      }),
    },
    engineModule: module,
    version: "fixture",
    freshRoots: true,
    immutableIdentity: (digest) => digest,
    engineName: "rust-wasm-object-storage",
    vectorName: "rust-wasm-object-storage",
    equalBytes: () => false,
    namespace: () => {
      throw new Error("Unexpected namespace dispatch");
    },
    segments: () => {
      throw new Error("Unexpected segment dispatch");
    },
    terms: () => {
      throw new Error("Unexpected term dispatch");
    },
    waitUntil,
  };
  const application = createApplication(runtime, createStorage(runtime));
  const handler = new application.Segments(
    { waitUntil, props: { bucket: "fixture-bucket", format: "compact-json-v2" } },
    runtime.env,
  );
  const url = new URL("http://segments.internal/range");
  url.searchParams.set("key", key);
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", String(bytes.length));
  const controller = new AbortController();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    controller.abort();
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Promise.allSettled(background);
  });
  const pending = handler.fetch(new Request(url, { signal: controller.signal }));
  cleanup.defer(async () => {
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await pending.then(
      async (response) => {
        if (!response.bodyUsed) await response.body?.cancel();
      },
      () => undefined,
    );
  });
  await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("1 second")));
  controller.abort(new Error("cache lookup budget expired"));
  await Effect.runPromise(Deferred.succeed(release, undefined));
  const response = await pending;
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  await Promise.all(background);
  const cached = await handler.fetch(new Request(url));
  expect(cached.headers.get("x-raio-cache")).toBe("api-hit");
  expect(new Uint8Array(await cached.arrayBuffer())).toEqual(bytes);
  expect(reads).toEqual({ count: 1, interrupted: false });
});
