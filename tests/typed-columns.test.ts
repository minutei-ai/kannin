import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { initSync, unpack } from "../dist/wasm/raio_engine";
import { decodeRoot } from "../src/manifest";
import {
  CompactResult,
  Log,
  Metadata,
  QueryResult,
  RootMigrationResult,
  StoredRoot,
  WriteResult,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const worker = await startWorker();
afterAll(() => worker.dispose());

const MAX_U64 = "18446744073709551615";
const declaration = {
  vectorDimensions: 4,
  columns: [
    { name: "year", type: "i64", filterable: true },
    { name: "count", type: "u64", filterable: true },
    { name: "score", type: "f64", filterable: true, nullable: true },
    { name: "tags", type: "[string]", filterable: true },
    { name: "payload", type: "bytes", nullable: true },
    { name: "note", type: "string", nullable: true },
  ],
};
const typedDocument = (
  id: string,
  text: string,
  attributes: Record<string, unknown>,
  vector?: number[],
) => ({
  id,
  roles: { title: "", text },
  attributes,
  ...(vector !== undefined && { vector }),
});
const typedWrite = (
  requestId: string,
  upserts: ReadonlyArray<ReturnType<typeof typedDocument>>,
  deletes: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  kind: "typed",
  requestId,
  idType: "string",
  declaration,
  upserts,
  deletes,
  ...extra,
});
const rows = {
  a: typedDocument("a", "rust engine", {
    year: { i64: "2024" },
    count: { u64: MAX_U64 },
    score: { f64: "3ff8000000000000" },
    tags: ["x", "y"],
    payload: { bytes: "AAEC" },
    note: null,
  }),
  b: typedDocument("b", "rust engine search", {
    year: { i64: "-9223372036854775808" },
    count: { u64: "9007199254740993" },
    tags: ["y"],
  }),
  c: typedDocument("c", "rust engine search index", {
    year: { i64: "2026" },
    count: { u64: "0" },
    score: null,
    tags: [],
    note: "present",
  }),
};
const ok = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return response;
};
const query = async (namespace: string, filters: unknown[] = [], text = "rust") =>
  Schema.decodeUnknownSync(QueryResult)(
    await (
      await ok(await request(worker, namespace, "query", textQuery(text, 100, filters)))
    ).json(),
  );
const ids = (result: typeof QueryResult.Type) => result.rows.map((row) => row.id).toSorted();
const metadata = async (namespace: string) =>
  Schema.decodeUnknownSync(Metadata)(await (await request(worker, namespace, "metadata")).json());
const segmentKeys = async (namespace: string) =>
  (
    await (
      await worker.getR2Bucket("STORAGE")
    ).list({ prefix: `namespaces/${namespace}/segments/` })
  ).objects;

test("typed writes round-trip exact cells and expose canonical declarations in metadata", async () => {
  const response = await ok(
    await request(worker, "typed-basic", "write", typedWrite("one", Object.values(rows))),
  );
  expect(Schema.decodeUnknownSync(WriteResult)(await response.json()).sequence).toBe(1);
  const result = await query("typed-basic");
  expect(ids(result)).toEqual(["a", "b", "c"]);
  const byId = new Map(result.rows.map((row) => [row.id, row.attributes]));
  expect(byId.get("a")).toEqual(rows.a.attributes);
  expect(byId.get("b")).toEqual(rows.b.attributes);
  expect(Object.hasOwn(byId.get("b") ?? {}, "score")).toBe(false);
  expect(byId.get("c")).toMatchObject({ score: null, note: "present" });
  const described = await metadata("typed-basic");
  expect(described.schema).toBeNull();
  expect(described.documents).toBe(3);
  const names = described.columns?.columns.flatMap((column) => {
    if (column.source === "attribute") return [column.name];
    return [];
  });
  expect(names).toEqual(["count", "note", "payload", "score", "tags", "year"]);
  expect(described.columns?.columns[0]).toEqual({ source: "native-vector", dimensions: 4 });
  const stored = await (
    await worker.getR2Bucket("STORAGE")
  ).get("namespaces/typed-basic/root.json");
  expect(JSON.parse((await stored?.text()) ?? "{}")).toMatchObject({ version: 8 });
  const segments = await segmentKeys("typed-basic");
  expect(segments).toHaveLength(1);
  const bytes = await (
    await (await worker.getR2Bucket("STORAGE")).get(segments[0]?.key ?? "")
  )?.arrayBuffer();
  expect(new TextDecoder().decode(new Uint8Array(bytes ?? new ArrayBuffer(0)).subarray(0, 8))).toBe(
    "RAIOSEG6",
  );
});

