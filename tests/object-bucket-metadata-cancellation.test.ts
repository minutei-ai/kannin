import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { ObjectBucket } from "../runtime/object-bucket";
import { ObjectStore } from "../src/object-store";

test("head, list and conditional reads cancel blocked metadata work", async () => {
  for (const operation of ["head", "list", "conditional"] as const) {
    const entered = Deferred.makeUnsafe<void>();
    const stopped = Deferred.makeUnsafe<void>();
    const controller = new AbortController();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => controller.abort());
    const blocked = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Deferred.succeed(stopped, undefined)),
    );
    const bucket = new ObjectBucket(
      ObjectStore.of({
        head: () => blocked,
        list: () => blocked,
        read: () => Effect.die("Conditional read bypassed its metadata check"),
        write: () => Effect.die("Unexpected write"),
        remove: () => Effect.die("Unexpected remove"),
      }),
    );
    const pending = {
      head: () => bucket.head("fixture", controller.signal),
      list: () => bucket.list({ signal: controller.signal }),
      conditional: () =>
        bucket.get("fixture", {
          onlyIf: { etagMatches: "fixture-etag" },
          signal: controller.signal,
        }),
    }
      [operation]()
      .then(
        () => "resolved",
        () => "rejected",
      );
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("1 second")));
    controller.abort();
    expect(await pending).toBe("rejected");
    await Effect.runPromise(Deferred.await(stopped).pipe(Effect.timeout("1 second")));
  }
});

test("pre-aborted metadata operations never enter the backend", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before metadata admission");
  controller.abort(reason);
  const calls = { count: 0 };
  const unexpected = () =>
    Effect.sync(() => {
      calls.count += 1;
    }).pipe(Effect.andThen(Effect.die("Unexpected backend operation")));
  const bucket = new ObjectBucket(
    ObjectStore.of({
      head: unexpected,
      list: unexpected,
      read: unexpected,
      write: unexpected,
      remove: unexpected,
    }),
  );
  await expect(bucket.head("fixture", controller.signal)).rejects.toBe(reason);
  await expect(bucket.list({ signal: controller.signal })).rejects.toBe(reason);
  await expect(
    bucket.get("fixture", {
      onlyIf: { etagMatches: "fixture-etag" },
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(calls.count).toBe(0);
});
