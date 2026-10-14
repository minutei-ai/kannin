import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult, Metadata, Health } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());
async function query(name: string) {
  return Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, name, "query", textQuery("rust", 100))).json(),
  );
}

test("R2 compaction preserves global scores, attributes and document revisions", async () => {
  for (const index of Array.from({ length: 8 }, (_, ordinal) => ordinal))
    await request(
      worker,
      "compact",
      "write",
      write([document(String(index), `rust ${"padding ".repeat(index)}`, { number: index })]),
    );
  const before = await query("compact");
  const initial = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "compact", "metadata")).json(),
  );
  expect(initial.segments).toBe(8);
  const result = await request(worker, "compact", "compact", {});
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toMatchObject({ compacted: 8, segments: 1, documents: 8 });
  const after = await query("compact");
  expect(after).toEqual(before);
  const compacted = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "compact", "metadata")).json(),
  );
  expect(compacted.segments).toBe(1);
  expect(compacted.manifestEncodedBytes).toBeLessThan(initial.manifestEncodedBytes);
  const root = await (
    await worker.getR2Bucket("STORAGE", "raio")
  ).get("namespaces/compact/root.json");
  expect(root?.size).toBe(compacted.manifestEncodedBytes);
  expect(compacted.sequence).toBe(initial.sequence);
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: "compact" });
  expect(await query("compact")).toEqual(before);
});

test("compaction drops superseded records and tombstones", async () => {
  await request(
    worker,
    "dead",
    "write",
    write([document("a", "obsolete"), document("b", "obsolete")]),
  );
  await request(worker, "dead", "write", write([document("a", "rust")], ["b"]));
  const before = await query("dead");
  expect((await request(worker, "dead", "compact", {})).status).toBe(200);
  expect(await query("dead")).toEqual(before);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "dead", "metadata")).json())
      .documents,
  ).toBe(1);
  await request(worker, "dead", "write", write([document("a", "changed")]));
  expect((await query("dead")).rows).toEqual([]);
});

test("compaction retains Vectorize identity across document moves", async () => {
  const values = [1, ...Array.from({ length: 767 }, () => 0)];
  await request(worker, "vectors", "write", {
    requestId: "one",
    upserts: [{ id: "a", text: "rust", attributes: {}, vector: values }],
    deletes: [],
  });
  await request(worker, "vectors", "write", write([document("b", "rust")]));
  expect((await request(worker, "vectors", "vector-sync", {})).status).toBe(200);
  const input = { kind: "vector", vector: values, topK: 10, filters: [] };
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "vectors", "query", input)).json(),
  );
  expect((await request(worker, "vectors", "compact", {})).status).toBe(200);
  const after = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "vectors", "query", input)).json(),
  );
  expect(after).toEqual(before);
});

test("equal-score top-k is stable across compaction and Unicode identifiers", async () => {
  for (const id of ["z", "\uffff", "😀", "ä", "a", "Z"])
    await request(worker, "ties", "write", write([document(id, "same tokens")]));
  const input = textQuery("same", 3);
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "ties", "query", input)).json(),
  );
  expect(before.rows.map((row) => row.id)).toEqual(["Z", "a", "z"]);
  await request(worker, "ties", "compact", {});
  const after = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "ties", "query", input)).json(),
  );
  expect(after).toEqual(before);
});

