import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult } from "../src/protocol";
import { request, startWorker } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("native term blooms preserve long tokens through writes, queries and compaction", async () => {
  const namespace = "long-native-term";
  const term = "x".repeat(200);
  for (const id of ["a", "b"]) {
    const written = await request(worker, namespace, "write", {
      requestId: id,
      upserts: [{ id, text: term, attributes: {} }],
      deletes: [],
    });
    expect(written.status).toBe(200);
  }
  for (const compact of [false, true]) {
    if (compact) expect((await request(worker, namespace, "compact", {})).status).toBe(200);
    for (const text of [term, "y".repeat(200)]) {
      const response = await request(worker, namespace, "query", {
        kind: "text",
        text,
        topK: 10,
        filters: [],
        minimumSequence: 2,
      });
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.sequence).toBe(2);
      if (text === term) expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
      else expect(result.rows).toEqual([]);
    }
  }
});
