import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Root, QueryResult, Metadata } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("native Cache API retains immutable ranges after the memory cache is discarded", async () => {
  await request(worker, "cached", "write", write([document("a", "original cached content")]));
  const initial = await request(worker, "cached", "query", textQuery("original"));
  expect(initial.status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const root = await bucket.get("namespaces/cached/root.json");
  if (!root) throw new Error("Missing root");
  const manifest = Schema.decodeSync(Schema.fromJsonString(Root))(await root.text());
  const segment = manifest.segments[0];
  const caches = await worker.getCaches();
  const cache = await caches.open("raio-segments-v1");
  const key = new URL("https://raio-cache.internal/range");
  key.searchParams.set("key", segment.key);
  key.searchParams.set("offset", "0");
  key.searchParams.set("length", String(segment.headerBytes));
  key.searchParams.set("bucket", "raio-test");
  const cached = await cache.match(key);
  expect(cached).toBeDefined();
  if (!cached) return;
  expect((await cached.arrayBuffer()).byteLength).toBe(segment.headerBytes);
  await request(worker, "cached", "rebuild", {});
  expect((await request(worker, "cached", "query", textQuery("original"))).status).toBe(200);
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "cached", "metadata")).json(),
  );
  expect(metadata.cache.cacheApiHits).toBeGreaterThan(0);
});

test("cached old segments cannot resurrect updated or deleted documents", async () => {
  await request(worker, "mutated", "write", write([document("a", "old content")]));
  await request(worker, "mutated", "query", textQuery("old"));
  await request(worker, "mutated", "write", write([document("a", "new content")]));
  await request(worker, "mutated", "rebuild", {});
  const stale = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "mutated", "query", textQuery("old"))).json(),
  );
  expect(stale.rows).toEqual([]);
  const current = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "mutated", "query", textQuery("new"))).json(),
  );
  expect(current.rows.map((row) => row.id)).toEqual(["a"]);
  await request(worker, "mutated", "write", write([], ["a"]));
  await request(worker, "mutated", "rebuild", {});
  const deleted = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "mutated", "query", textQuery("new"))).json(),
  );
  expect(deleted.rows).toEqual([]);
});

test("the authenticated gateway never exposes the immutable segment entrypoint", async () => {
  const response = await fetch(
    new URL("/range?key=namespaces/cached/root.json", await worker.ready),
  );
  expect(response.status).toBe(401);
  await response.arrayBuffer();
});
