import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Root, QueryResult, Metadata, Health } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("native Cache API retains immutable ranges after the memory cache is discarded", async () => {
  await request(worker, "cached", "write", write([document("a", "original cached content")]));
  const initial = await request(worker, "cached", "query", textQuery("original"));
  expect(initial.status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const root = await bucket.get("namespaces/cached/root.json");
  if (root === null) throw new Error("Missing root");
  const manifest = Schema.decodeSync(Schema.fromJsonString(Root))(await root.text());
  const segment = manifest.segments[0];
  if (segment === undefined) throw new Error("Missing committed segment");
  const caches = await worker.getCaches();
  const cache = await caches.open("raio-segments-v1");
  const key = new URL("https://raio-cache.internal/range");
  key.searchParams.set("key", segment.key);
  key.searchParams.set("offset", "0");
  key.searchParams.set("length", String(segment.headerBytes));
  key.searchParams.set("bucket", "raio-test");
  const cached = await cache.match(key);
  expect(cached).toBeDefined();
  if (cached === undefined) return;
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

test("concurrent cold edge queries share immutable range acquisition", async () => {
  const namespace = "shared-cold-ranges";
  await request(
    worker,
    namespace,
    "write",
    write(
      Array.from({ length: 128 }, (_, index) =>
        document(String(index).padStart(4, "0"), "shared cold storage"),
      ),
    ),
  );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const results = await Promise.all(
    Array.from({ length: 12 }, async () => {
      const response = await request(worker, namespace, "query", {
        ...textQuery("shared storage"),
        consistency: "edge-eventual",
      });
      expect(response.status).toBe(200);
      return Schema.decodeUnknownSync(QueryResult)(await response.json());
    }),
  );
  for (const result of results)
    expect(result.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index).padStart(4, "0")),
    );
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(13);
});

for (const match of ["all", "phrase"] as const)
  test(`${match} reads postings only from segments containing every query term`, async () => {
    const namespace = `conjunctive-${match}`;
    for (const index of Array.from({ length: 29 }, (_, ordinal) => ordinal))
      await request(
        worker,
        namespace,
        "write",
        write([document(`partial-${index}`, "cloudflare storage")]),
      );
    await request(worker, namespace, "write", write([document("complete", "cloudflare rust")]));
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const response = await request(worker, namespace, "query", {
      ...textQuery("cloudflare rust cloudflare"),
      match,
      consistency: "edge-eventual",
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    if (match === "all") expect(result.rows.map((row) => row.id)).toEqual(["complete"]);
    else expect(result.rows).toEqual([]);
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    if (match === "all") expect(after.rangeReads - before.rangeReads).toBe(33);
    else expect(after.rangeReads - before.rangeReads).toBe(32);
    const any = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(worker, namespace, "query", textQuery("cloudflare rust cloudflare", 100))
      ).json(),
    );
    if (match === "all")
      expect(result.rows[0]?.score).toBe(any.rows.find((row) => row.id === "complete")?.score);
  });

for (const match of ["all", "phrase"] as const)
  test(`${match} rejects impossible segment intersections before reading directories`, async () => {
    const namespace = `impossible-${match}`;
    await request(worker, namespace, "write", write([document("left", "cloudflare")]));
    await request(worker, namespace, "write", write([document("right", "rust")]));
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const response = await request(worker, namespace, "query", {
      ...textQuery("cloudflare rust"),
      match,
      consistency: "edge-eventual",
    });
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json()).rows).toEqual([]);
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    expect(after.rangeReads - before.rangeReads).toBe(0);
  });

test("conjunctive pruning uses live frequencies after deleting the only shared-term document", async () => {
  const namespace = "conjunctive-tombstones";
  await request(
    worker,
    namespace,
    "write",
    write([document("deleted", "cloudflare rust"), document("live", "cloudflare storage")]),
  );
  await request(worker, namespace, "write", write([], ["deleted"]));
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const response = await request(worker, namespace, "query", {
    ...textQuery("cloudflare rust"),
    match: "all",
    consistency: "edge-eventual",
  });
  expect(response.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await response.json()).rows).toEqual([]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(0);
  expect(after.directoryCacheHits - before.directoryCacheHits).toBe(1);
});
