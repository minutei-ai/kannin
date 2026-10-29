import { expect, test } from "bun:test";
import { Deferred, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { portableApplication } from "../runtime/application";
import { ObjectStore } from "../src/object-store";
import { CollectionResult, ErrorBody, QueryResult } from "../src/protocol";
import type { ObjectReadOptions } from "../src/protocol";
import { objectStoreFixtureLive } from "./object-store-fixture";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);
const token = "portable-strong-reader-lease-token";
const namespace = "portable-strong-reader-lease";
const deadline = "Strong query exceeded its 30-second reader lease";

function request(operation: string, body: unknown) {
  return new Request(`http://localhost/v1/namespaces/${namespace}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("strong reader leases bound stalled reads without dropping a live captured root", async () => {
  const scenario = Effect.gen(function* () {
    const context = yield* TestClock.withLive(Layer.build(objectStoreFixtureLive));
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
    const block = { segments: false, root: false };
    const gates: {
      segmentEntered: Deferred.Deferred<void> | undefined;
      segmentRelease: Deferred.Deferred<void> | undefined;
      rootEntered: Deferred.Deferred<void> | undefined;
      rootRelease: Deferred.Deferred<void> | undefined;
    } = {
      segmentEntered: undefined,
      segmentRelease: undefined,
      rootEntered: undefined,
      rootRelease: undefined,
    };
    const blocked = ObjectStore.of({
      ...objects,
      read: Effect.fn("kannin.strongReaderLease.read")(function* (
        key: string,
        options?: typeof ObjectReadOptions.Type,
      ) {
        const segmentEntered = gates.segmentEntered;
        const segmentRelease = gates.segmentRelease;
        if (
          block.segments &&
          segmentEntered !== undefined &&
          segmentRelease !== undefined &&
          key.startsWith(`namespaces/${namespace}/segments/`)
        ) {
          block.segments = false;
          yield* Deferred.succeed(segmentEntered, undefined);
          yield* Deferred.await(segmentRelease);
        }
        const rootEntered = gates.rootEntered;
        const rootRelease = gates.rootRelease;
        if (
          block.root &&
          rootEntered !== undefined &&
          rootRelease !== undefined &&
          key === `namespaces/${namespace}/root.json`
        ) {
          block.root = false;
          yield* Deferred.succeed(rootEntered, undefined);
          yield* Deferred.await(rootRelease).pipe(Effect.uninterruptible);
        }
        return yield* objects.read(key, options);
      }),
    });
    const reader = yield* portableApplication({ token, scope: namespace, module }).pipe(
      Effect.provideService(ObjectStore, blocked),
      Effect.provideContext(context),
    );
    const inflight: Array<Promise<Response>> = [];
    const track = (pending: Promise<Response>) => {
      inflight.push(pending);
      return pending;
    };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const segmentRelease = gates.segmentRelease;
        if (segmentRelease !== undefined)
          yield* Deferred.succeed(segmentRelease, undefined).pipe(Effect.ignore);
        const rootRelease = gates.rootRelease;
        if (rootRelease !== undefined)
          yield* Deferred.succeed(rootRelease, undefined).pipe(Effect.ignore);
        yield* Effect.promise(async () => {
          for (const pending of inflight) {
            const response = await pending.catch(() => undefined);
            if (response !== undefined && !response.bodyUsed) await response.arrayBuffer();
          }
        });
        yield* Effect.promise(reader.dispose);
      }),
    );
    gates.segmentEntered = yield* Deferred.make<void>();
    gates.segmentRelease = yield* Deferred.make<void>();
    block.segments = true;
    const fast = track(
      reader.fetch(
        request("query", {
          kind: "text",
          text: "captured",
          topK: 10,
          filters: [],
          consistency: "strong",
          minimumSequence: 1,
        }),
      ),
    );
    const fastEntered = gates.segmentEntered;
    if (fastEntered === undefined) return yield* Effect.die("missing segment gate");
    yield* Deferred.await(fastEntered);
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
    const protectedResponse = yield* Effect.tryPromise(() => reader.fetch(request("collect", {})));
    expect(protectedResponse.status).toBe(200);
    const protectedObjects = yield* Effect.tryPromise(() => protectedResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CollectionResult)),
    );
    expect(protectedObjects.pinned).toBe(4);
    expect(protectedObjects.deleted).toBe(0);
    const fastRelease = gates.segmentRelease;
    if (fastRelease === undefined) return yield* Effect.die("missing segment release");
    yield* Deferred.succeed(fastRelease, undefined);
    const capturedResponse = yield* Effect.tryPromise(() => fast);
    expect(capturedResponse.status).toBe(200);
    const captured = yield* Effect.tryPromise(() => capturedResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
    );
    expect(captured.sequence).toBe(1);
    expect(captured.rows.map((row) => row.id)).toEqual(["old"]);
    const releasedResponse = yield* Effect.tryPromise(() => reader.fetch(request("collect", {})));
    expect(releasedResponse.status).toBe(200);
    const released = yield* Effect.tryPromise(() => releasedResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CollectionResult)),
    );
    expect(released.pinned).toBe(2);
    gates.segmentEntered = yield* Deferred.make<void>();
    gates.segmentRelease = yield* Deferred.make<void>();
    block.segments = true;
    const stalled = track(
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
    const stalledEntered = gates.segmentEntered;
    if (stalledEntered === undefined) return yield* Effect.die("missing stalled segment gate");
    yield* Deferred.await(stalledEntered);
    const rotated = yield* Effect.tryPromise(() =>
      reader.fetch(
        request("write", {
          requestId: "rotate",
          reset: true,
          upserts: [{ id: "later", text: "later text", attributes: {} }],
          deletes: [],
        }),
      ),
    );
    expect(rotated.status).toBe(200);
    yield* Effect.tryPromise(() => rotated.arrayBuffer());
    const heldResponse = yield* Effect.tryPromise(() => reader.fetch(request("collect", {})));
    expect(heldResponse.status).toBe(200);
    const held = yield* Effect.tryPromise(() => heldResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CollectionResult)),
    );
    expect(held.pinned).toBe(4);
    yield* TestClock.adjust("31 seconds");
    const expiredResponse = yield* Effect.tryPromise(() => stalled);
    expect(expiredResponse.status).toBe(504);
    const expired = yield* Effect.tryPromise(() => expiredResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
    );
    expect(expired.error).toBe(deadline);
    const droppedResponse = yield* Effect.tryPromise(() => reader.fetch(request("collect", {})));
    expect(droppedResponse.status).toBe(200);
    const dropped = yield* Effect.tryPromise(() => droppedResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CollectionResult)),
    );
    expect(dropped.pinned).toBe(2);
    expect(dropped.deleted).toBe(0);
    const stalledRelease = gates.segmentRelease;
    if (stalledRelease === undefined) return yield* Effect.die("missing stalled release");
    yield* Deferred.succeed(stalledRelease, undefined);
    const resumed = yield* Effect.tryPromise(() =>
      reader.fetch(
        request("query", {
          kind: "text",
          text: "later",
          topK: 10,
          filters: [],
          consistency: "strong",
          minimumSequence: 3,
        }),
      ),
    );
    expect(resumed.status).toBe(200);
    const resumedBody = yield* Effect.tryPromise(() => resumed.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
    );
    expect(resumedBody.sequence).toBe(3);
    expect(resumedBody.rows.map((row) => row.id)).toEqual(["later"]);
    gates.rootEntered = yield* Deferred.make<void>();
    gates.rootRelease = yield* Deferred.make<void>();
    block.root = true;
    const slowRoot = track(
      reader.fetch(
        request("query", {
          kind: "text",
          text: "later",
          topK: 10,
          filters: [],
          consistency: "strong",
          minimumSequence: 3,
        }),
      ),
    );
    const rootEntered = gates.rootEntered;
    if (rootEntered === undefined) return yield* Effect.die("missing root gate");
    yield* Deferred.await(rootEntered);
    yield* TestClock.adjust("31 seconds");
    const slowResponse = yield* Effect.tryPromise(() => slowRoot);
    expect(slowResponse.status).toBe(504);
    const slowBody = yield* Effect.tryPromise(() => slowResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
    );
    expect(slowBody.error).toBe(deadline);
    const rootRelease = gates.rootRelease;
    if (rootRelease === undefined) return yield* Effect.die("missing root release");
    yield* Deferred.succeed(rootRelease, undefined);
    const replaced = yield* Effect.tryPromise(() =>
      reader.fetch(
        request("write", {
          requestId: "replace",
          reset: true,
          upserts: [{ id: "final", text: "final text", attributes: {} }],
          deletes: [],
        }),
      ),
    );
    expect(replaced.status).toBe(200);
    yield* Effect.tryPromise(() => replaced.arrayBuffer());
    const collectedResponse = yield* Effect.tryPromise(() => reader.fetch(request("collect", {})));
    expect(collectedResponse.status).toBe(200);
    const collected = yield* Effect.tryPromise(() => collectedResponse.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CollectionResult)),
    );
    expect(collected.pinned).toBe(2);
    expect(collected.deleted).toBe(0);
    gates.rootEntered = yield* Deferred.make<void>();
    gates.rootRelease = yield* Deferred.make<void>();
    block.root = true;
    const caller = new AbortController();
    const cancelled = track(
      reader.fetch(
        new Request(
          request("query", {
            kind: "text",
            text: "final",
            topK: 10,
            filters: [],
            consistency: "strong",
          }),
          { signal: caller.signal },
        ),
      ),
    ).then(
      () => "resolved",
      () => "rejected",
    );
    const cancelledEntered = gates.rootEntered;
    if (cancelledEntered === undefined) return yield* Effect.die("missing cancelled root gate");
    yield* TestClock.withLive(Deferred.await(cancelledEntered).pipe(Effect.timeout("5 seconds")));
    caller.abort();
    const cancellation = yield* TestClock.withLive(
      Effect.promise(() => cancelled).pipe(Effect.timeout("5 seconds")),
    );
    expect(cancellation).toBe("rejected");
    const cancelledRelease = gates.rootRelease;
    if (cancelledRelease === undefined) return yield* Effect.die("missing cancelled root release");
    yield* Deferred.succeed(cancelledRelease, undefined);
    return undefined;
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clockContext = yield* Layer.build(TestClock.layer());
        yield* scenario.pipe(Effect.provideContext(clockContext));
      }),
    ),
  );
}, 60000);
