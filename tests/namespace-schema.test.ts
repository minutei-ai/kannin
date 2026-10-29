import { decodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  CompactResult,
  Metadata,
  NamespaceSchema,
  QueryResult,
  WriteResult,
} from "../src/protocol";
import { request, startWorker, textQuery } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("declared headers stay compact across reload and compaction while source attributes remain intact", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "kannin-indexed-attributes-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const documents = Array.from({ length: 20 }, (_, index) => ({
    id: String(index).padStart(2, "0"),
    text: `rust unique${index}`,
    attributes: {
      year: 2024 + (index % 2),
      externalId: index,
      padding: "x".repeat(4096),
      flag: index % 2 === 0,
      empty: null,
    },
  }));
  const headers = { unconfigured: 0, year: 0, empty: 0 };
  {
    const writer = await startWorker(persistence);
    await using lifetime = new AsyncDisposableStack();
    lifetime.defer(() => writer.dispose());
    const bucket = await writer.getR2Bucket("STORAGE");
    for (const [name, schema] of [
      ["unconfigured", undefined],
      ["year", { filterable: ["year"], vectorFilterFields: [] }],
      ["empty", { filterable: [], vectorFilterFields: [] }],
    ] as const) {
      for (const batch of [0, 1]) {
        const response = await request(writer, `projection-${name}`, "write", {
          requestId: `batch-${batch}`,
          schema,
          upserts: documents.slice(batch * 10, batch * 10 + 10),
          deletes: [],
        });
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const stored = await bucket.get(`namespaces/projection-${name}/root.json`);
      expect(stored).not.toBeNull();
      if (stored === null) return;
      const root = decodeRoot(await stored.text());
      expect(root.documents).toBe(20);
      expect(root.segments).toHaveLength(2);
      headers[name] = root.segments.reduce((sum, segment) => sum + segment.headerBytes, 0);
    }
  }
  expect(headers.year).toBeLessThan(headers.unconfigured / 8);
  expect(headers.empty).toBeLessThan(headers.year);
  const reader = await startWorker(persistence);
  cleanup.defer(() => reader.dispose());
  for (const name of ["unconfigured", "year", "empty"]) {
    for (const consistency of ["strong", "edge-eventual"] as const) {
      const response = await request(reader, `projection-${name}`, "query", {
        ...textQuery("rust"),
        consistency,
        minimumSequence: 2,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.rows.map((row) => row.attributes)).toEqual(
        documents.slice(0, 10).map((document) => document.attributes),
      );
    }
  }
  const configure = await request(reader, "projection-unconfigured", "write", {
    requestId: "configure",
    schema: { filterable: ["year"], vectorFilterFields: [] },
    upserts: [],
    deletes: [],
  });
  expect(configure.status).toBe(200);
  const query = textQuery("rust", 10, [{ field: "year", op: "eq", value: 2025 }]);
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(reader, "projection-year", "query", query)).json(),
  );
  const migrated = Schema.decodeUnknownSync(QueryResult)(
    await (await request(reader, "projection-unconfigured", "query", query)).json(),
  );
  expect(migrated.rows).toEqual(original.rows);
  const bucket = await reader.getR2Bucket("STORAGE");
  for (const namespace of ["projection-year", "projection-unconfigured"]) {
    const compact = await request(reader, namespace, "compact", {});
    expect(compact.status).toBe(200);
    expect(Schema.decodeUnknownSync(CompactResult)(await compact.json())).toEqual({
      compacted: 2,
      segments: 1,
      documents: 20,
    });
    expect((await request(reader, namespace, "rebuild", {})).status).toBe(200);
    const stored = await bucket.get(`namespaces/${namespace}/root.json`);
    expect(stored).not.toBeNull();
    if (stored === null) return;
    const root = decodeRoot(await stored.text());
    expect(root.segments.reduce((sum, segment) => sum + segment.headerBytes, 0)).toBeLessThan(
      headers.unconfigured / 8,
    );
    const result = Schema.decodeUnknownSync(QueryResult)(
      await (await request(reader, namespace, "query", query)).json(),
    );
    expect(result.rows).toEqual(original.rows);
  }
  expect(
    (
      await request(
        reader,
        "projection-year",
        "query",
        textQuery("rust", 10, [{ field: "padding", op: "exists", value: true }]),
      )
    ).status,
  ).toBe(400);
});

