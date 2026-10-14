import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Response } from "miniflare";
import { createHash } from "node:crypto";
import { Root, QueryResult, Metadata, Health, TermProjectionProps } from "../src/protocol";
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

test("the authenticated gateway never exposes immutable cache entrypoints", async () => {
  for (const path of ["/range", "/catalog-v4"]) {
    const url = new URL(path, await worker.ready);
    const anonymous = await fetch(url);
    expect(anonymous.status).toBe(401);
    await anonymous.arrayBuffer();
    const authenticated = await fetch(url, {
      headers: { authorization: "Bearer local-test-token" },
    });
    expect(authenticated.status).toBe(404);
    await authenticated.arrayBuffer();
  }
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

test("term projection batches preserve global frequencies and filter eligibility at their boundary", async () => {
  const namespace = "batch-term-projections";
  for (const index of Array.from({ length: 129 }, (_, ordinal) => ordinal))
    await request(
      worker,
      namespace,
      "write",
      write([
        document(String(index).padStart(3, "0"), "shared cold storage", { group: index % 2 }),
      ]),
    );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const first = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("shared storage"))).json(),
  );
  expect(first.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index).padStart(3, "0")),
  );
  const acquired = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(acquired.termRequests - before.termRequests).toBe(9);
  expect(acquired.termReads - before.termReads).toBe(129);
  const filtered = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("shared storage", 10, [{ field: "group", op: "eq", value: 1 }]),
      )
    ).json(),
  );
  expect(filtered.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index * 2 + 1).padStart(3, "0")),
  );
  expect(filtered.rows.map((row) => row.score)).toEqual(first.rows.map((row) => row.score));
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.termRequests - acquired.termRequests).toBe(9);
  expect(after.termReads - acquired.termReads).toBe(129);
});

test("incremental writes retain partial immutable term catalogs and recompute live scores", async () => {
  const namespace = "partial-catalogs";
  for (const index of Array.from({ length: 15 }, (_, ordinal) => ordinal))
    await request(
      worker,
      namespace,
      "write",
      write([document(String(index).padStart(3, "0"), "shared")]),
    );
  const first = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("shared"))).json(),
  );
  await request(worker, namespace, "write", write([document("015", "shared")]));
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const second = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("shared"))).json(),
  );
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.termReads - before.termReads).toBe(1);
  expect(after.termMemoryHits - before.termMemoryHits).toBe(15);
  expect(second.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
  for (const row of second.rows) expect(row.score).toBeCloseTo(Math.log1p(0.5 / 16.5), 12);
  await request(worker, namespace, "write", write([document("001", "other")], ["000"]));
  const changed = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("shared"))).json(),
  );
  expect(changed.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index + 2).padStart(3, "0")),
  );
  for (const row of changed.rows) expect(row.score).toBeCloseTo(Math.log1p(1.5 / 14.5), 12);
});

test("compressed overviews serve new selectors and filters after process eviction", async () => {
  const namespace = "overview-selectors";
  for (const index of Array.from({ length: 17 }, (_, ordinal) => ordinal))
    await request(
      worker,
      namespace,
      "write",
      write([document(String(index).padStart(2, "0"), "alpha beta gamma")]),
    );
  const first = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("alpha beta"))).json(),
  );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const second = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", {
        ...textQuery("beta gamma"),
        filters: [{ field: "missing", op: "exists", value: false }],
      })
    ).json(),
  );
  expect(second.rows).toEqual(first.rows);
  const memory = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(memory.overviewMemoryHits - before.overviewMemoryHits).toBe(17);
  expect(memory.overviewBuilds - before.overviewBuilds).toBe(0);
  expect(memory.overviewCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  await request(worker, namespace, "rebuild", {});
  const third = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", {
        ...textQuery("gamma alpha"),
        filters: [{ field: "missing", op: "ne", value: "anything" }],
      })
    ).json(),
  );
  expect(third.rows).toEqual(first.rows);
  const shared = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(shared.overviewCacheApiHits - memory.overviewCacheApiHits).toBe(17);
  expect(shared.overviewBuilds - memory.overviewBuilds).toBe(0);
  expect(shared.overviewCacheApiLookups - memory.overviewCacheApiLookups).toBe(2);
});

