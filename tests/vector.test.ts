import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult, Metadata } from "../src/protocol";
import { request, startWorker } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());
const vector = (x: number, y = 0) => [x, y, ...Array.from({ length: 766 }, () => 0)];
const query = (kind: "vector" | "hybrid" = "vector") => ({
  kind,
  vector: vector(1),
  text: "lexical",
  topK: 10,
  filters: [],
});
const vectorQuery = () => ({ kind: "vector", vector: vector(1), topK: 10, filters: [] });
async function mode(path: string) {
  const service = await worker.getWorker("vectors");
  await service.fetch(`http://fixture${path}`);
}

test("vector dimensions and zero magnitude fail before persistence", async () => {
  for (const values of [[1, 0], Array.from({ length: 768 }, () => 0)]) {
    expect(
      (
        await request(worker, "dimension", "write", {
          requestId: crypto.randomUUID(),
          upserts: [{ id: "a", text: "lexical", attributes: {}, vector: values }],
          deletes: [],
        })
      ).status,
    ).toBe(400);
  }
  expect(
    Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, "dimension", "metadata")).json(),
    ).sequence,
  ).toBe(0);
});

test("vector outbox survives provider failure and retries", async () => {
  await mode("/fail");
  expect(
    (
      await request(worker, "retry", "write", {
        requestId: "one",
        upserts: [{ id: "a", text: "lexical", attributes: {}, vector: vector(1) }],
        deletes: [],
      })
    ).status,
  ).toBe(200);
  expect((await request(worker, "retry", "vector-sync", {})).status).toBe(503);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "retry", "metadata")).json())
      .vectorOutbox,
  ).toBe(1);
  await mode("/healthy");
  expect((await request(worker, "retry", "vector-sync", {})).status).toBe(200);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "retry", "query", vectorQuery())).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["a"]);
  expect(found.consistency).toBe("vectorize-eventual");
});

test("delayed obsolete vectors cannot impersonate newer document revisions", async () => {
  await mode("/defer");
  await request(worker, "revision", "write", {
    requestId: "old",
    upserts: [{ id: "a", text: "old", attributes: {}, vector: vector(1) }],
    deletes: [],
  });
  await request(worker, "revision", "vector-sync", {});
  await request(worker, "revision", "write", {
    requestId: "new",
    upserts: [{ id: "a", text: "new", attributes: {}, vector: vector(0.6, 0.8) }],
    deletes: [],
  });
  await request(worker, "revision", "vector-sync", {});
  await mode("/commit-reversed");
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "revision", "query", vectorQuery())).json(),
  );
  expect(found.rows.map((row) => row.text)).toEqual(["new"]);
  expect(found.rows[0].score).toBeCloseTo(0.6);
});

test("deletion hides stale Vectorize results immediately", async () => {
  await request(worker, "delete", "write", {
    requestId: "create",
    upserts: [{ id: "a", text: "lexical", attributes: {}, vector: vector(1) }],
    deletes: [],
  });
  await request(worker, "delete", "vector-sync", {});
  await request(worker, "delete", "write", { requestId: "delete", upserts: [], deletes: ["a"] });
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "delete", "query", vectorQuery())).json(),
  );
  expect(found.rows).toEqual([]);
});

test("vectors are namespace isolated", async () => {
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "empty-vector-namespace", "query", vectorQuery())).json(),
  );
  expect(found.rows).toEqual([]);
});

test("hybrid combines lexical and vector ranking using RRF", async () => {
  await request(worker, "hybrid", "write", {
    requestId: "hybrid",
    upserts: [
      { id: "both", text: "lexical lexical", attributes: { group: "a" }, vector: vector(1) },
      { id: "text", text: "lexical", attributes: { group: "b" } },
      { id: "vector", text: "unrelated", attributes: { group: "b" }, vector: vector(0.8, 0.6) },
    ],
    deletes: [],
  });
  await request(worker, "hybrid", "vector-sync", {});
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "hybrid", "query", query("hybrid"))).json(),
  );
  expect(result.rows[0].id).toBe("both");
  expect(result.rows[0].score).toBeCloseTo(2 / 61);
  const filtered = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "hybrid", "query", {
        ...vectorQuery(),
        filters: [{ field: "group", op: "eq", value: "b" }],
      })
    ).json(),
  );
  expect(filtered.rows.map((row) => row.id)).toEqual(["vector"]);
});
