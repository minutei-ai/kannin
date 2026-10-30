import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Layer, Schedule } from "effect";
import { portableApplication } from "../runtime/application";
import { ObjectStore } from "../src/object-store";
import type { ObjectReadOptions } from "../src/protocol";
import { objectStoreFixtureLive } from "./object-store-fixture";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);
const services = objectStoreFixtureLive;
const names = Array.from({ length: 5 }, (_, index) => `warming-${index}`);
const auth = { authorization: "Bearer warm-admission-token" };
const hint = (namespace: string) =>
  new Request(`http://localhost/v1/namespaces/${namespace}/hint_cache_warm`, { headers: auth });

test("warming deduplicates namespaces and bounds pending real-storage reads", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const writer = yield* portableApplication({
          token: "warm-admission-token",
          scope: "warm-admission",
          module,
        }).pipe(Effect.provideContext(context));
        for (const namespace of names) {
          const response = yield* Effect.tryPromise(() =>
            writer.fetch(
              new Request(`http://localhost/v1/namespaces/${namespace}/write`, {
                method: "POST",
                headers: { ...auth, "content-type": "application/json" },
                body: JSON.stringify({
                  requestId: "seed",
                  upserts: [{ id: "one", text: namespace, attributes: {} }],
                  deletes: [],
                }),
              }),
            ),
          );
          expect(response.status).toBe(200);
          yield* Effect.tryPromise(() => response.arrayBuffer());
        }
        yield* Effect.promise(writer.dispose);
        const objects = yield* ObjectStore.pipe(Effect.provideContext(context));
        const gate = yield* Deferred.make<void>();
        const observed = new Set<string>();
        const blocked = ObjectStore.of({
          ...objects,
          read: Effect.fn("kannin.warmTest.read")(function* (
            key: string,
            options?: typeof ObjectReadOptions.Type,
          ) {
            for (const namespace of names) {
              if (!key.includes(`namespaces/${namespace}/segments/`)) continue;
              observed.add(namespace);
              yield* Deferred.await(gate);
              break;
            }
            return yield* objects.read(key, options);
          }),
        });
        const reader = yield* portableApplication({
          token: "warm-admission-token",
          scope: "warm-admission",
          module,
        }).pipe(Effect.provideService(ObjectStore, blocked), Effect.provideContext(context));
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined).pipe(Effect.asVoid));
        for (const namespace of names.slice(0, 4)) {
          const response = yield* Effect.tryPromise(() => reader.fetch(hint(namespace)));
          expect(response.status).toBe(202);
          yield* Effect.tryPromise(() => response.arrayBuffer());
        }
        yield* Effect.suspend(() => {
          if (observed.size === 4) return Effect.void;
          return new Cause.UnknownError(new Error("Admitted warming reads have not started"));
        }).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }));
        const repeated = yield* Effect.tryPromise(() => reader.fetch(hint("warming-0")));
        expect(repeated.status).toBe(202);
        yield* Effect.tryPromise(() => repeated.arrayBuffer());
        const full = yield* Effect.tryPromise(() => reader.fetch(hint("warming-4")));
        expect(full.status).toBe(503);
        yield* Effect.tryPromise(() => full.arrayBuffer());
        expect(observed.has("warming-4")).toBe(false);
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.promise(reader.drain);
        const next = yield* Effect.tryPromise(() => reader.fetch(hint("warming-4")));
        expect(next.status).toBe(202);
        yield* Effect.tryPromise(() => next.arrayBuffer());
        yield* Effect.promise(reader.drain);
        expect(observed.size).toBe(5);
      }),
    ),
  );
}, 30000);
