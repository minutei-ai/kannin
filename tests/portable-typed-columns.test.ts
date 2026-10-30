import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { portableApplication } from "../runtime/application";
import { ObjectBucket } from "../runtime/object-bucket";
import { ObjectStore } from "../src/object-store";
import { decodeRoot } from "../src/manifest";
import { Metadata, QueryResult, WriteResult, isTypedNamespace } from "../src/protocol";
import { objectStoreFixtureLive } from "./object-store-fixture";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);
const token = "portable-typed-column-contract";
const namespace = "typed-column-portable";
const invoke = Effect.fn("test.portableTypedColumns.invoke")(function* (
  fetcher: (request: Request) => Promise<Response>,
  operation: string,
  body: unknown = {},
) {
  const response = yield* Effect.tryPromise(() =>
    fetcher(
      new Request(`http://localhost/v1/namespaces/${namespace}/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
  expect(response.status).toBe(200);
  return yield* Effect.tryPromise(() => response.json());
});

test("typed columns persist through real S3 restart, exact ranking and compaction", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(objectStoreFixtureLive);
        const objects = yield* ObjectStore.pipe(Effect.provideContext(context));
        const bucket = new ObjectBucket(objects);
        const first = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const attributes = {
          count: { u64: "18446744073709551615" },
          signed: { i64: "-9223372036854775808" },
          payload: { bytes: "AP8=" },
          tags: ["exact", "persistent"],
        };
        const mutation = {
          kind: "typed",
          idType: "string",
          requestId: "initial",
          declaration: {
            vectorDimensions: 2,
            columns: [
              { name: "count", type: "u64", filterable: true, nullable: true },
              { name: "signed", type: "i64", filterable: true },
              { name: "payload", type: "bytes" },
              { name: "tags", type: "[string]", filterable: true },
            ],
          },
          upserts: [
            {
              id: "a",
              roles: { title: "cache", text: "cache cache cache" },
              attributes: { count: { u64: "9007199254740992" } },
              vector: [1, 0],
            },
            { id: "b", roles: { title: "", text: "cache" }, attributes, vector: [0.8, 0.2] },
            {
              id: "c",
              roles: { title: "", text: "cache" },
              attributes: { count: null },
              vector: [0, 1],
            },
            { id: "d", roles: { title: "", text: "cache" }, attributes: {}, vector: [-1, 0] },
          ],
          deletes: [],
        };
        const receipt = yield* invoke(first.fetch, "write", mutation).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WriteResult)),
        );
        expect(receipt.sequence).toBe(1);
        yield* Effect.promise(first.dispose);
        const restarted = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const retry = yield* invoke(restarted.fetch, "write", {
          ...mutation,
          declaration: {
            ...mutation.declaration,
            columns: mutation.declaration.columns.toReversed(),
          },
          upserts: mutation.upserts.map((document) => ({
            ...document,
            attributes: Object.fromEntries(Object.entries(document.attributes).toReversed()),
          })),
        });
        expect(retry).toEqual(receipt);
        for (const query of [
          { kind: "text", text: "cache" },
          { kind: "vector", vector: [1, 0] },
        ]) {
          const result = yield* invoke(restarted.fetch, "query", {
            ...query,
            topK: 1,
            minimumSequence: receipt.sequence,
            filters: [{ field: "count", op: "eq", value: attributes.count }],
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)));
          expect(result.rows.map((row) => row.id)).toEqual(["b"]);
          expect(result.rows[0]?.attributes).toEqual(attributes);
        }
        for (const [filter, expected] of [
          [{ field: "count", op: "eq", value: null }, "c"],
          [{ field: "count", op: "exists", value: false }, "d"],
        ] as const) {
          const result = yield* invoke(restarted.fetch, "query", {
            kind: "text",
            text: "cache",
            topK: 10,
            filters: [filter],
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)));
          expect(result.rows.map((row) => row.id)).toEqual([expected]);
        }
        yield* invoke(restarted.fetch, "write", {
          kind: "typed",
          idType: "string",
          requestId: "delete",
          upserts: [],
          deletes: ["a"],
        });
        yield* invoke(restarted.fetch, "compact");
        yield* invoke(restarted.fetch, "vector-sync");
        yield* Effect.promise(restarted.dispose);
        const recovered = yield* portableApplication({ token, scope: namespace, module }).pipe(
          Effect.provideContext(context),
        );
        const metadata = yield* invoke(recovered.fetch, "metadata").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
        );
        expect(metadata).toMatchObject({ sequence: 2, documents: 3, schema: null });
        expect(isTypedNamespace(metadata.columns)).toBe(true);
        const result = yield* invoke(recovered.fetch, "query", {
          kind: "vector",
          vector: [1, 0],
          topK: 1,
          minimumSequence: 2,
          filters: [{ field: "count", op: "eq", value: attributes.count }],
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)));
        expect(result.rows[0]).toMatchObject({ id: "b", attributes });
        const stored = yield* Effect.tryPromise(() =>
          bucket.get(`namespaces/${namespace}/root.json`),
        );
        if (stored === null) throw new Error("Missing typed Root after restart");
        const root = decodeRoot(yield* Effect.tryPromise(() => stored.text()));
        expect(isTypedNamespace(root.schema)).toBe(true);
        expect(root.documents).toBe(3);
        expect(root.segments.every((segment) => segment.dead.length === 0)).toBe(true);
      }),
    ),
  );
});
