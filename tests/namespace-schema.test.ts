import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Metadata, NamespaceSchema, QueryResult, WriteResult } from "../src/protocol";
import { request, startWorker, textQuery } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

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

test("each namespace assigns its own Vectorize slots and schema-only migration isolates old metadata", async () => {
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
  expect(before.rows).toEqual([]);
  expect((await request(worker, "schema-migrate", "vector-rebuild", {})).status).toBe(200);
  const after = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "schema-migrate", "query", input)).json(),
  );
  expect(after.rows.map((row) => row.id)).toEqual(["a"]);
});
