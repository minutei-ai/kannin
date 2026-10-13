import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Metadata, QueryResult, Root } from "../src/protocol";
import { request, startWorker } from "./harness";

const worker = await startWorker(undefined, true);
afterAll(() => worker.dispose());

test("native Cloudflare Queue dispatch drains the R2 vector outbox", async () => {
  const values = [1, ...Array.from({ length: 767 }, () => 0)];
  const created = await request(worker, "queue", "write", {
    requestId: "queue-create",
    upserts: [{ id: "a", text: "queued", attributes: {}, vector: values }],
    deletes: [],
  });
  expect(created.status).toBe(200);
  const state = { drained: false };
  for (const _attempt of Array.from({ length: 100 }, (_, ordinal) => ordinal)) {
    const metadata = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, "queue", "metadata")).json(),
    );
    if (metadata.vectorOutbox === 0) {
      state.drained = true;
      break;
    }
    await Bun.sleep(20);
  }
  expect(state.drained).toBe(true);
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "queue", "query", {
        kind: "vector",
        vector: values,
        topK: 10,
        filters: [],
      })
    ).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
});

test("native index queue compacts immutable R2 segments without changing live rows", async () => {
  for (const ordinal of Array.from({ length: 64 }, (_, value) => value)) {
    const response = await request(worker, "indexqueue", "write", {
      requestId: `batch-${ordinal}`,
      upserts: [{ id: `doc-${ordinal}`, text: "automatic compaction", attributes: {} }],
      deletes: [],
    });
    expect(response.status).toBe(200);
  }
  const bucket = await worker.getR2Bucket("STORAGE");
  const progress = { complete: false };
  for (const _attempt of Array.from({ length: 100 }, (_, value) => value)) {
    const object = await bucket.get("namespaces/indexqueue/root.json");
    expect(object).not.toBeNull();
    if (object === null) return;
    const manifest = Schema.decodeSync(Schema.fromJsonString(Root))(await object.text());
    if (manifest.segments.length <= 32) {
      expect(manifest.documents).toBe(64);
      progress.complete = true;
      break;
    }
    await Bun.sleep(20);
  }
  expect(progress.complete).toBe(true);
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "indexqueue", "query", {
        kind: "text",
        text: "automatic",
        topK: 100,
        filters: [],
      })
    ).json(),
  );
  expect(result.rows).toHaveLength(64);
}, 20000);
