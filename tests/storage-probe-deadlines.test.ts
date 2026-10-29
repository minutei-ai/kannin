import { expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { ObjectStore } from "../src/object-store";
import { checkObjectStore } from "../tooling/object-store-conformance";

test("the initial storage probe request expires without waiting for a stalled backend", async () => {
  const scenario = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const observed = { heads: 0, deletes: 0 };
    const stalled = ObjectStore.of({
      read: () => Effect.succeedNone,
      head: () =>
        Effect.sync(() => {
          observed.heads += 1;
          return Option.none();
        }),
      list: () => Effect.succeed({ objects: [], delimitedPrefixes: [], truncated: false as const }),
      write: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      remove: () =>
        Effect.sync(() => {
          observed.deletes += 1;
        }),
    });
    const fiber = yield* checkObjectStore().pipe(
      Effect.provideService(ObjectStore, stalled),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("5 seconds");
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(observed.heads).toBe(1);
    expect(observed.deletes).toBe(0);
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Layer.build(TestClock.layer());
        yield* scenario.pipe(Effect.provideContext(clock));
      }),
    ),
  );
}, 5000);
