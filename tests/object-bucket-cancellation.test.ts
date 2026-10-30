import { expect, test } from "bun:test";
import { Deferred, Effect, Option, Stream } from "effect";
import { ObjectBucket } from "../runtime/object-bucket";
import { ObjectStore } from "../src/object-store";
import { ObjectStoreFailure } from "../src/protocol";
import type { StoredObject } from "../src/object-store";

function storeWith(read: ReturnType<typeof ObjectStore.of>["read"]) {
  return ObjectStore.of({
    read,
    head: () => Effect.die(new Error("Unexpected head operation")),
    list: () => Effect.die(new Error("Unexpected list operation")),
    remove: () => Effect.die(new Error("Unexpected remove operation")),
    write: () => Effect.die(new Error("Unexpected write operation")),
  });
}

const metadata: StoredObject["metadata"] = {
  key: "fixture",
  etag: "fixture-etag",
  size: 1,
  uploaded: new Date(0),
  customMetadata: {},
};
function observe(pending: Promise<unknown>) {
  return pending.then(
    (value) => ({ status: "resolved", value }),
    (cause: unknown) => ({ status: "rejected", cause }),
  );
}
const waitFor = (gate: Deferred.Deferred<void>) =>
  Effect.runPromise(Deferred.await(gate).pipe(Effect.timeout("1 second")));

test("bucket cancellation interrupts a blocked object-store acquisition", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const stopped = Deferred.makeUnsafe<void>();
  const controller = new AbortController();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => controller.abort());
  const bucket = new ObjectBucket(
    storeWith(() =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(stopped, undefined)),
      ),
    ),
  );
  const pending = observe(bucket.get("fixture", { signal: controller.signal }));
  await waitFor(entered);
  controller.abort(new Error("request cancelled"));
  expect((await pending).status).toBe("rejected");
  await waitFor(stopped);
});

test("bucket cancellation stops streaming bodies and rejects partial text and byte results", async () => {
  for (const method of ["text", "arrayBuffer"] as const) {
    const entered = Deferred.makeUnsafe<void>();
    const stopped = Deferred.makeUnsafe<void>();
    const controller = new AbortController();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => controller.abort());
    const body = Stream.make(new Uint8Array([65])).pipe(
      Stream.concat(
        Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
      ),
      Stream.ensuring(Deferred.succeed(stopped, undefined)),
    );
    const bucket = new ObjectBucket(storeWith(() => Effect.succeedSome({ metadata, body })));
    const object = await bucket.get("fixture", { signal: controller.signal });
    if (object === null) throw new Error("Missing body fixture");
    const pending = observe(object[method]());
    await waitFor(entered);
    const reason = new Error("body cancelled");
    controller.abort(reason);
    const outcome = await pending;
    expect(outcome.status).toBe("rejected");
    if (!("cause" in outcome)) throw new Error("Cancelled body returned a partial result");
    expect(outcome.cause).toBe(reason);
    await waitFor(stopped);
  }
});

test("already cancelled bucket reads perform no backend work", async () => {
  const reads = { count: 0 };
  const bucket = new ObjectBucket(
    storeWith(() =>
      Effect.sync(() => {
        reads.count += 1;
        return Option.none();
      }),
    ),
  );
  const controller = new AbortController();
  const reason = new Error("cancelled before admission");
  controller.abort(reason);
  expect(
    await bucket.get("fixture", { signal: controller.signal }).catch((cause: unknown) => cause),
  ).toBe(reason);
  expect(reads.count).toBe(0);
});

test("native object-store failures preserve their identity at the bucket boundary", async () => {
  const cause = new DOMException("backend transport aborted", "AbortError");
  const failure = new ObjectStoreFailure({ operation: "read", key: "fixture", cause });
  const bucket = new ObjectBucket(storeWith(() => Effect.fail(failure)));
  expect(await bucket.get("fixture").catch((failureCause: unknown) => failureCause)).toBe(failure);
  expect(failure.cause).toBe(cause);
});