test("typed filters use exact masks for large numbers, arrays, null and missing before top-k", async () => {
  await ok(await request(worker, "typed-filter", "write", typedWrite("one", Object.values(rows))));
  const filtered = async (filter: unknown) => ids(await query("typed-filter", [filter]));
  expect(await filtered({ field: "count", op: "eq", value: { u64: MAX_U64 } })).toEqual(["a"]);
  expect(await filtered({ field: "count", op: "eq", value: { u64: "9007199254740992" } })).toEqual(
    [],
  );
  expect(await filtered({ field: "count", op: "eq", value: { u64: "9007199254740993" } })).toEqual([
    "b",
  ]);
  expect(await filtered({ field: "count", op: "gt", value: { u64: "9007199254740992" } })).toEqual([
    "a",
    "b",
  ]);
  expect(await filtered({ field: "year", op: "lt", value: { i64: "0" } })).toEqual(["b"]);
  expect(await filtered({ field: "year", op: "gte", value: { i64: "2024" } })).toEqual(["a", "c"]);
  expect(await filtered({ field: "tags", op: "contains", value: "y" })).toEqual(["a", "b"]);
  expect(await filtered({ field: "tags", op: "containsAny", value: ["x", "zzz"] })).toEqual(["a"]);
  expect(await filtered({ field: "score", op: "exists", value: false })).toEqual(["b"]);
  expect(await filtered({ field: "score", op: "eq", value: null })).toEqual(["c"]);
  expect(await filtered({ field: "score", op: "eq", value: { f64: "3ff8000000000000" } })).toEqual([
    "a",
  ]);
  expect(
    await filtered({ field: "year", op: "in", value: [{ i64: "2024" }, { i64: "2026" }] }),
  ).toEqual(["a", "c"]);
  const limited = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "typed-filter", "query", {
        ...textQuery("rust", 1, [{ field: "tags", op: "contains", value: "y" }]),
      })
    ).json(),
  );
  expect(limited.rows).toHaveLength(1);
  expect(["a", "b"]).toContain(limited.rows[0]?.id);
});

test("typed vector queries apply filters before vector top-k and replay Log 3", async () => {
  const vectors = {
    near: typedDocument(
      "near",
      "alpha",
      { year: { i64: "1" }, count: { u64: "1" }, tags: ["no"] },
      [1, 0, 0, 0],
    ),
    far: typedDocument(
      "far",
      "beta",
      { year: { i64: "2" }, count: { u64: "2" }, tags: ["yes"] },
      [0, 1, 0, 0],
    ),
  };
  await ok(await request(worker, "typed-vector", "write", typedWrite("v", Object.values(vectors))));
  const search = async (filters: unknown[]) =>
    Schema.decodeUnknownSync(QueryResult)(
      await (
        await ok(
          await request(worker, "typed-vector", "query", {
            kind: "vector",
            vector: [1, 0, 0, 0],
            topK: 1,
            filters,
          }),
        )
      ).json(),
    );
  expect((await search([])).rows.map((row) => row.id)).toEqual(["near"]);
  expect(
    (await search([{ field: "tags", op: "contains", value: "yes" }])).rows.map((row) => row.id),
  ).toEqual(["far"]);
  expect((await metadata("typed-vector")).vectorOutbox).toBe(1);
  await ok(await request(worker, "typed-vector", "vector-sync", {}));
  expect((await metadata("typed-vector")).vectorOutbox).toBe(0);
  const logs = await (
    await worker.getR2Bucket("STORAGE")
  ).list({
    prefix: "namespaces/typed-vector/log/",
  });
  expect(logs.objects).toHaveLength(1);
  const object = await (await worker.getR2Bucket("STORAGE")).get(logs.objects[0]?.key ?? "");
  const log = Schema.decodeUnknownSync(Schema.fromJsonString(Log), { onExcessProperty: "error" })(
    unpack(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))),
  );
  expect(log.version).toBe(3);
  expect(log.write).toMatchObject({ kind: "typed", requestId: "v" });
  const rebuilt = await request(worker, "typed-vector", "vector-rebuild", {});
  expect(rebuilt.status, await rebuilt.clone().text()).toBe(200);
});