test("attributes remain stored but cannot be filtered without an explicit namespace schema", async () => {
  const created = await request(worker, "unconfigured", "write", {
    requestId: "seed",
    upserts: [{ id: "a", text: "rust", attributes: { customer: "one", secret: "stored" } }],
    deletes: [],
  });
  expect(created.status).toBe(200);
  const query = textQuery("rust", 10, [{ field: "customer", op: "eq", value: "one" }]);
  expect((await request(worker, "unconfigured", "query", query)).status).toBe(400);
  const before = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "unconfigured", "metadata")).json(),
  );
  expect(before.schema).toBeNull();
  const configure = {
    requestId: "configure",
    schema: { filterable: ["customer"], vectorFilterFields: [] },
    upserts: [],
    deletes: [],
  };
  const configured = await request(worker, "unconfigured", "write", configure);
  expect(configured.status).toBe(200);
  const receipt = Schema.decodeUnknownSync(WriteResult)(await configured.json());
  expect(receipt.sequence).toBe(2);
  const retry = await request(worker, "unconfigured", "write", configure);
  expect(Schema.decodeUnknownSync(WriteResult)(await retry.json())).toEqual(receipt);
  expect((await request(worker, "unconfigured", "rebuild", {})).status).toBe(200);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "unconfigured", "query", query)).json(),
  );
  expect(found.rows.map((row) => row.attributes)).toEqual([{ customer: "one", secret: "stored" }]);
  for (const consistency of ["strong", "edge-eventual"])
    expect(
      (
        await request(worker, "unconfigured", "query", {
          ...textQuery("rust", 10, [{ field: "secret", op: "exists", value: true }]),
          consistency,
          minimumSequence: receipt.sequence,
        })
      ).status,
    ).toBe(400);
  const after = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "unconfigured", "metadata")).json(),
  );
  expect(after.schema).toEqual(configure.schema);
  expect(after.documents).toBe(1);
});

test("schema changes require an explicit reset and preserve idempotency", async () => {
  const original = {
    requestId: "seed",
    schema: { filterable: ["old"], vectorFilterFields: [] },
    upserts: [{ id: "a", text: "rust", attributes: { old: true, fresh: true } }],
    deletes: [],
  };
  expect((await request(worker, "reset-schema", "write", original)).status).toBe(200);
  const changed = {
    requestId: "change",
    schema: { filterable: ["fresh"], vectorFilterFields: [] },
    upserts: original.upserts,
    deletes: [],
  };
  expect((await request(worker, "reset-schema", "write", changed)).status).toBe(409);
  const reset = { ...changed, reset: true };
  const response = await request(worker, "reset-schema", "write", reset);
  expect(response.status).toBe(200);
  const receipt = Schema.decodeUnknownSync(WriteResult)(await response.json());
  expect(
    Schema.decodeUnknownSync(WriteResult)(
      await (await request(worker, "reset-schema", "write", reset)).json(),
    ),
  ).toEqual(receipt);
  expect(
    (
      await request(
        worker,
        "reset-schema",
        "query",
        textQuery("rust", 10, [{ field: "old", op: "exists", value: true }]),
      )
    ).status,
  ).toBe(400);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        "reset-schema",
        "query",
        textQuery("rust", 10, [{ field: "fresh", op: "eq", value: true }]),
      )
    ).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["a"]);
});

test("namespace schema rejects duplicate, excessive and undeclared vector fields", () => {
  for (const input of [
    { filterable: ["a", "a"], vectorFilterFields: [] },
    { filterable: [], vectorFilterFields: ["a"] },
    { filterable: ["a"], vectorFilterFields: ["a", "a"] },
    {
      filterable: ["a", "b", "c", "d", "e", "f"],
      vectorFilterFields: ["a", "b", "c", "d", "e", "f"],
    },
    {
      filterable: Array.from({ length: 65 }, (_, index) => `field${index}`),
      vectorFilterFields: [],
    },
  ])
    expect(Schema.is(NamespaceSchema)(input)).toBe(false);
});

test("namespace-local canonical filters are immediately visible after schema-only configuration", async () => {
  const vector = [1, ...Array.from({ length: 767 }, () => 0)];
  for (const field of ["customer", "region"]) {
    const namespace = `schema-${field}`;
    const schema = { filterable: [field], vectorFilterFields: [field] };
    const write = await request(worker, namespace, "write", {
      requestId: "seed",
      schema,
      upserts: [
        { id: field, text: "rust", attributes: { [field]: "selected", hidden: true }, vector },
      ],
      deletes: [],
    });
    expect(write.status).toBe(200);
    expect((await request(worker, namespace, "vector-sync", {})).status).toBe(200);
    const common = { topK: 10, filters: [{ field, op: "eq", value: "selected" }] };
    for (const input of [
      { kind: "text", text: "rust", ...common },
      { kind: "vector", vector, ...common },
      { kind: "hybrid", text: "rust", vector, ...common },
    ]) {
      const result = await request(worker, namespace, "query", input);
      expect(result.status, await result.clone().text()).toBe(200);
      expect(
        Schema.decodeUnknownSync(QueryResult)(await result.json()).rows.map((row) => row.id),
      ).toEqual([field]);
      expect(
        (
          await request(worker, namespace, "query", {
            ...input,
            filters: [{ field: "hidden", op: "eq", value: true }],
          })
        ).status,
      ).toBe(400);
    }
  }
  expect(
    (
      await request(worker, "schema-migrate", "write", {
        requestId: "seed",
        upserts: [{ id: "a", text: "rust", attributes: { customer: "selected" }, vector }],
        deletes: [],
      })
    ).status,
  ).toBe(200);
  expect((await request(worker, "schema-migrate", "vector-sync", {})).status).toBe(200);
  expect(
    (
      await request(worker, "schema-migrate", "write", {
        requestId: "configure",
        schema: { filterable: ["customer"], vectorFilterFields: ["customer"] },
        upserts: [],
        deletes: [],
      })
    ).status,
  ).toBe(200);
  const input = {
    kind: "vector",
    vector,
    topK: 10,
    filters: [{ field: "customer", op: "eq", value: "selected" }],
  };
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "schema-migrate", "query", input)).json(),
  );
  expect(before.rows.map((row) => row.id)).toEqual(["a"]);
  expect(before.consistency).toBe("strong");
  expect((await request(worker, "schema-migrate", "vector-rebuild", {})).status).toBe(200);
  const after = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "schema-migrate", "query", input)).json(),
  );
  expect(after).toEqual(before);
});

