import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult, WriteResult, Metadata, ErrorBody } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const state = { worker: await startWorker() };
afterAll(async () => {
  await state.worker.dispose();
});

test("health and authorization run inside workerd", async () => {
  expect(
    (await state.worker.dispatchFetch(new URL("/health", await state.worker.ready))).status,
  ).toBe(200);
  expect(
    (
      await state.worker.dispatchFetch(
        new URL("/v1/namespaces/private/metadata", await state.worker.ready),
      )
    ).status,
  ).toBe(401);
  expect((await request(state.worker, "bad.name", "metadata")).status).toBe(404);
});

test("HTTP errors preserve statuses and use the public error envelope", async () => {
  for (const sample of [
    {
      path: "/v1/namespaces/private/metadata",
      method: "GET",
      authenticated: false,
      body: "",
      status: 401,
      error: "Unauthorized",
    },
    {
      path: "/v2/namespaces/missing/query",
      method: "POST",
      authenticated: true,
      body: "{}",
      status: 404,
      error: "Unknown route",
    },
    {
      path: "/v1/namespaces/error-contract/query",
      method: "GET",
      authenticated: true,
      body: "",
      status: 405,
      error: "Method not allowed",
    },
    {
      path: "/v1/namespaces/error-contract/query",
      method: "POST",
      authenticated: true,
      body: "{",
      status: 400,
      error: "Invalid query contract",
    },
    {
      path: "/v1/namespaces/error-contract/write",
      method: "POST",
      authenticated: true,
      body: "{",
      status: 400,
      error: "Invalid JSON body",
    },
    {
      path: "/v1/namespaces/error-contract/write",
      method: "POST",
      authenticated: true,
      body: "{}",
      status: 400,
      error: "Invalid operation contract",
    },
  ]) {
    const headers = new Headers({ "content-type": "application/json" });
    if (sample.authenticated) headers.set("authorization", "Bearer local-test-token");
    const options: RequestInit = { method: sample.method, headers };
    if (sample.method === "POST") options.body = sample.body;
    const response = await fetch(new URL(sample.path, await state.worker.ready), options);
    expect(response.status).toBe(sample.status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(Schema.decodeUnknownSync(ErrorBody)(await response.json())).toEqual({
      status: "error",
      error: sample.error,
    });
  }
  const input = write([document("one", "first")]);
  expect((await request(state.worker, "error-conflict", "write", input)).status).toBe(200);
  const conflict = await request(state.worker, "error-conflict", "write", {
    ...input,
    upserts: [document("one", "second")],
  });
  expect(conflict.status).toBe(409);
  expect(Schema.decodeUnknownSync(ErrorBody)(await conflict.json())).toEqual({
    status: "error",
    error: "requestId already used with a different payload",
  });
  const bucket = await state.worker.getR2Bucket("STORAGE");
  await bucket.put("namespaces/error-backend/root.json", "private broken root detail");
  const unavailable = await request(state.worker, "error-backend", "metadata");
  expect(unavailable.status).toBe(503);
  expect(Schema.decodeUnknownSync(ErrorBody)(await unavailable.json())).toEqual({
    status: "error",
    error: "Storage or search backend unavailable",
  });
  await bucket.put("namespaces/error-invalid!name/root.json", "{}");
  const enumeration = await fetch(new URL("/admin/namespaces", await state.worker.ready), {
    headers: { authorization: "Bearer local-test-token" },
  });
  expect(enumeration.status).toBe(503);
  expect(enumeration.headers.get("cache-control")).toBe("private, no-store");
  expect(Schema.decodeUnknownSync(ErrorBody)(await enumeration.json())).toEqual({
    status: "error",
    error: "Storage or search backend unavailable",
  });
});

test("committed documents are immediately searchable and isolated", async () => {
  const response = await request(
    state.worker,
    "isolation",
    "write",
    write([document("one", "AÇÃO cloudflare"), document("two", "Rust wasm")]),
  );
  expect(response.status).toBe(200);
  const receipt = Schema.decodeUnknownSync(WriteResult)(await response.json());
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(state.worker, "isolation", "query", textQuery("acao"))).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["one"]);
  expect(found.sequence).toBe(receipt.sequence);
  expect(found.consistency).toBe("strong");
  const other = Schema.decodeUnknownSync(QueryResult)(
    await (await request(state.worker, "other", "query", textQuery("acao"))).json(),
  );
  expect(other.rows).toEqual([]);
});

test("BM25 term frequency and length normalization", async () => {
  const docs = [
    document("short", "cloudflare cloudflare cloudflare rust"),
    document("long", `cloudflare ${"unrelated ".repeat(1000)}`),
    document("miss", "postgres sqlite"),
  ];
  expect((await request(state.worker, "ranking", "write", write(docs))).status).toBe(200);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(state.worker, "ranking", "query", textQuery("cloudflare"))).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["short", "long"]);
  const [first, second] = found.rows;
  if (first === undefined || second === undefined) throw new Error("Expected two ranked rows");
  expect(first.score).toBeGreaterThan(second.score);
});