test("tombstones and replacements remove typed documents from every result", async () => {
  await ok(await request(worker, "typed-dead", "write", typedWrite("one", Object.values(rows))));
  await ok(
    await request(
      worker,
      "typed-dead",
      "write",
      typedWrite(
        "two",
        [typedDocument("a", "replaced", { year: { i64: "1" }, count: { u64: "1" }, tags: ["z"] })],
        ["b"],
      ),
    ),
  );
  expect(ids(await query("typed-dead"))).toEqual(["c"]);
  expect(ids(await query("typed-dead", [{ field: "tags", op: "contains", value: "y" }]))).toEqual(
    [],
  );
  expect(
    ids(await query("typed-dead", [{ field: "tags", op: "contains", value: "z" }], "replaced")),
  ).toEqual(["a"]);
  expect((await metadata("typed-dead")).documents).toBe(2);
});

test("receipts are idempotent over normalized declarations and reject changed payloads", async () => {
  const first = await ok(
    await request(worker, "typed-receipt", "write", typedWrite("same", [rows.a])),
  );
  const reordered = await ok(
    await request(
      worker,
      "typed-receipt",
      "write",
      typedWrite(
        "same",
        [
          {
            ...rows.a,
            attributes: Object.fromEntries(Object.entries(rows.a.attributes).toReversed()),
          },
        ],
        [],
        {
          declaration: { ...declaration, columns: declaration.columns.toReversed() },
        },
      ),
    ),
  );
  expect(await reordered.json()).toEqual(await first.json());
  expect((await metadata("typed-receipt")).sequence).toBe(1);
  const changed = await request(worker, "typed-receipt", "write", typedWrite("same", [rows.b]));
  expect(changed.status).toBe(409);
  const schemaChange = await request(
    worker,
    "typed-receipt",
    "write",
    typedWrite("other", [rows.b], [], {
      declaration: {
        ...declaration,
        columns: declaration.columns.map((column) =>
          Object.assign({}, column, column.name === "score" && { nullable: false }),
        ),
      },
    }),
  );
  expect(schemaChange.status).toBe(409);
  expect(
    (
      await request(
        worker,
        "typed-receipt",
        "write",
        typedWrite("omitted", [rows.b], [], { declaration: undefined }),
      )
    ).status,
  ).toBe(200);
});

test("typed ingress rejects unknown flags, undeclared and mistyped attributes", async () => {
  const rejected = async (body: unknown, namespace = "typed-reject") =>
    (await request(worker, namespace, "write", body)).status;
  for (const flag of ["fullText", "vector", "inference", "drop"])
    expect(
      await rejected(
        typedWrite("flag", [], [], {
          declaration: { columns: [{ name: "a", type: "u64", [flag]: true }] },
        }),
      ),
    ).toBe(400);
  const bad = (attributes: Record<string, unknown>, id: string) =>
    typedWrite(id, [typedDocument("a", "text", attributes)]);
  expect(await rejected(bad({ undeclared: "x" }, "u"))).toBe(400);
  expect(await rejected(bad({ count: { i64: "1" }, year: { i64: "1" }, tags: [] }, "t"))).toBe(400);
  expect(await rejected(bad({ count: null }, "n"))).toBe(400);
  expect(await rejected(bad({ count: 1 }, "bare"))).toBe(400);
  expect(await rejected(bad({ count: { u64: "18446744073709551616" } }, "overflow"))).toBe(400);
  expect(await rejected(bad({ tags: [{ u64: "1" }] }, "array"))).toBe(400);
  expect((await metadata("typed-reject")).sequence).toBe(0);
  expect(
    await rejected(
      typedWrite("missing", [rows.a], [], { declaration: undefined }),
      "typed-undeclared",
    ),
  ).toBe(400);
});

test("typed and native namespaces are not silently interchangeable", async () => {
  await ok(await request(worker, "typed-kind", "write", typedWrite("one", [rows.a])));
  expect(
    (await request(worker, "typed-kind", "write", write([document("n", "native")]))).status,
  ).toBe(409);
  await ok(await request(worker, "native-kind", "write", write([document("n", "native rust")])));
  expect((await request(worker, "native-kind", "write", typedWrite("t", [rows.a]))).status).toBe(
    409,
  );
  await ok(
    await request(worker, "native-kind", "write", typedWrite("t", [rows.a], [], { reset: true })),
  );
  expect(ids(await query("native-kind"))).toEqual(["a"]);
  expect((await metadata("native-kind")).columns).toBeDefined();
});