test("global segment pruning matches an independent exhaustive BM25 oracle", async () => {
  const corpus = Array.from({ length: 400 }, (_, index) => ({
    id: String(index).padStart(5, "0"),
    title: "alpha title".repeat(Number(index % 7 === 0)),
    text: `${"alpha ".repeat(index % 9)}${"beta ".repeat(index % 11)}${"padding ".repeat(index % 31)}`,
    attributes: { group: index % 4 },
  }));
  for (const offset of [0, 50, 100, 150, 200, 250, 300, 350])
    await request(worker, "oracle", "write", write(corpus.slice(offset, offset + 50)));
  const tokens = corpus.map((doc) => ({
    doc,
    title: doc.title.split(" ").filter(Boolean),
    body: doc.text.split(" ").filter(Boolean),
  }));
  const n = corpus.length;
  const titleMean = tokens.reduce((sum, item) => sum + item.title.length, 0) / n;
  const bodyMean = tokens.reduce((sum, item) => sum + item.body.length, 0) / n;
  const df = new Map(
    ["alpha", "beta"].map((term) => [
      term,
      tokens.filter((item) => item.title.includes(term) || item.body.includes(term)).length,
    ]),
  );
  for (const filterGroup of [undefined, 2]) {
    const scores = tokens
      .filter((item) => filterGroup === undefined || item.doc.attributes.group === filterGroup)
      .map((item) => ({
        id: item.doc.id,
        score: ["alpha", "beta"].reduce((sum, term) => {
          const a = item.title.filter((word) => word === term).length;
          const b = item.body.filter((word) => word === term).length;
          const tf =
            (2 * a) / (0.25 + (0.75 * item.title.length) / titleMean) +
            b / (0.25 + (0.75 * item.body.length) / bodyMean);
          const count = df.get(term) ?? 0;
          return sum + (Math.log(1 + (n - count + 0.5) / (count + 0.5)) * 2.2 * tf) / (1.2 + tf);
        }, 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 20);
    const filters = [];
    if (filterGroup !== undefined) filters.push({ field: "group", op: "eq", value: filterGroup });
    const found = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "oracle", "query", textQuery("alpha beta", 20, filters))).json(),
    );
    expect(found.rows.map((row) => row.id)).toEqual(scores.map((row) => row.id));
    for (const [index, row] of found.rows.entries()) {
      const expected = scores[index];
      if (expected === undefined) throw new Error("Missing reference row");
      expect(row.score).toBeCloseTo(expected.score, 10);
    }
  }
});

test("global score bounds skip R2 posting reads from noncompetitive segments", async () => {
  for (const index of Array.from({ length: 16 }, (_, ordinal) => ordinal))
    await request(
      worker,
      "io",
      "write",
      write(
        Array.from({ length: 16 }, (_, row) =>
          document(String(index * 16 + row).padStart(5, "0"), "equal terms"),
        ),
      ),
    );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "io", "query", textQuery("equal terms", 1))).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["00000"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBeLessThanOrEqual(19);
});

test("concurrent cold edge reads preserve posting order, scores and directory ownership", async () => {
  const corpus = Array.from({ length: 800 }, (_, index) =>
    document(String(index).padStart(4, "0"), `rust ${"search ".repeat(index % 5)}engine`, {
      group: index % 4,
    }),
  );
  for (const offset of [0, 200, 400, 600])
    expect(
      (await request(worker, "parallel-cold", "write", write(corpus.slice(offset, offset + 200))))
        .status,
    ).toBe(200);
  const input = {
    ...textQuery("rust search", 20, [{ field: "group", op: "eq", value: 2 }]),
    consistency: "edge-eventual",
    minimumSequence: 4,
  };
  const results = await Promise.all(
    Array.from({ length: 12 }, async () => {
      const response = await request(worker, "parallel-cold", "query", input);
      expect(response.status).toBe(200);
      return Schema.decodeUnknownSync(QueryResult)(await response.json());
    }),
  );
  const reference = results[0];
  if (reference === undefined) throw new Error("Missing reference response");
  expect(reference.rows.length).toBe(20);
  expect(reference.sequence).toBe(4);
  for (const result of results) expect(result).toEqual(reference);
  expect(reference.rows.every((row) => row.attributes.group === 2)).toBe(true);
  const strong = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "parallel-cold", "query", textQuery("rust search", 20, input.filters))
    ).json(),
  );
  expect(strong.rows).toEqual(reference.rows);
});

test("common terms load contiguous posting blocks with one range read per term", async () => {
  await request(
    worker,
    "posting-ranges",
    "write",
    write(
      Array.from({ length: 512 }, (_, index) =>
        document(String(index).padStart(4, "0"), "coalesced postings"),
      ),
    ),
  );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const response = await request(
    worker,
    "posting-ranges",
    "query",
    textQuery("coalesced postings", 10),
  );
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index).padStart(4, "0")),
  );
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(13);
});
