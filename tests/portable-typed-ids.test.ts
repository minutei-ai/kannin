import { expect, test } from "bun:test";
import { Clock, Effect, Layer, Schema } from "effect";
import { portableApplication } from "../runtime/application";
import { ObjectBucket } from "../runtime/object-bucket";
import { ObjectStore } from "../src/object-store";
import { decodeRoot } from "../src/manifest";
import { sha256 } from "../src/hash";
import {
  CanonicalWrite,
  LegacyStoredRootV6,
  QueryResult,
  RootMigrationResult,
  StoredRoot,
  Write,
  WriteResult,
} from "../src/protocol";
import { objectStoreFixtureLive } from "./object-store-fixture";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);
const token = "portable-typed-identity-contract";
function request(namespace: string, operation: string, body: unknown) {
  return new Request(`http://localhost/v1/namespaces/${namespace}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("typed identities survive the real object-store writer, restart, ranking and maintenance", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(objectStoreFixtureLive);
        const objects = yield* ObjectStore.pipe(Effect.provideContext(context));
        const bucket = new ObjectBucket(objects);
        const namespace = "typed-uint-runtime";
        const first = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const emptyPolicy = {
          kind: "canonical",
          requestId: "create",
          idType: "uint",
          upserts: [],
          deletes: [],
        };
        const empty = yield* Effect.tryPromise(() =>
          first.fetch(request("typed-empty-policy", "write", emptyPolicy)),
        );
        expect(empty.status).toBe(200);
        yield* Effect.tryPromise(() => empty.arrayBuffer());
        const emptyObject = yield* Effect.tryPromise(() =>
          bucket.get("namespaces/typed-empty-policy/root.json"),
        );
        if (emptyObject === null) throw new Error("Declared empty namespace is missing");
        const emptyRoot = decodeRoot(yield* Effect.tryPromise(() => emptyObject.text()));
        expect(emptyRoot).toMatchObject({
          idType: "uint",
          sequence: 1,
          documents: 0,
          segments: [],
        });
        const emptyRetry = yield* Effect.tryPromise(() =>
          first.fetch(request("typed-empty-policy", "write", emptyPolicy)),
        );
        expect(emptyRetry.status).toBe(200);
        yield* Effect.tryPromise(() => emptyRetry.arrayBuffer());
        const repeatedEmpty = yield* Effect.tryPromise(() =>
          first.fetch(
            request("typed-empty-policy", "write", { ...emptyPolicy, requestId: "no-op" }),
          ),
        );
        expect(repeatedEmpty.status).toBe(400);
        yield* Effect.tryPromise(() => repeatedEmpty.arrayBuffer());
        const unchangedEmpty = yield* Effect.tryPromise(() =>
          bucket.get("namespaces/typed-empty-policy/root.json"),
        );
        expect(unchangedEmpty?.etag).toBe(emptyObject.etag);
        const changedPolicy = yield* Effect.tryPromise(() =>
          first.fetch(
            request("typed-empty-policy", "write", {
              ...emptyPolicy,
              requestId: "change",
              idType: "uuid",
            }),
          ),
        );
        expect(changedPolicy.status).toBe(409);
        yield* Effect.tryPromise(() => changedPolicy.arrayBuffer());
        const nativeEmpty = yield* Effect.tryPromise(() =>
          first.fetch(
            request("native-empty-policy", "write", {
              requestId: "empty",
              upserts: [],
              deletes: [],
            }),
          ),
        );
        expect(nativeEmpty.status).toBe(400);
        yield* Effect.tryPromise(() => nativeEmpty.arrayBuffer());
        const write = yield* Schema.decodeEffect(CanonicalWrite)({
          kind: "canonical",
          requestId: "initial",
          idType: "uint",
          schema: { filterable: [], vectorFilterFields: [], vectorDimensions: 2 },
          upserts: ["10", "18446744073709551615", "2"].map((value) => ({
            id: { kind: "uint", value },
            roles: { title: "", text: "identity persistent" },
            attributes: {},
            vector: [1, 0],
          })),
          deletes: [],
        });
        const response = yield* Effect.tryPromise(() =>
          first.fetch(request(namespace, "write", write)),
        );
        expect(response.status).toBe(200);
        const receipt = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WriteResult)),
        );
        expect(receipt.sequence).toBe(1);
        yield* Effect.promise(first.dispose);
        const restarted = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const retry = yield* Effect.tryPromise(() =>
          restarted.fetch(request(namespace, "write", write)),
        );
        expect(yield* Effect.tryPromise(() => retry.json())).toEqual(receipt);
        const conflict = yield* Effect.tryPromise(() =>
          restarted.fetch(
            request(namespace, "write", {
              ...write,
              upserts: [],
              deletes: [{ kind: "uint", value: "2" }],
            }),
          ),
        );
        expect(conflict.status).toBe(409);
        yield* Effect.tryPromise(() => conflict.arrayBuffer());
        const rootObject = yield* Effect.tryPromise(() =>
          bucket.get(`namespaces/${namespace}/root.json`),
        );
        if (rootObject === null) throw new Error("Typed Root is missing");
        const rootText = yield* Effect.tryPromise(() => rootObject.text());
        expect(rootText).toContain('"version":7');
        expect(rootText).toContain('"idType":"uint"');
        expect(rootText).toContain('"value":"2"');
        const root = decodeRoot(rootText);
        const canonicalEnvelope = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalWrite))(
          write,
        );
        expect(root.lastReceipt?.digest).toBe(
          yield* Effect.tryPromise(() => sha256(canonicalEnvelope)),
        );
        expect(root.segments[0]?.minimumId).toEqual({ kind: "uint", value: "2" });
        const expected = ["2", "10", "18446744073709551615"].map((value) => ({
          kind: "uint" as const,
          value,
        }));
        for (const query of [
          { kind: "text", text: "identity" },
          { kind: "vector", vector: [1, 0] },
          { kind: "hybrid", text: "identity", vector: [1, 0] },
        ]) {
          const result = yield* Effect.tryPromise(() =>
            restarted.fetch(
              request(namespace, "query", { ...query, topK: 10, filters: [], minimumSequence: 1 }),
            ),
          );
          expect(result.status).toBe(200);
          const decoded = yield* Effect.tryPromise(() => result.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
          );
          expect(decoded.rows.map((row) => row.id)).toEqual(expected);
        }
        const mutation = {
          kind: "canonical",
          requestId: "replace-delete",
          idType: "uint",
          upserts: [
            {
              id: { kind: "uint", value: "10" },
              roles: { title: "", text: "updated identity" },
              attributes: {},
              vector: [0, 1],
            },
          ],
          deletes: [{ kind: "uint", value: "2" }],
        };
        const updated = yield* Effect.tryPromise(() =>
          restarted.fetch(request(namespace, "write", mutation)),
        );
        expect(updated.status).toBe(200);
        yield* Effect.tryPromise(() => updated.arrayBuffer());
        for (const operation of ["vector-sync", "vector-rebuild", "rebuild", "compact"]) {
          const maintenance = yield* Effect.tryPromise(() =>
            restarted.fetch(request(namespace, operation, {})),
          );
          expect(maintenance.status).toBe(200);
          yield* Effect.tryPromise(() => maintenance.arrayBuffer());
        }
        const after = yield* Effect.tryPromise(() =>
          restarted.fetch(
            request(namespace, "query", {
              kind: "text",
              text: "updated",
              topK: 10,
              filters: [],
              minimumSequence: 2,
            }),
          ),
        );
        const rows = yield* Effect.tryPromise(() => after.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(rows.rows.map((row) => [row.id, row.revision])).toEqual([
          [{ kind: "uint", value: "10" }, 2],
        ]);
        const vectorsAfterMaintenance = yield* Effect.tryPromise(() =>
          restarted.fetch(
            request(namespace, "query", {
              kind: "vector",
              vector: [1, 0],
              topK: 10,
              filters: [],
              minimumSequence: 2,
            }),
          ),
        );
        expect(vectorsAfterMaintenance.status).toBe(200);
        const rankedVectors = yield* Effect.tryPromise(() => vectorsAfterMaintenance.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(
          rankedVectors.rows.map(({ id, score, revision }) => ({ id, score, revision })),
        ).toEqual([
          { id: { kind: "uint" as const, value: "18446744073709551615" }, score: 1, revision: 1 },
          { id: { kind: "uint" as const, value: "10" }, score: 0, revision: 2 },
        ]);
        for (const invalid of [
          { ...mutation, requestId: "mixed", upserts: [], deletes: ["10"] },
          {
            ...mutation,
            requestId: "policy-change",
            idType: "string",
            reset: true,
            upserts: [],
            deletes: [],
          },
          {
            ...mutation,
            requestId: "rounded",
            upserts: [],
            deletes: [{ kind: "uint", value: "18446744073709551616" }],
          },
          {
            ...mutation,
            requestId: "client-revision",
            upserts: [{ ...mutation.upserts[0], revision: 99 }],
            deletes: [],
          },
          { ...mutation, requestId: "unsupported", deleteByFilter: [], upserts: [], deletes: [] },
        ]) {
          const rejected = yield* Effect.tryPromise(() =>
            restarted.fetch(request(namespace, "write", invalid)),
          );
          if (invalid.requestId === "policy-change") expect(rejected.status).toBe(409);
          else expect(rejected.status).toBe(400);
          yield* Effect.tryPromise(() => rejected.arrayBuffer());
        }
        const uuid = "00112233-4455-6677-8899-aabbccddeeff";
        for (const name of ["typed-uuid", "native-uuid-looking"]) {
          const fixture = (() => {
            if (name === "typed-uuid") {
              const id = { kind: "uuid" as const, value: uuid };
              return {
                id,
                input: {
                  kind: "canonical",
                  idType: "uuid",
                  requestId: "uuid",
                  upserts: [{ id, roles: { title: "", text: "identity" }, attributes: {} }],
                  deletes: [],
                },
              };
            }
            return {
              id: uuid,
              input: {
                requestId: "uuid",
                upserts: [{ id: uuid, text: "identity", attributes: {} }],
                deletes: [],
              },
            };
          })();
          const { id, input } = fixture;
          const stored = yield* Effect.tryPromise(() =>
            restarted.fetch(request(name, "write", input)),
          );
          expect(stored.status).toBe(200);
          yield* Effect.tryPromise(() => stored.arrayBuffer());
          const queried = yield* Effect.tryPromise(() =>
            restarted.fetch(
              request(name, "query", { kind: "text", text: "identity", filters: [], topK: 1 }),
            ),
          );
          const result = yield* Effect.tryPromise(() => queried.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
          );
          expect(result.rows[0]?.id).toEqual(id);
        }
        const migratedNamespace = "native-uuid-looking";
        const rootKey = `namespaces/${migratedNamespace}/root.json`;
        const captured = yield* Effect.tryPromise(() => bucket.get(rootKey));
        if (captured === null) throw new Error("Native migration Root missing");
        const currentWire = yield* Effect.tryPromise(() => captured.text());
        const currentStored = yield* Schema.decodeEffect(Schema.fromJsonString(StoredRoot))(
          currentWire,
        );
        const nativeEnvelope = {
          requestId: "uuid",
          upserts: [{ id: uuid, text: "identity", attributes: {} }],
          deletes: [],
        };
        const nativeWire = yield* Schema.encodeEffect(Schema.fromJsonString(Write))(nativeEnvelope);
        expect(currentStored.lastReceipt?.digest).toBe(
          yield* Effect.tryPromise(() => sha256(nativeWire)),
        );
        const legacy = yield* Schema.decodeUnknownEffect(LegacyStoredRootV6)({
          ...currentStored,
          version: 6,
        });
        const legacyWire = yield* Schema.encodeEffect(Schema.fromJsonString(LegacyStoredRootV6))(
          legacy,
        );
        const expiresAt = String((yield* Clock.currentTimeMillis) + 60000);
        const checkpointKey = `namespaces/${migratedNamespace}/vector-rebuild/00112233-4455-6677-8899-aabbccddeeff.json`;
        yield* Effect.tryPromise(() =>
          bucket.put(checkpointKey, JSON.stringify({ root: legacy, fields: [] }), {
            customMetadata: { expiresAt },
          }),
        );
        yield* Effect.tryPromise(() => bucket.put(rootKey, legacyWire));
        const migration = yield* Effect.tryPromise(() =>
          restarted.fetch(request(migratedNamespace, "migrate-root", {})),
        );
        expect(migration.status).toBe(200);
        const migrationResult = yield* Effect.tryPromise(() => migration.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RootMigrationResult)),
        );
        expect(migrationResult).toMatchObject({
          version: 7,
          rootRewritten: true,
          migratedSnapshots: 1,
          expiredSnapshots: 0,
        });
        const migratedRoot = yield* Effect.tryPromise(() => bucket.get(rootKey));
        if (migratedRoot === null) throw new Error("Migrated Root missing");
        expect(decodeRoot(yield* Effect.tryPromise(() => migratedRoot.text())).segments).toEqual(
          decodeRoot(currentWire).segments,
        );
        const checkpoint = yield* Effect.tryPromise(() => bucket.get(checkpointKey));
        if (checkpoint === null) throw new Error("Migrated checkpoint missing");
        expect(checkpoint.customMetadata?.expiresAt).toBe(expiresAt);
        expect(yield* Effect.tryPromise(() => checkpoint.text())).toContain('"version":7');
        yield* Effect.promise(restarted.dispose);
        yield* Effect.tryPromise(() => bucket.put(rootKey, legacyWire));
        const booted = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const bootRoot = yield* Effect.tryPromise(() => bucket.get(rootKey));
        if (bootRoot === null) throw new Error("Recovered Root missing");
        const recovered = decodeRoot(yield* Effect.tryPromise(() => bootRoot.text()));
        expect(recovered.idType ?? "string").toBe("string");
        expect(recovered.segments).toEqual(decodeRoot(currentWire).segments);
        const recoveredResponse = yield* Effect.tryPromise(() =>
          booted.fetch(
            request(migratedNamespace, "query", {
              kind: "text",
              text: "identity",
              filters: [],
              topK: 1,
            }),
          ),
        );
        expect(recoveredResponse.status).toBe(200);
        const recoveredRows = yield* Effect.tryPromise(() => recoveredResponse.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(recoveredRows.rows[0]?.id).toBe(uuid);
      }),
    ),
  );
});