test("typed filters fail before query for undeclared, nonfilterable and incompatible usage", async () => {
  await ok(await request(worker, "typed-bad-filter", "write", typedWrite("one", [rows.a])));
  const status = async (filter: unknown, namespace = "typed-bad-filter") =>
    (await request(worker, namespace, "query", textQuery("rust", 10, [filter]))).status;
  for (const filter of [
    { field: "undeclared", op: "eq", value: "x" },
    { field: "payload", op: "exists", value: true },
    { field: "note", op: "eq", value: "x" },
    { field: "count", op: "eq", value: 1 },
    { field: "count", op: "eq", value: { i64: "1" } },
    { field: "count", op: "contains", value: { u64: "1" } },
    { field: "tags", op: "gt", value: "x" },
    { field: "tags", op: "contains", value: { u64: "1" } },
    { field: "count", op: "in", value: [{ u64: "1" }, "x"] },
  ])
    expect(await status(filter), JSON.stringify(filter)).toBe(400);
  await ok(
    await request(
      worker,
      "native-tag-filter",
      "write",
      write([document("n", "rust", { count: 1 })]),
    ),
  );
  expect(await status({ field: "count", op: "eq", value: { u64: "1" } }, "native-tag-filter")).toBe(
    400,
  );
  expect(await status({ field: "count", op: "eq", value: 1 }, "native-tag-filter")).toBe(200);
});

test("restart, compaction and rebuild retain typed cells byte-exact", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "kannin-typed-columns-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const namespace = "typed-durable";
  const filters = [{ field: "count", op: "gte", value: { u64: "9007199254740993" } }];
  const before = await (async () => {
    const writer = await startWorker(persistence);
    await using lifetime = new AsyncDisposableStack();
    lifetime.defer(() => writer.dispose());
    for (const [index, row] of Object.values(rows).entries())
      await ok(await request(writer, namespace, "write", typedWrite(`w${index}`, [row])));
    await ok(await request(writer, namespace, "write", typedWrite("gone", [], ["c"])));
    const response = await ok(
      await request(writer, namespace, "query", textQuery("rust", 100, filters)),
    );
    return Schema.decodeUnknownSync(QueryResult)(await response.json());
  })();
  expect(ids(before)).toEqual(["a", "b"]);
  const reader = await startWorker(persistence);
  cleanup.defer(() => reader.dispose());
  const read = async () =>
    Schema.decodeUnknownSync(QueryResult)(
      await (
        await ok(await request(reader, namespace, "query", textQuery("rust", 100, filters)))
      ).json(),
    );
  expect(await read()).toEqual(before);
  const initial = Schema.decodeUnknownSync(Metadata)(
    await (await request(reader, namespace, "metadata")).json(),
  );
  expect(initial.segments).toBe(3);
  const compacted = Schema.decodeUnknownSync(CompactResult)(
    await (await ok(await request(reader, namespace, "compact", {}))).json(),
  );
  expect(compacted.segments).toBe(1);
  expect(await read()).toEqual(before);
  await ok(await request(reader, namespace, "rebuild", {}));
  expect(await read()).toEqual(before);
  const result = await read();
  expect(result.rows.find((row) => row.id === "a")?.attributes).toEqual(rows.a.attributes);
  const object = await (
    await reader.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  const root = decodeRoot((await object?.text()) ?? "");
  expect(
    root.schema?.columns.some(
      (column) => column.source === "attribute" && column.value === "typed",
    ),
  ).toBe(true);
});

test("native segments and logs keep their historical formats beside typed namespaces", async () => {
  await ok(
    await request(worker, "native-bytes", "write", write([document("n", "rust", { year: 2024 })])),
  );
  await ok(
    await request(worker, "native-bytes", "write", {
      kind: "canonical",
      requestId: "canonical",
      idType: "string",
      upserts: [{ id: "c", roles: { title: "", text: "rust" }, attributes: { year: 2025 } }],
      deletes: [],
    }),
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const object of await segmentKeys("native-bytes")) {
    const bytes = new Uint8Array(
      (await (await bucket.get(object.key))?.arrayBuffer()) ?? new ArrayBuffer(0),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).not.toBe("RAIOSEG6");
  }
  const versions: number[] = [];
  const logs = await bucket.list({ prefix: "namespaces/native-bytes/log/" });
  for (const object of logs.objects) {
    const stored = await bucket.get(object.key);
    versions.push(
      Schema.decodeUnknownSync(Schema.fromJsonString(Log), { onExcessProperty: "error" })(
        unpack(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))),
      ).version,
    );
  }
  expect(versions.toSorted()).toEqual([1, 2]);
  const described = await metadata("native-bytes");
  expect(described.columns).toBeUndefined();
  const result = await query("native-bytes", [{ field: "year", op: "gte", value: 2025 }]);
  expect(result.rows.map((row) => row.attributes)).toEqual([{ year: 2025 }]);
});

