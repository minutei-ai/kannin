import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult, Metadata } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());
async function search(namespace: string, input: ReturnType<typeof textQuery> & { match?: string }) {
  const response = await request(worker, namespace, "query", input);
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(QueryResult)(await response.json());
}

test("title has a deliberate BM25 weight above body", async () => {
  await request(
    worker,
    "title",
    "write",
    write([
      { ...document("title", "common words"), title: "cloudflare rust" },
      document("body", "cloudflare common words"),
    ]),
  );
  expect((await search("title", textQuery("cloudflare"))).rows[0].id).toBe("title");
});

test("any, all, and phrase matching have distinct semantics", async () => {
  await request(
    worker,
    "mode",
    "write",
    write([
      document("phrase", "cloudflare rust search"),
      document("separate", "cloudflare builds using rust"),
      document("one", "cloudflare worker"),
    ]),
  );
  expect((await search("mode", textQuery("cloudflare rust"))).rows.length).toBe(3);
  expect(
    (await search("mode", { ...textQuery("cloudflare rust"), match: "all" })).rows.length,
  ).toBe(2);
  expect(
    (await search("mode", { ...textQuery("cloudflare rust"), match: "phrase" })).rows.map(
      (row) => row.id,
    ),
  ).toEqual(["phrase"]);
});

test("repeated query words do not multiply BM25 scores", async () => {
  await request(worker, "repeated", "write", write([document("a", "rust rust cloudflare")]));
  expect((await search("repeated", textQuery("rust"))).rows[0].score).toEqual(
    (await search("repeated", textQuery("rust rust rust"))).rows[0].score,
  );
});

test("punctuation-only queries return empty results", async () => {
  expect((await search("mode", textQuery('!!! -- * "'))).rows).toEqual([]);
});

test("unicode and accents normalize identically in documents and queries", async () => {
  await request(
    worker,
    "unicode",
    "write",
    write([
      document("pt", "São Paulo: ação e café"),
      document("cjk", "日本語を検索"),
      document("de", "Über ﬂores"),
    ]),
  );
  expect((await search("unicode", textQuery("SAO ACAO CAFE"))).rows[0].id).toBe("pt");
  expect((await search("unicode", textQuery("日本語"))).rows[0].id).toBe("cjk");
  expect((await search("unicode", textQuery("uber flores"))).rows[0].id).toBe("de");
});

test("rare terms outrank common terms with namespace-wide statistics", async () => {
  const documents = Array.from({ length: 50 }, (_, index) =>
    document(`common-${index}`, "common padding"),
  );
  await request(worker, "idf", "write", write([...documents, document("rare", "rare padding")]));
  expect((await search("idf", textQuery("common rare"))).rows[0].id).toBe("rare");
});

test("filter booleans and numbers do not compare equal", async () => {
  await request(
    worker,
    "types",
    "write",
    write([
      document("number", "typed", { value: 1 }),
      document("boolean", "typed", { value: true }),
      document("string", "typed", { value: "1" }),
      document("null", "typed", { value: null }),
      document("missing", "typed"),
    ]),
  );
  for (const [value, id] of [
    [1, "number"],
    [true, "boolean"],
    ["1", "string"],
    [null, "null"],
  ] as const) {
    expect(
      (
        await search("types", textQuery("typed", 10, [{ field: "value", op: "eq", value }]))
      ).rows.map((row) => row.id),
    ).toEqual([id]);
  }
  expect(
    (
      await search("types", textQuery("typed", 10, [{ field: "value", op: "gt", value: 0 }]))
    ).rows.map((row) => row.id),
  ).toEqual(["number"]);
});

test("filter combinations are conjunctive and run before top-k", async () => {
  await request(
    worker,
    "and",
    "write",
    write([
      document("a", "query query query", { year: 2020, source: "a" }),
      document("b", "query", { year: 2026, source: "b" }),
      document("c", "query query", { year: 2026, source: "a" }),
    ]),
  );
  const filters = [
    { field: "source", op: "eq", value: "b" },
    { field: "year", op: "gte", value: 2026 },
  ];
  expect((await search("and", textQuery("query", 1, filters))).rows.map((row) => row.id)).toEqual([
    "b",
  ]);
});

test("R2-native filters accept full in-lists without a SQL parameter ceiling", async () => {
  const values = Array.from({ length: 32 }, (_, ordinal) => ordinal);
  const result = await search(
    "types",
    textQuery("typed", 10, [{ field: "value", op: "in", value: values }]),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["number"]);
});

test("reset replaces a namespace without affecting another", async () => {
  await request(worker, "reset", "write", write([document("a", "before")]));
  await request(worker, "retain", "write", write([document("b", "before")]));
  const replacement = { ...write([document("c", "after")]), reset: true };
  expect((await request(worker, "reset", "write", replacement)).status).toBe(200);
  expect((await search("reset", textQuery("before"))).rows).toEqual([]);
  expect((await search("reset", textQuery("after"))).rows.map((row) => row.id)).toEqual(["c"]);
  expect((await search("retain", textQuery("before"))).rows.map((row) => row.id)).toEqual(["b"]);
  expect((await request(worker, "reset", "rebuild", {})).status).toBe(200);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "reset", "metadata")).json())
      .documents,
  ).toBe(1);
});
