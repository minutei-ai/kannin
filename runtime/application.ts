import { Cause, Effect, Schema, Schedule, Semaphore } from "effect";
import { timingSafeEqual } from "node:crypto";
import { ObjectStore } from "../src/object-store";
import { ObjectBucket } from "./object-bucket";
import { NamespaceCoordinators } from "./namespace-coordinators";
import { createApplication } from "../src/core/application";
import { createStorage } from "../src/core/storage";
import { decodeRoot } from "../src/manifest";
import { namespaceCatalogPrefix, namespaceCatalogReadyKey } from "../src/namespaces";
import { ErrorBody, IndexMessage, NamespaceName, VectorMessage } from "../src/protocol";
import type { CacheProvider, Environment, SearchRuntime } from "../src/platform";
import type { RpcCommand } from "../src/protocol";
import { disabledCache } from "./cache/client";

export interface PortableOptions {
  readonly token: string;
  readonly scope: string;
  readonly module: WebAssembly.Module;
  readonly cache?: CacheProvider;
}
const conflictMessage = "R2 manifest changed; retry the operation with the same requestId";

export const portableApplication = Effect.fn("kannin.portableApplication")(function* (
  options: PortableOptions,
) {
  const run = Effect.runPromiseWith(yield* Effect.context<ObjectStore>());
  const objects = yield* ObjectStore;
  const bucket = new ObjectBucket(objects);
  const background = new Set<Promise<unknown>>();
  const active = { value: true };
  const work = Semaphore.makeUnsafe(4);
  const queued = new Map<
    string,
    { message: typeof IndexMessage.Type | typeof VectorMessage.Type; again: boolean }
  >();
  function waitUntil(promise: Promise<unknown>) {
    const guarded = promise.catch((cause: unknown) =>
      run(Effect.logError("kannin.background", cause)),
    );
    background.add(guarded);
    void guarded.finally(() => background.delete(guarded));
  }
  async function send(message: unknown) {
    if (!active.value) return;
    const input = Schema.decodeUnknownSync(Schema.Union([VectorMessage, IndexMessage]), {
      onExcessProperty: "error",
    })(message);
    const kind = { value: "index" };
    if ("log" in input) kind.value = "vector";
    const key = `${kind.value}:${input.namespace}`;
    const pending = queued.get(key);
    if (pending !== undefined) {
      pending.message = input;
      pending.again = true;
      return;
    }
    if (queued.size >= 1024)
      throw new Cause.UnknownError(
        new Error("Background dispatch capacity exceeded; canonical outbox remains pending"),
      );
    const entry = { message: input, again: false };
    queued.set(key, entry);
    waitUntil(
      run(
        work
          .withPermit(
            Effect.gen(function* () {
              do {
                entry.again = false;
                yield* Effect.gen(function* () {
                  const response = { retry: false };
                  yield* Effect.tryPromise(() =>
                    app.handler.queue(
                      {
                        messages: [
                          {
                            body: entry.message,
                            ack: () => undefined,
                            retry: () => {
                              response.retry = true;
                            },
                          },
                        ],
                      },
                      env,
                    ),
                  );
                  if (response.retry)
                    return yield* new Cause.UnknownError(
                      new Error("Background operation remains pending"),
                    );
                  return undefined;
                }).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced("100 millis") }));
              } while (entry.again && active.value);
            }),
          )
          .pipe(Effect.ensuring(Effect.sync(() => queued.delete(key)))),
      ),
    );
  }
  const env: Environment = {
    API_TOKEN: options.token,
    STORAGE: bucket,
    STORAGE_CACHE_SCOPE: options.scope,
    VECTOR_JOBS: { send },
    INDEX_JOBS: { send },
  };
  const actors = new NamespaceCoordinators(
    (ownedWaitUntil) => new app.SearchNamespace({ waitUntil: ownedWaitUntil }, env),
    waitUntil,
  );
  const runtime: SearchRuntime = {
    env,
    cache: options.cache ?? disabledCache,
    engineModule: options.module,
    version: "portable-v1",
    freshRoots: true,
    immutableIdentity: (digest) => `${digest}-${crypto.randomUUID()}`,
    engineName: "rust-wasm-object-storage",
    vectorName: "rust-wasm-object-storage",
    waitUntil,
    equalBytes: (left, right) =>
      left.byteLength === right.byteLength &&
      timingSafeEqual(
        new Uint8Array(left.buffer, left.byteOffset, left.byteLength),
        new Uint8Array(right.buffer, right.byteOffset, right.byteLength),
      ),
    namespace: (name) => ({
      async fetch(input, init) {
        const request = new Request(input, init);
        const body = await request.arrayBuffer();
        for (const attempt of [0, 1, 2, 3, 4, 5]) {
          const response = await actors.run(name, (actor) =>
            actor.fetch(
              new Request(request.url, {
                method: request.method,
                headers: request.headers,
                ...(body.byteLength > 0 && { body }),
              }),
            ),
          );
          if (response.status !== 409 || attempt === 5) return response;
          const error = Schema.decodeUnknownSync(ErrorBody)(await response.clone().json());
          if (error.error !== conflictMessage) return response;
          await response.body?.cancel();
          await run(Effect.sleep(`${(attempt + 1) * 10} millis`));
        }
        return new Response(null, { status: 503 });
      },
      async execute(command: typeof RpcCommand.Encoded) {
        for (const attempt of [0, 1, 2, 3, 4, 5]) {
          const reply = await actors.run(name, (actor) => actor.execute(command));
          if (
            reply._tag !== "Failure" ||
            reply.error.status !== 409 ||
            reply.error.message !== conflictMessage ||
            attempt === 5
          )
            return reply;
          await run(Effect.sleep(`${(attempt + 1) * 10} millis`));
        }
        return actors.run(name, (actor) => actor.execute(command));
      },
    }),
    segments: (input) => ({
      fetch: (request, init) =>
        new app.Segments({ waitUntil, props: input.props }, env).fetch(new Request(request, init)),
    }),
    terms: (input) => ({
      fetch: (request, init) =>
        new app.Terms({ waitUntil, props: input.props }, env).fetch(new Request(request, init)),
    }),
  };
  const app = createApplication(runtime, createStorage(runtime));
  async function recover() {
    const cursor: { value: string | undefined } = { value: undefined };
    do {
      const page = await bucket.list({
        prefix: "namespaces/",
        delimiter: "/",
        ...(cursor.value !== undefined && { cursor: cursor.value }),
      });
      for (const prefix of page.delimitedPrefixes) {
        const namespace = Schema.decodeSync(NamespaceName)(prefix.slice("namespaces/".length, -1));
        const object = await bucket.get(`${prefix}root.json`);
        if (object === null) continue;
        const root = decodeRoot(await object.text());
        await bucket.put(`${namespaceCatalogPrefix}${namespace}`, "", {
          onlyIf: { etagDoesNotMatch: "*" },
        });
        for (const job of root.vectorJobs) await send({ namespace, ...job });
        if (root.segments.length > 1) await send({ namespace });
      }
      if (page.truncated) cursor.value = page.cursor;
      else cursor.value = undefined;
    } while (cursor.value !== undefined);
    await bucket.put(namespaceCatalogReadyKey, "");
  }
  async function drain() {
    while (background.size > 0) await Promise.all(background);
  }
  async function dispose() {
    await drain();
    active.value = false;
    actors.clear();
  }
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  yield* Effect.tryPromise(recover);
  return {
    binding: new app.KanninRpc({ waitUntil }, env),
    fetch: (request: Request) => app.handler.fetch(request, env, { waitUntil }),
    dispose,
    drain,
    recover,
  };
});
