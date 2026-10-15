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
  const before = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  const warm = await request(worker, namespace, "query", input);
  expect(Schema.decodeUnknownSync(QueryResult)(await warm.json())).toEqual(expected);
  expect(warm.headers.get("server-timing")).toContain('desc="segments=1"');
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(metadata.cache.scoreBoundCacheEntries).toBeGreaterThanOrEqual(12);
  expect(metadata.cache.textPlanCacheHits - before.cache.textPlanCacheHits).toBe(1);
  expect(metadata.cache.termRequests - before.cache.termRequests).toBe(0);
  expect(metadata.cache.textPlanCacheChargedBytes).toBeLessThanOrEqual(1024 * 1024);
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
      textQuery("alpha beta gamma", 10, [
        { field: "group", op: "in", value: [0, 1, 2, variation + 3] },
      ]),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "bound-blocks", "metadata")).json(),
  );
  expect(metadata.cache.scoreBoundCacheChargedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(metadata.cache.scoreBoundCacheEntries).toBeLessThan(256 * 8);
  expect(metadata.cache.textPlanCacheChargedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect((await request(worker, "bound-blocks", "rebuild", {})).status).toBe(200);
  const rebuilt = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "bound-blocks", "metadata")).json(),
  );
  expect(rebuilt.cache.scoreBoundCacheChargedBytes).toBeLessThan(
    metadata.cache.scoreBoundCacheChargedBytes,
  );
  expect(rebuilt.cache.textPlanCacheChargedBytes).toBeLessThan(
    metadata.cache.textPlanCacheChargedBytes,
  );
}, 30000);

test("text plans miss after same-sequence compaction and changes outside selected segments", async () => {
  const namespace = "plan-root-identity";
  for (const index of Array.from({ length: 16 }, (_, row) => row))
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document(String(index).padStart(2, "0"), "alpha beta alpha beta")]),
        )
      ).status,
    ).toBe(200);
  const query = textQuery("alpha beta", 100);
  const initial = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", query)).json(),
  );
  const before = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect((await request(worker, namespace, "compact", {})).status).toBe(200);
  const compacted = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", query)).json(),
  );
  const after = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(compacted).toEqual(initial);
  expect(after.sequence).toBe(before.sequence);
  expect(after.segments).toBeGreaterThan(4);
  expect(after.cache.textPlanCacheHits).toBe(before.cache.textPlanCacheHits);
  expect(after.cache.textPlanCacheEntries).toBe(before.cache.textPlanCacheEntries + 1);
  expect(
    (await request(worker, namespace, "write", write([document("other", "unrelated words")])))
      .status,
  ).toBe(200);
  const changed = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", query)).json(),
  );
  const changedMetadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(changed.rows.map((row) => row.id)).toEqual(initial.rows.map((row) => row.id));
  expect(changed.rows[0]?.score).not.toBe(initial.rows[0]?.score);
  expect(changedMetadata.cache.textPlanCacheHits).toBe(after.cache.textPlanCacheHits);
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const fresh = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", query)).json(),
  );
  expect(fresh).toEqual(changed);
  const seeded = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  const larger = await request(worker, namespace, "query", textQuery("alpha beta", 10));
  expect(larger.status).toBe(200);
  const reused = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(reused.cache.textPlanCacheHits - seeded.cache.textPlanCacheHits).toBe(1);
  expect(reused.cache.termRequests).toBe(seeded.cache.termRequests);
  const blocked = await request(worker, namespace, "query", {
    ...query,
    minimumSequence: fresh.sequence + 1,
  });
  expect(blocked.status).toBe(409);
});

test("text plan eviction stays within its byte quota and recomputes exact rows", async () => {
  const namespace = "text-plan-eviction";
  const text = Array.from({ length: 64 }, (_, index) => `term${index}`).join(" ");
  for (const index of Array.from({ length: 16 }, (_, row) => row))
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document(String(index).padStart(2, "0"), text, { cohort: 0 })]),
        )
      ).status,
    ).toBe(200);
  const expected = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery(text))).json(),
  );
  for (const variation of Array.from({ length: 256 }, (_, index) => index + 1)) {
    const response = await request(
      worker,
      namespace,
      "query",
      textQuery(text, 10, [{ field: "cohort", op: "in", value: [0, variation] }]),
    );
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result).toEqual(expected);
  }
  const filled = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(filled.cache.textPlanCacheChargedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(filled.cache.textPlanCacheEntries).toBeLessThan(256);
  const recomputed = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery(text))).json(),
  );
  expect(recomputed).toEqual(expected);
  const final = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(final.cache.textPlanCacheHits).toBe(filled.cache.textPlanCacheHits);
}, 15000);

test("semantic text equivalents reuse plans while phrase order and repetitions stay distinct", async () => {
  const namespace = "semantic-plan-identity";
  for (const index of Array.from({ length: 8 }, (_, row) => row))
    await request(
      worker,
      namespace,
      "write",
      write([
        document(`${index}-a`, "alpha beta alpha"),
        document(`${index}-b`, "beta alpha alpha"),
        document(`${index}-c`, "alpha beta"),
        document(`${index}-d`, "alpha alpha beta"),
      ]),
    );
  for (const match of ["any", "all", "phrase"] as const) {
    const response = await request(worker, namespace, "query", {
      ...textQuery("alpha beta alpha", 3),
      match,
    });
    const expected = Schema.decodeUnknownSync(QueryResult)(await response.json());
    const before = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    const variants = ["  ÁLPHA\tBÉTA   alpha  ", "alpha, beta; alpha"];
    if (match !== "phrase") variants.push("BETA alpha", "alpha alpha beta beta");
    for (const text of variants) {
      const equivalent = await request(worker, namespace, "query", {
        ...textQuery(text, 3),
        match,
      });
      expect(equivalent.status).toBe(200);
      expect(equivalent.headers.get("server-timing")).toContain('text_plan;desc="memory"');
      expect(Schema.decodeUnknownSync(QueryResult)(await equivalent.json())).toEqual(expected);
    }
    const after = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    expect(after.cache.textPlanCacheHits - before.cache.textPlanCacheHits).toBe(variants.length);
    expect(after.cache.termRequests).toBe(before.cache.termRequests);
    expect(after.cache.textPlanCacheEntries).toBe(before.cache.textPlanCacheEntries);
  }
  for (const text of ["beta alpha alpha", "alpha beta"]) {
    const response = await request(worker, namespace, "query", {
      ...textQuery(text, 3),
      match: "phrase",
    });
    expect(response.headers.get("server-timing")).toContain('text_plan;desc="miss"');
    const expected = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
    const fresh = await request(worker, namespace, "query", {
      ...textQuery(text, 3),
      match: "phrase",
    });
    expect(Schema.decodeUnknownSync(QueryResult)(await fresh.json())).toEqual(expected);
  }
});