test("corrupted compressed overview cache falls back to verified immutable source data", async () => {
  const namespace = "overview-corruption";
  await request(worker, namespace, "write", write([document("a", "alpha beta")]));
  expect((await request(worker, namespace, "query", textQuery("alpha"))).status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing manifest");
  const manifest = Schema.decodeSync(Schema.fromJsonString(Root))(await object.text());
  const segment = manifest.segments[0];
  if (segment === undefined) throw new Error("Missing segment");
  const cache = await (await worker.getCaches()).open("raio-overview-batches-v2");
  const key = new URL("https://overviews.internal/batch-v2");
  key.searchParams.set("bucket", "raio-test");
  const ranges = Schema.encodeSync(Schema.fromJsonString(TermProjectionProps.fields.ranges))([
    { key: segment.key, headerBytes: segment.headerBytes },
  ]);
  key.searchParams.set("ranges", createHash("sha256").update(ranges).digest("hex"));
  await cache.put(
    key,
    new Response('["AA=="]', {
      headers: { "cache-control": "public, max-age=60" },
    }),
  );
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const recovered = await request(worker, namespace, "query", textQuery("beta"));
  expect(recovered.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await recovered.json()).rows.map((row) => row.id),
  ).toEqual(["a"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.overviewBuilds - before.overviewBuilds).toBe(1);
  expect(after.overviewCacheApiHits - before.overviewCacheApiHits).toBe(0);
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

test("immutable query catalogs survive directory eviction without reloading irrelevant headers", async () => {
  const namespace = "projected-catalog";
  for (const index of Array.from({ length: 29 }, (_, ordinal) => ordinal))
    await request(
      worker,
      namespace,
      "write",
      write([document(`partial-${index}`, "cloudflare storage")]),
    );
  await request(worker, namespace, "write", write([document("complete", "cloudflare rust")]));
  const input = { ...textQuery("cloudflare rust"), match: "all", consistency: "edge-eventual" };
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(original.rows.map((row) => row.id)).toEqual(["complete"]);
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const restored = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(restored.rows).toEqual(original.rows);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(4);
});

test("cached term bounds prune uncompetitive segments after directory eviction", async () => {
  const namespace = "projected-bounds";
  for (const index of Array.from({ length: 16 }, (_, ordinal) => ordinal))
    await request(
      worker,
      namespace,
      "write",
      write(
        Array.from({ length: 16 }, (_, row) =>
          document(String(index * 16 + row).padStart(5, "0"), "equal terms"),
        ),
      ),
    );
  const input = { ...textQuery("equal terms", 1), consistency: "edge-eventual" };
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(original.rows.map((row) => row.id)).toEqual(["00000"]);
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const restored = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(restored.rows).toEqual(original.rows);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(4);
});

test("term projections keep phrase order, filter eligibility and revisions query scoped", async () => {
  const namespace = "projection-isolation";
  await request(
    worker,
    namespace,
    "write",
    write([
      document("left", "rust cloudflare", { group: 1 }),
      document("right", "cloudflare rust", { group: 2 }),
    ]),
  );
  const left = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", {
        ...textQuery("rust cloudflare"),
        match: "phrase",
        consistency: "edge-eventual",
      })
    ).json(),
  );
  expect(left.rows.map((row) => row.id)).toEqual(["left"]);
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const right = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", {
        ...textQuery("cloudflare rust", 10, [{ field: "group", op: "eq", value: 2 }]),
        match: "phrase",
        consistency: "edge-eventual",
      })
    ).json(),
  );
  expect(right.rows.map((row) => row.id)).toEqual(["right"]);
  const filtered = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", {
        ...textQuery("cloudflare rust", 10, [{ field: "group", op: "eq", value: 1 }]),
        match: "all",
        consistency: "edge-eventual",
      })
    ).json(),
  );
  expect(filtered.rows.map((row) => row.id)).toEqual(["left"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.termReads - before.termReads).toBe(2);
  expect(after.termMemoryHits - before.termMemoryHits).toBe(0);
  expect(after.termCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  await request(worker, namespace, "write", write([document("left", "storage", { group: 3 })]));
  const changed = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", {
        ...textQuery("cloudflare rust"),
        match: "all",
        consistency: "edge-eventual",
        minimumSequence: 2,
      })
    ).json(),
  );
  expect(changed.rows.map((row) => row.id)).toEqual(["right"]);
  expect(changed.sequence).toBe(2);
});