test("scalar arrays survive queries, replacement and canonical maintenance", async () => {
  const namespace = "array-attributes";
  const vector = [1, 0];
  const attributes = {
    tags: ["ação", "😀"],
    scores: [0, 1.5, -2],
    empty: [],
    mixed: [null, true, "x", 1],
  };
  expect(
    (
      await request(worker, namespace, "write", {
        requestId: "seed",
        schema: {
          filterable: ["tags", "scores", "empty", "mixed"],
          vectorFilterFields: [],
          vectorDimensions: 2,
        },
        upserts: [
          { id: "a", text: "arrays record", attributes, vector },
          { id: "b", text: "arrays record", attributes: { tags: null }, vector },
          { id: "c", text: "arrays record", attributes: {}, vector },
        ],
        deletes: [],
      })
    ).status,
  ).toBe(200);
  const inputs = [
    textQuery("arrays"),
    { kind: "vector", vector, topK: 10, filters: [] },
    { kind: "hybrid", text: "arrays", vector, topK: 10, filters: [] },
  ];
  for (const input of inputs) {
    const response = await request(worker, namespace, "query", input);
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(result.rows[0]?.attributes).toEqual(attributes);
    for (const [filter, ids] of [
      [{ field: "tags", op: "exists", value: true }, ["a", "b"]],
      [{ field: "tags", op: "eq", value: null }, ["b"]],
      [{ field: "tags", op: "ne", value: null }, ["a", "c"]],
      [{ field: "tags", op: "contains", value: "ação" }, ["a"]],
      [{ field: "tags", op: "notContains", value: "ação" }, ["b", "c"]],
      [{ field: "tags", op: "containsAny", value: ["absent", "😀"] }, ["a"]],
      [{ field: "tags", op: "notContainsAny", value: ["absent", "😀"] }, ["b", "c"]],
      [{ field: "tags", op: "containsAny", value: [] }, []],
      [{ field: "tags", op: "notContainsAny", value: [] }, ["a", "b", "c"]],
    ] as const) {
      const filtered = await request(worker, namespace, "query", { ...input, filters: [filter] });
      expect(filtered.status).toBe(200);
      expect(
        Schema.decodeUnknownSync(QueryResult)(await filtered.json()).rows.map((row) => row.id),
      ).toEqual([...ids]);
    }
  }
  for (const filter of [
    { field: "tags", op: "containsAny", value: Array.from({ length: 33 }, () => "ação") },
    { field: "tags", op: "contains", value: [] },
    { field: "tags", op: "in", value: [] },
  ])
    expect(
      (
        await request(worker, namespace, "query", {
          kind: "vector",
          vector,
          topK: 1,
          filters: [filter],
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await request(worker, namespace, "write", {
        requestId: "replace",
        upserts: [
          {
            id: "a",
            text: "arrays record",
            attributes: { tags: ["changed"], scores: [8, 9] },
            vector,
          },
        ],
        deletes: ["b"],
      })
    ).status,
  ).toBe(200);
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("arrays"))).json(),
  );
  expect(before.rows.map((row) => row.id)).toEqual(["a", "c"]);
  expect(before.rows[0]?.attributes).toEqual({ tags: ["changed"], scores: [8, 9] });
  for (const operation of ["compact", "rebuild", "vector-sync", "vector-rebuild"])
    expect((await request(worker, namespace, operation, {})).status).toBe(200);
  const after = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("arrays"))).json(),
  );
  expect(after.rows).toEqual(before.rows);
  expect(after.sequence).toBe(2);
});

test("oversized, nested and object-valued arrays fail before persistence", async () => {
  const namespace = "invalid-array-attributes";
  for (const values of [Array.from({ length: 4097 }, () => 1), [[1]], [{}]])
    expect(
      (
        await request(worker, namespace, "write", {
          requestId: crypto.randomUUID(),
          upserts: [{ id: "a", text: "arrays", attributes: { values } }],
          deletes: [],
        })
      ).status,
    ).toBe(400);
  const bucket = await worker.getR2Bucket("STORAGE");
  expect(await bucket.head(`namespaces/${namespace}/root.json`)).toBeNull();
});
