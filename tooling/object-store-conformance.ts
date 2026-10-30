import { Cause, Clock, Effect, Exit, Fiber, Option, Stream } from "effect";
import { ObjectStore } from "../src/object-store";

function verify(condition: boolean, step: string) {
  if (condition) return Effect.void;
  return Effect.fail(
    new Cause.UnknownError(new Error(`Object storage conformance failed: ${step}`)),
  );
}

function present<A>(value: Option.Option<A>, step: string) {
  return Effect.fromOption(
    value,
    () => new Cause.UnknownError(new Error(`Missing probe object: ${step}`)),
  );
}

function randomProbeIdentity() {
  return crypto.randomUUID();
}

const readText = Effect.fn("kannin.storageProbe.read")(function* (key: string) {
  const store = yield* ObjectStore;
  const object = yield* store.read(key).pipe(Effect.flatMap((value) => present(value, key)));
  return {
    metadata: object.metadata,
    text: yield* Stream.mkString(Stream.decodeText(object.body)),
  };
});

const removeProbeObject = Effect.fn("kannin.storageProbe.cleanup")(function* (
  key: string,
  owner?: string,
) {
  const store = yield* ObjectStore;
  const cleanup = yield* Effect.gen(function* () {
    if (owner !== undefined) {
      const current = yield* store.head(key);
      if (Option.isNone(current) || current.value.customMetadata.probeOwner !== owner) return;
    }
    yield* store.remove(key);
  }).pipe(Effect.timeout("5 seconds"), Effect.forkDetach({ uninterruptible: false }));
  yield* Fiber.join(cleanup).pipe(Effect.orDie);
});

export const checkObjectStore = Effect.fn("kannin.storageProbe")(function* () {
  const store = yield* ObjectStore;
  const prefix = `kannin-conformance/${yield* Effect.sync(randomProbeIdentity)}/`;
  const key = `${prefix}a`;
  const metadataKey = `${prefix}b`;
  const opaqueKey = `${prefix}x/../a`;
  const encoder = new TextEncoder();
  const owner = yield* Effect.sync(randomProbeIdentity);
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const claim = { cleanup: false, ambiguous: false };
      yield* Effect.addFinalizer(() => {
        if (!claim.cleanup) return Effect.void;
        if (claim.ambiguous) return removeProbeObject(key, owner);
        return removeProbeObject(key);
      });
      const initial = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const outcome = yield* restore(
            store
              .write(key, encoder.encode("initial"), {
                ifNoneMatch: "*",
                customMetadata: { probeOwner: owner },
              })
              .pipe(Effect.timeout("5 seconds")),
          ).pipe(Effect.exit);
          if (Exit.isFailure(outcome)) {
            claim.cleanup = true;
            claim.ambiguous = true;
            return yield* Effect.failCause(outcome.cause);
          }
          if (Option.isNone(outcome.value))
            return yield* present(outcome.value, "conditional create");
          claim.cleanup = true;
          return outcome.value.value;
        }),
      );
      for (const owned of [metadataKey, opaqueKey])
        yield* Effect.addFinalizer(() => removeProbeObject(owned));
      const duplicate = yield* store.write(key, encoder.encode("ignored"), { ifNoneMatch: "*" });
      yield* verify(Option.isNone(duplicate), "ifNoneMatch rejected an existing object");
      const stale = yield* store.write(key, encoder.encode("ignored"), { ifMatch: '"stale"' });
      yield* verify(Option.isNone(stale), "stale ifMatch did not commit");
      const raced = yield* Effect.forEach(
        ["winner-a", "winner-b"],
        Effect.fn(function* (text) {
          return {
            text,
            version: yield* store.write(key, encoder.encode(text), { ifMatch: initial.etag }),
          };
        }),
        { concurrency: 2 },
      );
      const winners = raced.filter((candidate) => Option.isSome(candidate.version));
      yield* verify(winners.length === 1, "exactly one concurrent conditional writer committed");
      const winner = winners[0];
      if (winner === undefined)
        return yield* new Cause.UnknownError(new Error("Conditional probe has no winner"));
      const committed = yield* present(winner.version, "conditional winner");
      const saved = yield* readText(key);
      yield* verify(saved.text === winner.text, "conditional winner bytes");
      yield* verify(saved.metadata.etag === committed.etag, "conditional winner ETag");
      const range = yield* store
        .read(key, { range: { offset: 1, length: 3 } })
        .pipe(Effect.flatMap((value) => present(value, "range")));
      const rangeText = yield* Stream.mkString(Stream.decodeText(range.body));
      yield* verify(
        range.metadata.size === encoder.encode(winner.text).byteLength &&
          range.metadata.etag === committed.etag,
        "range retains full object identity",
      );
      yield* verify(rangeText === winner.text.slice(1, 4), "range bytes");
      const metadata = {
        source: "ação 日本語",
        expiresAt: String((yield* Clock.currentTimeMillis) + 60000),
      };
      yield* store.write(metadataKey, encoder.encode("checkpoint"), { customMetadata: metadata });
      const head = yield* store
        .head(metadataKey)
        .pipe(Effect.flatMap((value) => present(value, "head")));
      yield* verify(
        head.customMetadata.source === metadata.source &&
          head.customMetadata.expiresAt === metadata.expiresAt,
        "UTF-8 checkpoint metadata roundtrip",
      );
      yield* store.write(opaqueKey, encoder.encode("opaque"));
      yield* verify((yield* readText(key)).text === winner.text, "dot segments do not alias keys");
      const first = yield* store.list({ prefix, limit: 1, includeMetadata: true });
      yield* verify(
        first.objects.length === 1 && first.objects[0]?.key === key,
        "first catalog page",
      );
      if (!first.truncated)
        return yield* new Cause.UnknownError(
          new Error("Storage probe did not receive a continuation cursor"),
        );
      const second = yield* store.list({
        prefix,
        cursor: first.cursor,
        limit: 10,
        includeMetadata: true,
      });
      yield* verify(
        !second.truncated &&
          JSON.stringify(second.objects.map((object) => object.key)) ===
            JSON.stringify([metadataKey, opaqueKey]),
        "continuation preserves opaque keys",
      );
      yield* verify(
        second.objects[0]?.customMetadata?.expiresAt === metadata.expiresAt,
        "listed checkpoint metadata",
      );
      yield* store.remove(metadataKey);
      yield* verify(Option.isNone(yield* store.head(metadataKey)), "deletion visibility");
      return { prefix, conditionalWriters: winners.length, keys: 3 };
    }).pipe(Effect.timeout("30 seconds")),
  );
  const remaining = yield* store.list({ prefix, limit: 1 }).pipe(Effect.timeout("5 seconds"));
  yield* verify(
    remaining.objects.length === 0 && !remaining.truncated,
    "owned probe objects cleaned up",
  );
  return { ...result, cleanup: "complete" as const };
});