test("Root 7 migrates to Root 8 by envelope without rewriting segments", async () => {
  await ok(
    await request(worker, "root-seven", "write", write([document("n", "rust", { year: 2024 })])),
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootKey = "namespaces/root-seven/root.json";
  const current = await bucket.get(rootKey);
  const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRoot))(
    (await current?.text()) ?? "",
  );
  const segmentsBefore = await segmentKeys("root-seven");
  const before = await query("root-seven");
  await bucket.put(rootKey, JSON.stringify({ ...stored, version: 7 }));
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: "root-seven" });
  const migrated = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await ok(await request(worker, "root-seven", "migrate-root", {}))).json(),
  );
  expect(migrated).toMatchObject({
    version: 8,
    sequence: stored.sequence,
    rootRewritten: true,
  });
  const rewritten = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRoot))(
    (await (await bucket.get(rootKey))?.text()) ?? "",
  );
  expect(rewritten).toEqual(stored);
  const segmentsAfter = await segmentKeys("root-seven");
  expect(segmentsAfter.map((object) => [object.key, object.etag])).toEqual(
    segmentsBefore.map((object) => [object.key, object.etag]),
  );
  expect(await query("root-seven")).toEqual(before);
  const repeated = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await ok(await request(worker, "root-seven", "migrate-root", {}))).json(),
  );
  expect(repeated).toMatchObject({ version: 8, rootRewritten: false });
});

test("an empty typed namespace keeps its mode across restart, writes and migration", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "kannin-typed-empty-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const namespace = "typed-empty";
  const emptyDeclaration = { columns: [] };
  const emptyWrite = (
    requestId: string,
    upserts: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({
    kind: "typed",
    requestId,
    idType: "string",
    upserts,
    deletes: [],
    ...extra,
  });
  {
    const writer = await startWorker(persistence);
    await using lifetime = new AsyncDisposableStack();
    lifetime.defer(() => writer.dispose());
    await ok(
      await request(
        writer,
        namespace,
        "write",
        emptyWrite("declare", [], { declaration: emptyDeclaration }),
      ),
    );
  }
  const reader = await startWorker(persistence);
  cleanup.defer(() => reader.dispose());
  const described = Schema.decodeUnknownSync(Metadata)(
    await (await ok(await request(reader, namespace, "metadata"))).json(),
  );
  expect(described.schema).toBeNull();
  expect(described.sequence).toBe(1);
  expect(described.columns?.columns).toEqual([
    { source: "native-vector" },
    { source: "typed-namespace" },
  ]);
  expect((await request(reader, namespace, "write", write([document("n", "native")]))).status).toBe(
    409,
  );
  expect(
    (
      await request(
        reader,
        namespace,
        "write",
        emptyWrite("undeclared", [typedDocument("a", "rust", { extra: "x" })]),
      )
    ).status,
  ).toBe(400);
  await ok(
    await request(
      reader,
      namespace,
      "write",
      emptyWrite("plain", [typedDocument("a", "rust", {})]),
    ),
  );
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await ok(await request(reader, namespace, "query", textQuery("rust", 10)))).json(),
  );
  expect(result.rows).toMatchObject([{ id: "a", attributes: {} }]);
  expect(
    (
      await request(
        reader,
        namespace,
        "query",
        textQuery("rust", 10, [{ field: "extra", op: "eq", value: "x" }]),
      )
    ).status,
  ).toBe(400);
  const migrated = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await ok(await request(reader, namespace, "migrate-root", {}))).json(),
  );
  expect(migrated).toMatchObject({ version: 8, sequence: 2, rootRewritten: false });
  const after = Schema.decodeUnknownSync(Metadata)(
    await (await request(reader, namespace, "metadata")).json(),
  );
  expect(after.columns).toEqual(described.columns);
  await reader.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  expect((await request(reader, namespace, "write", write([document("m", "native")]))).status).toBe(
    409,
  );
  const stored = await (
    await reader.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  expect(decodeRoot((await stored?.text()) ?? "").schema?.columns[1]).toEqual({
    source: "typed-namespace",
  });
});
