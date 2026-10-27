import { expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";
import { useHeaderOnlyCommonFrames } from "./common-posting-fixture";

test("uniform frequencies preserve filtered rankings and deletions without posting acquisition", async () => {
  const worker = await startWorker();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  const namespace = "uniform-hits";
  for (const batch of Array.from({ length: 8 }, (_, index) => index)) {
    const documents = Array.from({ length: 64 }, (_, offset) => {
      const index = batch * 64 + offset;
      return document(String(index).padStart(3, "0"), `alpha beta ${"noise ".repeat(index % 5)}`, {
        group: index % 3,
      });
    });
    expect((await request(worker, namespace, "write", write(documents))).status).toBe(200);
  }
  await useHeaderOnlyCommonFrames(worker, namespace);
  const input = {
    ...textQuery("alpha beta", 10, [{ field: "group", op: "eq", value: 1 }]),
    minimumSequence: 8,
  };
  const response = await request(worker, namespace, "query", input);
  expect(response.status).toBe(200);
  const cold = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(cold.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(10 + index * 15).padStart(3, "0")),
  );
  const timing = response.headers.get("server-timing") ?? "";
  expect(timing).toMatch(/text_posting_acquire;dur=[^,]*;desc="spans=0 bytes=0 ranges=0"/);
  expect(timing).toMatch(/text_uniform_hits;desc="segments=[1-9]\d*"/);
  const warm = await request(worker, namespace, "query", input);
  expect(warm.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await warm.json())).toEqual(cold);
  const phrase = await request(worker, namespace, "query", { ...input, match: "phrase" });
  expect(phrase.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await phrase.json())).toEqual(cold);
  expect(phrase.headers.get("server-timing")).toContain('text_uniform_hits;desc="segments=0"');
  expect(phrase.headers.get("server-timing")).toMatch(
    /text_posting_acquire;dur=[^,]*;desc="spans=[1-9]\d* bytes=\d+ ranges=[1-9]\d*"/,
  );
  expect((await request(worker, namespace, "write", write([], ["010"]))).status).toBe(200);
  const deleted = await request(worker, namespace, "query", { ...input, minimumSequence: 9 });
  expect(deleted.status).toBe(200);
  const current = Schema.decodeUnknownSync(QueryResult)(await deleted.json());
  expect(current.sequence).toBe(9);
  expect(current.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(25 + index * 15).padStart(3, "0")),
  );
  expect(deleted.headers.get("server-timing")).toMatch(
    /text_posting_acquire;dur=[^,]*;desc="spans=0 bytes=0 ranges=0"/,
  );
});

test("nonuniform frequency on an excluded row retains ordinary posting evaluation", async () => {
  const worker = await startWorker();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  const documents = Array.from({ length: 64 }, (_, index) => {
    if (index === 0) return document("000", "alpha alpha beta", { group: 0 });
    return document(String(index).padStart(3, "0"), "alpha beta", { group: index % 3 });
  });
  expect((await request(worker, "uniform-fallback", "write", write(documents))).status).toBe(200);
  await useHeaderOnlyCommonFrames(worker, "uniform-fallback");
  const response = await request(
    worker,
    "uniform-fallback",
    "query",
    textQuery("alpha beta", 10, [{ field: "group", op: "eq", value: 1 }]),
  );
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(1 + index * 3).padStart(3, "0")),
  );
  expect(response.headers.get("server-timing")).toContain('text_uniform_hits;desc="segments=0"');
  expect(response.headers.get("server-timing")).toMatch(
    /text_posting_acquire;dur=[^,]*;desc="spans=[1-9]\d* bytes=\d+ ranges=[1-9]\d*"/,
  );
});
