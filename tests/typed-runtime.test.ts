import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult, WriteResult } from "../src/protocol";
import { request, startWorker } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

const id = (value: string) => ({ kind: "uint" as const, value });

test("workerd preserves uint64 IDs and applies filters and tombstones before every top-k", async () => {
  const namespace = "typed-worker-runtime";
  const write = {
    kind: "canonical",
    requestId: "seed",
    idType: "uint",
    schema: { filterable: ["group"], vectorFilterFields: ["group"], vectorDimensions: 2 },
    upserts: ["18446744073709551615", "10", "2"].map((value) => ({
      id: id(value),
      roles: { title: "", text: "identity" },
      attributes: { group: "selected" },
      vector: [1, 0],
    })),
    deletes: [],
  };
  write.upserts[0] = {
    id: id("18446744073709551615"),
    roles: { title: "", text: "identity" },
    attributes: { group: "excluded" },
    vector: [1, 0],
  };
  const response = await request(worker, namespace, "write", write);
  expect(response.status).toBe(200);
  const receipt = Schema.decodeUnknownSync(WriteResult)(await response.json());
  expect(receipt.sequence).toBe(1);
  for (const query of [
    { kind: "text", text: "identity" },
    { kind: "vector", vector: [1, 0] },
    { kind: "hybrid", text: "identity", vector: [1, 0] },
  ]) {
    const selected = await request(worker, namespace, "query", {
      ...query,
      topK: 2,
      filters: [{ field: "group", op: "eq", value: "selected" }],
      minimumSequence: 1,
    });
    expect(selected.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await selected.json());
    expect(result.rows.map((row) => row.id)).toEqual([id("2"), id("10")]);
  }
  const removed = await request(worker, namespace, "write", {
    kind: "canonical",
    requestId: "delete",
    idType: "uint",
    upserts: [],
    deletes: [id("2")],
  });
  expect(removed.status).toBe(200);
  for (const query of [
    { kind: "text", text: "identity" },
    { kind: "vector", vector: [1, 0] },
    { kind: "hybrid", text: "identity", vector: [1, 0] },
  ]) {
    const selected = await request(worker, namespace, "query", {
      ...query,
      topK: 1,
      filters: [{ field: "group", op: "eq", value: "selected" }],
      minimumSequence: 2,
    });
    expect(selected.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await selected.json());
    expect(result.rows.map((row) => row.id)).toEqual([id("10")]);
    expect(result.sequence).toBe(2);
  }
});
