import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Metadata, QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("learned segment bounds prune dense repeats without caching result rows", async () => {
  const namespace = "learned-bounds";
  for (const segment of Array.from({ length: 12 }, (_, index) => index))
    await request(
      worker,
      namespace,
      "write",
      write(
        Array.from({ length: 24 }, (_, row) =>
          document(
            `${String(segment).padStart(2, "0")}-${String(row).padStart(2, "0")}`,
            `${"alpha beta gamma delta ".repeat(2 + (row % 8))}unique${segment}row${row}`,
            { group: row % 2 },
          ),
        ),
      ),
    );
  const input = textQuery("alpha beta gamma delta", 3);
  const cold = await request(worker, namespace, "query", input);
  const expected = Schema.decodeUnknownSync(QueryResult)(await cold.json());
  expect(cold.headers.get("server-timing")).toContain('desc="segments=12"');
  const warm = await request(worker, namespace, "query", input);
  expect(Schema.decodeUnknownSync(QueryResult)(await warm.json())).toEqual(expected);
  expect(warm.headers.get("server-timing")).toContain('desc="segments=1"');
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(metadata.cache.scoreBoundCacheEntries).toBeGreaterThanOrEqual(12);
  expect(metadata.cache.scoreBoundCacheChargedBytes).toBeLessThanOrEqual(1024 * 1024);
  for (const topK of [1, 10, 100]) {
    const query = textQuery(input.text, topK);
    const retained = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, namespace, "query", query)).json(),
    );
    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
    const cleared = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, namespace, "query", query)).json(),
    );
    expect(retained).toEqual(cleared);
    expect(retained.rows).toHaveLength(topK);
  }
});

test("learned bounds respect filters, modes, tombstones and changed live statistics", async () => {
  const namespace = "learned-bound-inputs";
  for (const index of Array.from({ length: 8 }, (_, row) => row))
    await request(
      worker,
      namespace,
      "write",
      write([
        document(`a${index}`, "alpha beta alpha beta", { group: 0 }),
        document(`b${index}`, "alpha gamma beta", { group: 1 }),
        document(`c${index}`, "alpha gamma", { group: 1 }),
      ]),
    );
  for (const match of ["any", "all", "phrase"])
    for (const filters of [[], [{ field: "group", op: "eq", value: 1 }]]) {
      const query = { ...textQuery("alpha beta", 3, filters), match };
      await request(worker, namespace, "query", query);
      await request(worker, namespace, "query", query);
      await request(
        worker,
        namespace,
        "write",
        write([document(`new-${match}-${filters.length}`, "beta ".repeat(30))], ["a0", "b0"]),
      );
      const retained = Schema.decodeUnknownSync(QueryResult)(
        await (await request(worker, namespace, "query", query)).json(),
      );
      expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
      const cleared = Schema.decodeUnknownSync(QueryResult)(
        await (await request(worker, namespace, "query", query)).json(),
      );
      expect(retained).toEqual(cleared);
      expect(retained.rows.some((row) => row.id === "a0" || row.id === "b0")).toBe(false);
    }
});

test("learned cutoffs match an unfragmented oracle across posting blocks and top-k changes", async () => {
  const documents = Array.from({ length: 1280 }, (_, index) => {
    const terms = { text: "alpha beta gamma ".repeat(1 + (index % 19)) };
    if (index % 7 === 0) terms.text = "alpha gamma beta ".repeat(4);
    return {
      ...document(String(index).padStart(4, "0"), terms.text, { group: index % 3 }),
      title: "alpha ".repeat(index % 4),
    };
  });
  for (const offset of Array.from({ length: 8 }, (_, index) => index * 160))
    await request(worker, "bound-blocks", "write", write(documents.slice(offset, offset + 160)));
  for (const offset of [0, 500, 1000])
    await request(worker, "bound-oracle", "write", write(documents.slice(offset, offset + 500)));
  for (const match of ["any", "all", "phrase"])
    for (const filters of [[], [{ field: "group", op: "eq", value: 2 }]])
      for (const topK of [1, 10, 100]) {
        const query = { ...textQuery("alpha beta gamma", topK, filters), match };
        const expected = Schema.decodeUnknownSync(QueryResult)(
          await (await request(worker, "bound-oracle", "query", query)).json(),
        );
        for (const consistency of ["strong", "edge-eventual"] as const) {
          const response = await request(worker, "bound-blocks", "query", {
            ...query,
            consistency,
            minimumSequence: 8,
          });
          expect(response.status).toBe(200);
          const actual = Schema.decodeUnknownSync(QueryResult)(await response.json());
          expect(actual.rows).toEqual(
            expected.rows.map((row) =>
              Object.assign({}, row, { revision: Math.floor(Number(row.id) / 160) + 1 }),
            ),
          );
          expect(actual.sequence).toBe(8);
          expect(actual.consistency).toBe(consistency);
        }
      }
  for (const variation of Array.from({ length: 256 }, (_, index) => index)) {
    const response = await request(
      worker,
      "bound-blocks",
      "query",
      textQuery(`alpha beta gamma${" ".repeat(variation)}`),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "bound-blocks", "metadata")).json(),
  );
  expect(metadata.cache.scoreBoundCacheChargedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(metadata.cache.scoreBoundCacheEntries).toBeLessThan(256 * 8);
  expect((await request(worker, "bound-blocks", "rebuild", {})).status).toBe(200);
  const rebuilt = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "bound-blocks", "metadata")).json(),
  );
  expect(rebuilt.cache.scoreBoundCacheChargedBytes).toBeLessThan(
    metadata.cache.scoreBoundCacheChargedBytes,
  );
});
