import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult, Metadata } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("posting timing counts remain request-local across concurrent edge queries", async () => {
  const namespace = "posting-timing";
  await request(
    worker,
    namespace,
    "write",
    write(Array.from({ length: 8 }, (_, index) => document(String(index), "alpha beta"))),
  );
  const responses = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const text = "alpha";
      const terms = { value: 1, text };
      if (index % 2 === 1) {
        terms.value = 2;
        terms.text = "alpha beta";
      }
      const response = await request(worker, namespace, "query", {
        ...textQuery(terms.text),
        consistency: "edge-eventual",
        minimumSequence: 1,
      });
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.rows.map((row) => row.id)).toEqual(
        Array.from({ length: 8 }, (_value, row) => String(row)),
      );
      const timing = response.headers.get("server-timing");
      expect(timing).toContain(`desc="spans=${terms.value} bytes=`);
      expect(timing).toContain(`desc="blocks=${terms.value}"`);
      expect(timing).toContain('desc="segments=1"');
      expect(timing).toContain("text_rank_prepare;dur=");
      expect(timing).toContain("text_posting_acquire;dur=");
      expect(timing).toContain("text_posting_decode;dur=");
      expect(timing).toContain("text_score;dur=");
      return response.status;
    }),
  );
  expect(responses).toHaveLength(12);
});

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
  expect((await search("title", textQuery("cloudflare"))).rows[0]?.id).toBe("title");
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
  const first = await search("repeated", textQuery("rust"));
  const repeated = await search("repeated", textQuery("rust rust rust"));
  expect(first.rows).toHaveLength(1);
  expect(repeated.rows).toHaveLength(1);
  expect(first.rows.map((row) => row.score)).toEqual(repeated.rows.map((row) => row.score));
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
  expect((await search("unicode", textQuery("SAO ACAO CAFE"))).rows[0]?.id).toBe("pt");
  expect((await search("unicode", textQuery("日本語"))).rows[0]?.id).toBe("cjk");
  expect((await search("unicode", textQuery("uber flores"))).rows[0]?.id).toBe("de");
});

test("rare terms outrank common terms with namespace-wide statistics", async () => {
  const documents = Array.from({ length: 50 }, (_, index) =>
    document(`common-${index}`, "common padding"),
  );
  await request(worker, "idf", "write", write([...documents, document("rare", "rare padding")]));
  expect((await search("idf", textQuery("common rare"))).rows[0]?.id).toBe("rare");
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

test("prototype-like terms remain ordinary terms across updates and deletions", async () => {
  const initial = await request(
    worker,
    "prototype-terms",
    "write",
    write([document("a", "constructor constructor rust"), document("b", "constructor worker")]),
  );
  expect(initial.status).toBe(200);
  const first = await search("prototype-terms", textQuery("constructor"));
  expect(first.rows.map((row) => row.id)).toEqual(["a", "b"]);
  const updated = await request(
    worker,
    "prototype-terms",
    "write",
    write([document("a", "replacement rust")]),
  );
  expect(updated.status).toBe(200);
  expect(
    (await search("prototype-terms", textQuery("constructor"))).rows.map((row) => row.id),
  ).toEqual(["b"]);
  const deleted = await request(worker, "prototype-terms", "write", write([], ["b"]));
  expect(deleted.status).toBe(200);
  expect((await search("prototype-terms", textQuery("constructor"))).rows).toEqual([]);
});

test("filtered ranking survives mask eviction, attribute changes and tombstones", async () => {
  const documents = Array.from({ length: 200 }, (_, index) => ({
    ...document(String(index).padStart(3, "0"), "target"),
    attributes: { group: index % 25 },
  }));
  await request(worker, "filter-masks", "write", write(documents));
  for (const group of Array.from({ length: 25 }, (_, index) => index)) {
    const result = await search(
      "filter-masks",
      textQuery("target", 4, [{ field: "group", op: "eq", value: group }]),
    );
    expect(result.rows.map((row) => row.id)).toEqual(
      documents
        .filter((row) => row.attributes.group === group)
        .map((row) => row.id)
        .slice(0, 4),
    );
  }
  await request(
    worker,
    "filter-masks",
    "write",
    write([{ ...document("000", "target"), attributes: { group: 999 } }]),
  );
  const old = await search(
    "filter-masks",
    textQuery("target", 4, [{ field: "group", op: "eq", value: 0 }]),
  );
  expect(old.rows.map((row) => row.id)).toEqual(["025", "050", "075", "100"]);
  const updated = await search(
    "filter-masks",
    textQuery("target", 4, [{ field: "group", op: "eq", value: 999 }]),
  );
  expect(updated.rows.map((row) => row.id)).toEqual(["000"]);
  await request(worker, "filter-masks", "write", write([], ["000"]));
  const deleted = await search(
    "filter-masks",
    textQuery("target", 4, [{ field: "group", op: "eq", value: 999 }]),
  );
  expect(deleted.rows).toEqual([]);
});