test("segment priority finds the equal-score winner before reading lower-priority postings", async () => {
  const namespace = "catalog-priority";
  for (const index of Array.from({ length: 16 }, (_, ordinal) => 15 - ordinal))
    await request(
      worker,
      namespace,
      "write",
      write([document(String(index).padStart(5, "0"), "equal terms")]),
    );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", {
        ...textQuery("equal terms", 1),
        consistency: "edge-eventual",
      })
    ).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["00000"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(19);
});

test("filtered score projections prune headers after directory eviction", async () => {
  const namespace = "filtered-projection";
  for (const index of Array.from({ length: 16 }, (_, ordinal) => ordinal))
    await request(
      worker,
      namespace,
      "write",
      write([document(String(index).padStart(5, "0"), "equal terms", { group: 1 })]),
    );
  const input = {
    ...textQuery("equal terms", 1, [{ field: "group", op: "eq", value: 1 }]),
    consistency: "edge-eventual",
  };
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(original.rows.map((row) => row.id)).toEqual(["00000"]);
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const restored = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(restored.rows).toEqual(original.rows);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(4);
});

test("ineligible segments still contribute namespace-wide frequencies", async () => {
  const namespace = "projection-global-df";
  await request(worker, namespace, "write", write([document("eligible", "target", { group: 1 })]));
  await request(
    worker,
    namespace,
    "write",
    write([document("excluded", "target target", { group: 2 })]),
  );
  const all = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("target"))).json(),
  );
  const filtered = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("target", 10, [{ field: "group", op: "eq", value: 1 }]),
      )
    ).json(),
  );
  expect(filtered.rows.map((row) => row.id)).toEqual(["eligible"]);
  expect(filtered.rows[0]?.score).toBe(all.rows.find((row) => row.id === "eligible")?.score);
});

test("physical filter minima remain conservative after deleting the shortest eligible document", async () => {
  const namespace = "projection-live-minima";
  await request(
    worker,
    namespace,
    "write",
    write([
      document("short", "target", { group: 1 }),
      document("long", "target target padding padding padding", { group: 1 }),
      document("excluded", "target", { group: 2 }),
    ]),
  );
  await request(
    worker,
    namespace,
    "write",
    write([document("other", "target target padding", { group: 1 })]),
  );
  const input = textQuery("target", 1, [{ field: "group", op: "eq", value: 1 }]);
  await request(worker, namespace, "query", input);
  await request(worker, namespace, "write", write([], ["short"]));
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(before.rows).toHaveLength(1);
  expect(before.rows[0]?.id).not.toBe("short");
  await request(worker, namespace, "compact", {});
  const after = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(after.rows).toEqual(before.rows);
});

test("cached negative filter eligibility avoids all directory and posting reads", async () => {
  const namespace = "projection-empty-filter";
  await request(worker, namespace, "write", write([document("a", "target", { group: 1 })]));
  const input = {
    ...textQuery("target", 10, [{ field: "group", op: "eq", value: 2 }]),
    consistency: "edge-eventual",
  };
  expect(
    Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, namespace, "query", input)).json(),
    ).rows,
  ).toEqual([]);
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(
    Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, namespace, "query", input)).json(),
    ).rows,
  ).toEqual([]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(0);
  await request(worker, namespace, "write", write([document("a", "target", { group: 2 })]));
  const changed = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...input, minimumSequence: 2 })).json(),
  );
  expect(changed.rows.map((row) => row.id)).toEqual(["a"]);
});
