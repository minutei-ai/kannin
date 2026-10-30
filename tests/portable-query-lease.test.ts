import { expect, test } from "bun:test";
import { Deferred, Effect, Layer, Schema } from "effect";
import { portableApplication } from "../runtime/application";
import { ObjectStore } from "../src/object-store";
import { CollectionResult, QueryResult } from "../src/protocol";
import type { ObjectReadOptions } from "../src/protocol";
import { objectStoreFixtureLive } from "./object-store-fixture";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);
const token = "portable-query-lease-token";
const namespace = "portable-query-lease";
function request(operation: string, body: unknown) {
  return new Request(`http://localhost/v1/namespaces/${namespace}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("portable reset and collection preserve a blocked reader until its captured Root is released", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(objectStoreFixtureLive);
        const writer = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const seeded = yield* Effect.tryPromise(() =>
          writer.fetch(
            request("write", {
              requestId: "seed",
              upserts: [{ id: "old", text: "captured old", attributes: {} }],
              deletes: [],
            }),
          ),
        );
        expect(seeded.status).toBe(200);
        yield* Effect.tryPromise(() => seeded.arrayBuffer());
        yield* Effect.promise(writer.dispose);
        const objects = yield* ObjectStore.pipe(Effect.provideContext(context));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const armed = { value: true };
        const blocked = ObjectStore.of({
          ...objects,
          read: Effect.fn("kannin.portableLease.read")(function* (
            key: string,
            options?: typeof ObjectReadOptions.Type,
          ) {
            if (armed.value && key.startsWith(`namespaces/${namespace}/segments/`)) {
              armed.value = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return yield* objects.read(key, options);
          }),
        });
        const reader = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideService(ObjectStore, blocked),
          Effect.provideContext(context),
        );
        const pending = reader.fetch(
          request("query", {
            kind: "text",
            text: "captured",
            topK: 10,
            filters: [],
            consistency: "strong",
            minimumSequence: 1,
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(release, undefined);
            yield* Effect.promise(async () => {
              const response = await pending;
              if (!response.bodyUsed) await response.arrayBuffer();
            });
          }),
        );
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
        const reset = yield* Effect.tryPromise(() =>
          reader.fetch(
            request("write", {
              requestId: "reset",
              reset: true,
              upserts: [{ id: "new", text: "current new", attributes: {} }],
              deletes: [],
            }),
          ),
        );
        expect(reset.status).toBe(200);
        yield* Effect.tryPromise(() => reset.arrayBuffer());
        const protectedResponse = yield* Effect.tryPromise(() =>
          reader.fetch(request("collect", {})),
        );
        expect(protectedResponse.status).toBe(200);
        const protectedObjects = yield* Effect.tryPromise(() => protectedResponse.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CollectionResult)),
        );
        expect(protectedObjects.pinned).toBe(4);
        expect(protectedObjects.deleted).toBe(0);
        yield* Deferred.succeed(release, undefined);
        const capturedResponse = yield* Effect.tryPromise(() => pending);
        expect(capturedResponse.status).toBe(200);
        const captured = yield* Effect.tryPromise(() => capturedResponse.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(captured.sequence).toBe(1);
        expect(captured.rows.map((row) => row.id)).toEqual(["old"]);
        const collectedResponse = yield* Effect.tryPromise(() =>
          reader.fetch(request("collect", {})),
        );
        expect(collectedResponse.status).toBe(200);
        const unprotected = yield* Effect.tryPromise(() => collectedResponse.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CollectionResult)),
        );
        expect(unprotected.pinned).toBe(2);
        const currentResponse = yield* Effect.tryPromise(() =>
          reader.fetch(
            request("query", {
              kind: "text",
              text: "current",
              topK: 10,
              filters: [],
              consistency: "strong",
              minimumSequence: 2,
            }),
          ),
        );
        expect(currentResponse.status).toBe(200);
        const current = yield* Effect.tryPromise(() => currentResponse.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(current.sequence).toBe(2);
        expect(current.rows.map((row) => row.id)).toEqual(["new"]);
      }),
    ),
  );
}, 30000);
