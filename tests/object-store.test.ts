import { expect, test } from "bun:test";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { ObjectStore } from "../src/object-store";
import { objectStoreFixtureLive } from "./object-store-fixture";

const runStore = <A, E>(scenario: Effect.Effect<A, E, ObjectStore>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(objectStoreFixtureLive);
        return yield* scenario.pipe(Effect.provideContext(context));
      }),
    ),
  );

test("native object storage fences concurrent versions and preserves canonical bytes", async () => {
  await runStore(
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      const first = yield* store.write("namespaces/test/root", new TextEncoder().encode("first"), {
        ifNoneMatch: "*",
      });
      expect(Option.isSome(first)).toBe(true);
      if (Option.isNone(first))
        return yield* new Cause.UnknownError(new Error("Initial write did not commit"));
      const version = first.value;
      const duplicate = yield* store.write(
        "namespaces/test/root",
        new TextEncoder().encode("lost"),
        { ifNoneMatch: "*" },
      );
      expect(Option.isNone(duplicate)).toBe(true);
      const stale = yield* store.write("namespaces/test/root", new TextEncoder().encode("lost"), {
        ifMatch: '"stale"',
      });
      expect(Option.isNone(stale)).toBe(true);
      const commits = yield* Effect.forEach(
        ["second", "third"],
        Effect.fn(function* (text) {
          return {
            text,
            result: yield* store.write("namespaces/test/root", new TextEncoder().encode(text), {
              ifMatch: version.etag,
            }),
          };
        }),
        { concurrency: 2 },
      );
      const winners = commits.filter((item) => Option.isSome(item.result));
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner === undefined)
        return yield* new Cause.UnknownError(new Error("No conditional writer committed"));
      const read = yield* store.read("namespaces/test/root");
      if (Option.isNone(read))
        return yield* new Cause.UnknownError(new Error("Committed object is missing"));
      expect(yield* Stream.mkString(Stream.decodeText(read.value.body))).toBe(winner.text);
      return undefined;
    }),
  );
}, 30000);

test("immutable object ranges retain the complete object identity", async () => {
  await runStore(
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      const written = yield* store.write("segments/range", new TextEncoder().encode("abcdefg"));
      if (Option.isNone(written))
        return yield* new Cause.UnknownError(new Error("Object did not commit"));
      const read = yield* store.read("segments/range", { range: { offset: 2, length: 3 } });
      if (Option.isNone(read))
        return yield* new Cause.UnknownError(new Error("Object disappeared"));
      expect(read.value.metadata.size).toBe(7);
      expect(read.value.metadata.etag).toBe(written.value.etag);
      expect(yield* Stream.mkString(Stream.decodeText(read.value.body))).toBe("cde");
      return undefined;
    }),
  );
}, 30000);

test("object catalog pagination retains metadata and deletion visibility", async () => {
  await runStore(
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      for (const key of ["catalog/a", "catalog/b", "catalog/c"])
        yield* store.write(key, new TextEncoder().encode(key), { customMetadata: { source: key } });
      const head = yield* store.head("catalog/a");
      if (Option.isNone(head))
        return yield* new Cause.UnknownError(new Error("Missing object metadata"));
      expect(head.value.customMetadata.source).toBe("catalog/a");
      const first = yield* store.list({ prefix: "catalog/", limit: 2, includeMetadata: true });
      expect(first.objects.map((object) => object.key)).toEqual(["catalog/a", "catalog/b"]);
      expect(first.truncated).toBe(true);
      if (!first.truncated)
        return yield* new Cause.UnknownError(new Error("Missing continuation cursor"));
      const second = yield* store.list({ prefix: "catalog/", cursor: first.cursor, limit: 2 });
      expect(second.objects.map((object) => object.key)).toEqual(["catalog/c"]);
      expect(second.truncated).toBe(false);
      yield* store.remove("catalog/b");
      expect(Option.isNone(yield* store.read("catalog/b"))).toBe(true);
      const remaining = yield* store.list({ prefix: "catalog/" });
      expect(remaining.objects.map((object) => object.key)).toEqual(["catalog/a", "catalog/c"]);
      return undefined;
    }),
  );
}, 30000);

test("content-addressed object checksums are retained by the native backend", async () => {
  await runStore(
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      const bytes = new TextEncoder().encode("immutable bytes");
      const checksum = new Uint8Array(
        yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", bytes)),
      );
      yield* store.write("checksums/frame", bytes, { sha256: checksum });
      const metadata = yield* store.head("checksums/frame");
      if (Option.isNone(metadata))
        return yield* new Cause.UnknownError(new Error("Object disappeared"));
      expect(metadata.value.sha256?.toHex()).toBe(checksum.toHex());
      return undefined;
    }),
  );
}, 30000);

test("opaque object keys and UTF-8 metadata roundtrip without namespace aliasing", async () => {
  await runStore(
    Effect.gen(function* () {
      const store = yield* ObjectStore;
      const protectedKey = "namespaces/protected/root.json";
      const opaqueKey = "namespaces/a/../protected/root.json";
      yield* store.write(protectedKey, new TextEncoder().encode("protected"));
      const customMetadata = { source: "ação 日本語", expiresAt: "123" };
      yield* store.write(opaqueKey, new TextEncoder().encode("opaque"), { customMetadata });
      const saved = yield* store.read(protectedKey);
      if (Option.isNone(saved))
        return yield* new Cause.UnknownError(new Error("Protected object disappeared"));
      expect(yield* Stream.mkString(Stream.decodeText(saved.value.body))).toBe("protected");
      const head = yield* store.head(opaqueKey);
      if (Option.isNone(head))
        return yield* new Cause.UnknownError(new Error("Opaque object disappeared"));
      expect(head.value.customMetadata).toEqual(customMetadata);
      const listed = yield* store.list({ prefix: "namespaces/a/" });
      expect(listed.objects.map((object) => object.key)).toEqual([opaqueKey]);
      return undefined;
    }),
  );
}, 30000);