test("update and deletion remove obsolete posting lists", async () => {
  await request(
    state.worker,
    "mutation",
    "write",
    write([document("a", "oldterm"), document("b", "oldterm")]),
  );
  await request(state.worker, "mutation", "write", write([document("a", "newterm")], ["b"]));
  const old = Schema.decodeUnknownSync(QueryResult)(
    await (await request(state.worker, "mutation", "query", textQuery("oldterm"))).json(),
  );
  const fresh = Schema.decodeUnknownSync(QueryResult)(
    await (await request(state.worker, "mutation", "query", textQuery("newterm"))).json(),
  );
  expect(old.rows).toEqual([]);
  expect(fresh.rows.map((row) => row.id)).toEqual(["a"]);
});

test("idempotent writes and conflicting request ids", async () => {
  const input = write([document("a", "samepayload")]);
  const first = await request(state.worker, "receipts", "write", input);
  const again = await request(state.worker, "receipts", "write", input);
  expect(await first.json()).toEqual(await again.json());
  const conflict = await request(state.worker, "receipts", "write", {
    ...input,
    deletes: ["other"],
  });
  expect(conflict.status).toBe(409);
});

test("filters apply before BM25 top-k and preserve JSON types", async () => {
  await request(
    state.worker,
    "filters",
    "write",
    write([
      document("a", "term term", { group: "a", count: 3, active: true, empty: null }),
      document("b", "term", { group: "b", count: 10, active: false }),
    ]),
  );
  for (const filter of [
    { field: "group", op: "eq", value: "b" },
    { field: "count", op: "gte", value: 5 },
    { field: "active", op: "eq", value: false },
    { field: "group", op: "in", value: ["b", "c"] },
    { field: "empty", op: "exists", value: false },
  ]) {
    const result = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(state.worker, "filters", "query", textQuery("term", 1, [filter]))
      ).json(),
    );
    expect(result.rows.map((row) => row.id)).toEqual(["b"]);
  }
});

test("SQL and FTS syntax stays data", async () => {
  await request(
    state.worker,
    "injection",
    "write",
    write([document("' OR 1=1 --", "near safe search")]),
  );
  expect(
    (
      await request(
        state.worker,
        "injection",
        "query",
        textQuery('" OR * NEAR("; DROP TABLE documents;--'),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        state.worker,
        "injection",
        "query",
        textQuery("safe", 10, [{ field: "x);DROP TABLE documents;--", op: "eq", value: 1 }]),
      )
    ).status,
  ).toBe(400);
  expect(
    Schema.decodeUnknownSync(Metadata)(
      await (await request(state.worker, "injection", "metadata")).json(),
    ).documents,
  ).toBe(1);
});

test("duplicate ids and invalid contracts are rejected without committing", async () => {
  expect(
    (
      await request(
        state.worker,
        "bad",
        "write",
        write([document("a", "hello"), document("a", "again")]),
      )
    ).status,
  ).toBe(400);
  expect(
    (await request(state.worker, "bad", "write", { ...write([]), ignoredFilter: true })).status,
  ).toBe(400);
  expect((await request(state.worker, "bad", "query", textQuery("hello", 0))).status).toBe(400);
  expect((await request(state.worker, "bad", "metadata")).status).toBe(200);
});

test("concurrent writes serialize into distinct durable revisions", async () => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      request(state.worker, "concurrent", "write", write([document(String(index), "parallel")])),
    ),
  );
  expect(responses.every((response) => response.status === 200)).toBe(true);
  const revisions = await Promise.all(
    responses.map(
      async (response) => Schema.decodeUnknownSync(WriteResult)(await response.json()).sequence,
    ),
  );
  expect([...revisions].sort((a, b) => a - b)).toEqual(
    Array.from({ length: 10 }, (_, ordinal) => ordinal + 1),
  );
});

test("R2 logs reconstruct projection and preserve receipts", async () => {
  const input = write([document("a", "recoverable", { source: "r2" })]);
  await request(state.worker, "recovery", "write", input);
  const response = await request(state.worker, "recovery", "rebuild", {});
  expect(response.status).toBe(200);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(state.worker, "recovery", "query", textQuery("recoverable"))).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["a"]);
  expect(
    Schema.decodeUnknownSync(WriteResult)(
      await (await request(state.worker, "recovery", "write", input)).json(),
    ).sequence,
  ).toBe(1);
});

test("long BM25 queries retain every normalized term through cached catalog projection", async () => {
  const terms = Array.from({ length: 512 }, (_, index) => `word${index}`);
  expect(
    (
      await request(
        state.worker,
        "long-query",
        "write",
        write([
          document("complete", terms.join(" ")),
          document("partial", terms.slice(0, 256).join(" ")),
          document("absent", "irrelevant"),
        ]),
      )
    ).status,
  ).toBe(200);
  for (const match of ["any", "all"]) {
    const input = { ...textQuery(terms.join(" ")), match };
    const response = await request(state.worker, "long-query", "query", input);
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    if (match === "all") expect(result.rows.map((row) => row.id)).toEqual(["complete"]);
    else expect(result.rows.map((row) => row.id)).toEqual(["complete", "partial"]);
    const repeated = await request(state.worker, "long-query", "query", input);
    expect(Schema.decodeUnknownSync(QueryResult)(await repeated.json())).toEqual(result);
  }
  expect(
    (await request(state.worker, "long-query", "query", textQuery([...terms, "extra"].join(" "))))
      .status,
  ).toBe(400);
  expect(
    (
      await request(state.worker, "long-query", "query", {
        ...textQuery(terms.slice(0, 65).join(" ")),
        match: "phrase",
      })
    ).status,
  ).toBe(400);
});
