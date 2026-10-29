import { expect, test } from "bun:test";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import { portableApplication } from "../runtime/application";
import { ObjectBucket } from "../runtime/object-bucket";
import { decodeRoot } from "../src/manifest";
import { ObjectStore } from "../src/object-store";
import { LegacyStoredRootV4, QueryResult, StoredRoot } from "../src/protocol";
import type { ObjectWriteCondition } from "../src/protocol";
import { objectStoreFixtureLive } from "./object-store-fixture";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);
const namespace = "portable-migration-identity";
const token = "portable-migration-token";
const rootKey = `namespaces/${namespace}/root.json`;

function request(operation: string, body: unknown) {
  return new Request(`http://localhost/v1/namespaces/${namespace}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a migration retry never republishes a portable segment captured by an earlier collector", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(objectStoreFixtureLive);
        const objects = yield* ObjectStore.pipe(Effect.provideContext(context));
        const bucket = new ObjectBucket(objects);
        const seed = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const seeded = yield* Effect.tryPromise(() =>
          seed.fetch(
            request("write", {
              requestId: "seed",
              upserts: [{ id: "a", text: "retained migration", attributes: {} }],
              deletes: [],
            }),
          ),
        );
        expect(seeded.status).toBe(200);
        yield* Effect.tryPromise(() => seeded.arrayBuffer());
        yield* Effect.promise(seed.dispose);
        const original = yield* Effect.tryPromise(() => bucket.get(rootKey));
        if (original === null) throw new Error("Missing seeded Root");
        const encoded = yield* Effect.tryPromise(() => original.text());
        const stored = yield* Schema.decodeEffect(Schema.fromJsonString(StoredRoot))(encoded);
        const legacy = yield* Schema.decodeEffect(LegacyStoredRootV4)({
          ...Struct.omit(stored, ["schema"]),
          version: 4,
        });
        const legacyText = yield* Schema.encodeEffect(Schema.fromJsonString(LegacyStoredRootV4))(
          legacy,
        );
        yield* objects.write(rootKey, new TextEncoder().encode(legacyText));
        const abandoned: string[] = [];
        const blocked = ObjectStore.of({
          ...objects,
          write: Effect.fn("kannin.migrationIdentity.write")(function* (
            key: string,
            bytes: Uint8Array,
            condition?: typeof ObjectWriteCondition.Type,
          ) {
            if (key === rootKey) return Option.none();
            const result = yield* objects.write(key, bytes, condition);
            if (key.startsWith(`namespaces/${namespace}/segments/`)) abandoned.push(key);
            return result;
          }),
        });
        const interrupted = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideService(ObjectStore, blocked),
          Effect.provideContext(context),
        );
        const rejected = yield* Effect.tryPromise(() =>
          interrupted.fetch(request("migrate-root", {})),
        );
        expect(rejected.status).toBe(409);
        yield* Effect.tryPromise(() => rejected.arrayBuffer());
        yield* Effect.promise(interrupted.dispose);
        expect(abandoned).toHaveLength(1);
        const replica = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const migrated = yield* Effect.tryPromise(() => replica.fetch(request("migrate-root", {})));
        expect(migrated.status).toBe(200);
        yield* Effect.tryPromise(() => migrated.arrayBuffer());
        const committed = yield* Effect.tryPromise(() => bucket.get(rootKey));
        if (committed === null) throw new Error("Missing migrated Root");
        const committedText = yield* Effect.tryPromise(() => committed.text());
        const root = yield* Effect.try(() => decodeRoot(committedText));
        expect(root.segments).toHaveLength(1);
        expect(abandoned).not.toContain(root.segments[0]?.key);
        for (const key of abandoned) yield* objects.remove(key);
        const response = yield* Effect.tryPromise(() =>
          replica.fetch(
            request("query", {
              kind: "text",
              text: "retained",
              topK: 10,
              filters: [],
              consistency: "strong",
            }),
          ),
        );
        expect(response.status).toBe(200);
        const result = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(result.rows.map((row) => row.id)).toEqual(["a"]);
      }),
    ),
  );
});
