import { useHeaderOnlyCommonFrames } from "./common-posting-fixture";
import { Directory, initSync } from "../dist/wasm/raio_engine";
import { decodeRoot, encodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Array as EffectArray, Effect, Schema } from "effect";
import { Response } from "miniflare";
import { createHash } from "node:crypto";
import {
  QueryResult,
  Metadata,
  Health,
  TermProjectionProps,
  LocatedDocument,
} from "../src/protocol";
import {
  clearLeaderIndex,
  document,
  request,
  startWorker,
  textQuery,
  write,
  evictWrittenOverviews,
} from "./harness";
import { corpus } from "../tooling/corpus";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("reverse-ranked adjacent pages share reads without changing rank order", async () => {
  const namespace = "reverse-result-pages";
  await request(
    worker,
    namespace,
    "write",
    write(
      Array.from({ length: 80 }, (_, index) =>
        document(String(index).padStart(4, "0"), "equal ".repeat(index + 1)),
      ),
    ),
  );
  const before = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  const initial = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("equal", 10))).json(),
  );
  expect(initial.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(79 - index).padStart(4, "0")),
  );
  const after = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(after.cache.rangeReads - before.cache.rangeReads).toBeLessThanOrEqual(5);
  const smaller = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("equal", 1))).json(),
  );
  expect(smaller.rows).toEqual(initial.rows.slice(0, 1));
});

test("interleaved segment hits group bounded reads and restore global rank order", async () => {
  initSync({
    module: new WebAssembly.Module(
      await Bun.file(`${import.meta.dir}/../dist/wasm/raio_engine_bg.wasm`).arrayBuffer(),
    ),
  });
  const namespace = "interleaved-segment-document-groups";
  const body = Array.from({ length: 256 }, (_, index) =>
    createHash("sha256").update(`document-group-frame-${index}`).digest("hex"),
  ).join(" ");
  for (const parity of [0, 1]) {
    const response = await request(
      worker,
      namespace,
      "write",
      write(
        Array.from({ length: 5 }, (_, offset) => {
          const index = offset * 2 + parity;
          return document(String(index).padStart(3, "0"), `shared ${body}`);
        }),
      ),
    );
    expect(response.status).toBe(200);
  }
  const bucket = await worker.getR2Bucket("STORAGE");
  const root = await bucket.get(`namespaces/${namespace}/root.json`);
  if (root === null) throw new Error("Missing committed root");
  const manifest = decodeRoot(await root.text());
  expect(manifest.segments).toHaveLength(2);
  for (const segment of manifest.segments) {
    const object = await bucket.get(segment.key, {
      range: { offset: 0, length: segment.headerBytes },
    });
    if (object === null) throw new Error("Missing committed segment");
    const bytes = new Uint8Array(await object.arrayBuffer());
    using directory = Directory.canonical(bytes, segment.headerBytes);
    const documents = Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
      directory.rows(
        Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(
          Array.from({ length: segment.count }, (_, row) => row),
        ),
      ),
    );
    expect(documents).toHaveLength(5);
    expect(documents.every((stored) => stored.document.data.length > 4096)).toBe(true);
  }
  const before = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  const coldResponse = await request(worker, namespace, "query", textQuery("shared", 10));
  expect(coldResponse.status).toBe(200);
  const cold = Schema.decodeUnknownSync(QueryResult)(await coldResponse.json());
  const ids = Array.from({ length: 10 }, (_, index) => String(index).padStart(3, "0"));
  expect(cold.rows.map((row) => row.id)).toEqual(ids);
  expect(new Set(cold.rows.map((row) => row.score)).size).toBe(1);
  expect(cold.rows.map((row) => [row.title, row.text, row.attributes])).toEqual(
    ids.map(() => ["", `shared ${body}`, {}]),
  );
  const after = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(after.cache.rangeReads - before.cache.rangeReads).toBeLessThanOrEqual(6);
  const warmResponse = await request(worker, namespace, "query", textQuery("shared", 10));
  expect(warmResponse.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await warmResponse.json())).toEqual(cold);
});

test("contiguous top-k pages share bounded reads and retain individual memory cache hits", async () => {
  const namespace = "contiguous-result-pages";
  await request(
    worker,
    namespace,
    "write",
    write(
      Array.from({ length: 40 }, (_, index) =>
        document(String(index).padStart(4, "0"), "equal terms"),
      ),
    ),
  );
  const before = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  const initial = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("equal", 10))).json(),
  );
  expect(initial.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index).padStart(4, "0")),
  );
  const after = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(after.cache.rangeReads - before.cache.rangeReads).toBeLessThanOrEqual(5);
  const smaller = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("equal", 1))).json(),
  );
  expect(smaller.rows).toEqual(initial.rows.slice(0, 1));
  const warm = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(warm.cache.rangeReads - after.cache.rangeReads).toBe(0);
  await request(worker, namespace, "rebuild", {});
  const cold = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("equal", 1))).json(),
  );
  expect(cold.rows).toEqual(smaller.rows);
});

test("native Cache API retains compressed canonical directories after memory eviction", async () => {
  await request(worker, "cached", "write", write([document("a", "original cached content")]));
  const initial = await request(worker, "cached", "query", {
    ...textQuery("original cached"),
    match: "phrase",
  });
  expect(initial.status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const root = await bucket.get("namespaces/cached/root.json");
  if (root === null) throw new Error("Missing root");
  const manifest = decodeRoot(await root.text());
  const segment = manifest.segments[0];
  if (segment === undefined) throw new Error("Missing committed segment");
  const caches = await worker.getCaches();
  const cache = await caches.open("raio-segments-v1");
  const key = new URL("https://raio-cache.internal/directory-v6");
  key.searchParams.set("key", segment.key);
  key.searchParams.set("offset", "0");
  key.searchParams.set("length", String(segment.headerBytes));
  key.searchParams.set("bucket", "raio-test");
  key.searchParams.set("format", "compact-json-v2");
  const cached = await cache.match(key);
  expect(cached).toBeDefined();
  if (cached === undefined) return;
  const encoded = new Uint8Array(await cached.arrayBuffer());
  expect(encoded.byteLength).toBeLessThan(segment.headerBytes);
  expect(new TextDecoder().decode(encoded.subarray(0, 8))).toBe("RAIODIR6");
  expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(8, true)).toBe(
    segment.headerBytes,
  );
  const canonical = await bucket.get(segment.key, {
    range: { offset: 0, length: segment.headerBytes },
  });
  if (canonical === null) throw new Error("Missing canonical header");
  expect(
    new TextDecoder().decode(new Uint8Array(await canonical.arrayBuffer()).subarray(0, 8)),
  ).toBe("RAIOSEG4");
  await request(worker, "cached", "rebuild", {});
  expect(
    (await request(worker, "cached", "query", { ...textQuery("original cached"), match: "phrase" }))
      .status,
  ).toBe(200);
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "cached", "metadata")).json(),
  );
  expect(metadata.cache.cacheApiHits).toBeGreaterThan(0);
});

test("previous-generation derived directory objects are neither read nor replaced", async () => {
  const namespace = "directory-generations";
  await request(worker, namespace, "write", write([document("a", "generation isolated content")]));
  const bucket = await worker.getR2Bucket("STORAGE");
  const root = await bucket.get(`namespaces/${namespace}/root.json`);
  if (root === null) throw new Error("Missing root");
  const segment = decodeRoot(await root.text()).segments[0];
  if (segment === undefined) throw new Error("Missing committed segment");
  const source = JSON.stringify({ key: segment.key, headerBytes: segment.headerBytes });
  const previous = [
    `cache/directory-v5/${segment.key}/${segment.headerBytes}`,
    `cache/directory-common-v3/${segment.key}/${segment.headerBytes}`,
  ];
  const stale = new Uint8Array(64);
  stale.set(new TextEncoder().encode("RAIODIR5"));
  const seeded = await Promise.all(
    previous.map((identity) => bucket.put(identity, stale, { customMetadata: { source } })),
  );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  await clearLeaderIndex(worker, namespace);
  const queried = await request(worker, namespace, "query", {
    ...textQuery("generation isolated"),
    match: "phrase",
    consistency: "edge-eventual",
  });
  expect(queried.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await queried.json()).rows.map((row) => row.id),
  ).toEqual(["a"]);
  const current = `cache/directory-v6/${segment.key}/${segment.headerBytes}`;
  const published = await (async () => {
    for (const attempt of Array.from({ length: 50 }, (_, index) => index)) {
      const object = await bucket.get(current);
      if (object !== null) return new Uint8Array(await object.arrayBuffer());
      await Bun.sleep(100 + attempt);
    }
    return undefined;
  })();
  if (published === undefined) throw new Error("Missing current-generation directory frame");
  expect(new TextDecoder().decode(published.subarray(0, 8))).toBe("RAIODIR6");
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.directoryR2CacheRejected).toBe(before.directoryR2CacheRejected);
  for (const [index, identity] of previous.entries()) {
    const object = await bucket.get(identity);
    if (object === null) throw new Error(`Missing previous-generation object ${identity}`);
    const original = seeded[index];
    if (original === undefined || original === null)
      throw new Error(`Missing previous-generation receipt ${identity}`);
    expect(object.etag).toBe(original.etag);
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(stale);
  }
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
  for (const path of ["/range", "/directory-v6", "/catalog-v12"]) {
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
        document(
          String(index).padStart(4, "0"),
          (() => {
            if (index === 0) return "shared shared cold storage";
            return "shared cold storage";
          })(),
        ),
      ),
    ),
  );
  await clearLeaderIndex(worker, namespace);
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
      expect(response.headers.get("server-timing")).toContain(
        'text_uniform_hits;desc="segments=0"',
      );
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
  expect(after.rangeReads - before.rangeReads).toBe(1);
  expect(after.directoryR2CacheReads - before.directoryR2CacheReads).toBe(1);
  expect(after.directoryCommonHits).toBeGreaterThan(before.directoryCommonHits);
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
  expect(acquired.termRequests - before.termRequests).toBe(17);
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
  expect(after.termRequests - acquired.termRequests).toBe(17);
  expect(after.termReads - acquired.termReads).toBe(129);
  expect(after.termBytes - acquired.termBytes).toBeLessThan(acquired.termBytes - before.termBytes);
  const changedFilter = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("shared storage", 10, [{ field: "group", op: "eq", value: 0 }]),
      )
    ).json(),
  );
  expect(changedFilter.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index * 2).padStart(3, "0")),
  );
  expect(changedFilter.rows.map((row) => row.score)).toEqual(first.rows.map((row) => row.score));
  const reused = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(reused.termRequests - after.termRequests).toBe(0);
  expect(reused.termBytes - after.termBytes).toBe(0);
  expect(reused.termCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const changedTerms = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("shared cold", 10, [{ field: "group", op: "eq", value: 1 }]),
      )
    ).json(),
  );
  expect(changedTerms.rows).toEqual(filtered.rows);
  const changed = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(changed.termRequests - reused.termRequests).toBe(17);
  expect(changed.termCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const repeat = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("shared cold", 10, [{ field: "group", op: "eq", value: 1 }]),
      )
    ).json(),
  );
  expect(repeat.rows).toEqual(filtered.rows);
  const warm = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(warm.termRequests - changed.termRequests).toBe(0);
  expect(warm.termMemoryHits - changed.termMemoryHits).toBe(0);
  expect(warm.textPlanCacheHits - changed.textPlanCacheHits).toBe(1);
});

test("mixed catalog misses preserve selectors, global frequencies and cached halves", async () => {
  const namespace = "mixed-catalog-misses";
  const selectedFilters = [{ field: "group", op: "eq", value: 1 }];
  await request(worker, namespace, "write", write([document("a", "shared", { group: 1 })]));
  await request(worker, namespace, "query", textQuery("shared"));
  await request(worker, namespace, "write", write([document("b", "shared other", { group: 1 })]));
  await request(worker, namespace, "query", textQuery("other", 10, selectedFilters));
  await request(worker, namespace, "write", write([document("c", "shared", { group: 0 })]));
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const first = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", textQuery("shared", 10, selectedFilters))
    ).json(),
  );
  const acquired = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(first.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(acquired.termRequests - before.termRequests).toBe(3);
  expect(acquired.termReads - before.termReads).toBe(3);
  const repeat = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", textQuery("shared", 10, selectedFilters))
    ).json(),
  );
  const warm = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(repeat.rows).toEqual(first.rows);
  expect(warm.termRequests - acquired.termRequests).toBe(0);
  expect(warm.termMemoryHits - acquired.termMemoryHits).toBe(3);
  expect(first.rows[0]?.score).toBeCloseTo(Math.log1p(0.5 / 3.5) * (176 / 158), 12);
  expect(first.rows[1]?.score).toBeCloseTo(Math.log1p(0.5 / 3.5) * (88 / 106), 12);
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
  await evictWrittenOverviews(worker, namespace);
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
  expect(shared.overviewCacheApiLookups - memory.overviewCacheApiLookups).toBe(3);
});

test("corrupted compressed overview cache falls back to verified immutable source data", async () => {
  const namespace = "overview-corruption";
  await request(worker, namespace, "write", write([document("a", "alpha beta")]));
  expect((await request(worker, namespace, "query", textQuery("alpha"))).status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing manifest");
  const manifest = decodeRoot(await object.text());
  const segment = manifest.segments[0];
  if (segment === undefined) throw new Error("Missing segment");
  const cache = await (await worker.getCaches()).open("raio-overview-batches-v8");
  const key = new URL("https://overviews.internal/batch-v8");
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
  expect(after.correlatedHits - before.correlatedHits).toBe(1);
  expect(after.overviewCacheApiHits - before.overviewCacheApiHits).toBe(0);
});

for (const match of ["all", "phrase"] as const)
  test(`${match} rejects incomplete segments before document materialization`, async () => {
    const namespace = `conjunctive-${match}`;
    for (const index of Array.from({ length: 29 }, (_, ordinal) => ordinal))
      await request(
        worker,
        namespace,
        "write",
        write([document(`partial-${index}`, "cloudflare storage")]),
      );
    await request(
      worker,
      namespace,
      "write",
      write([
        document(
          "complete",
          (() => {
            if (match === "all") return "cloudflare cloudflare rust";
            return "cloudflare rust";
          })(),
        ),
      ]),
    );
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const response = await request(worker, namespace, "query", {
      ...textQuery("cloudflare rust cloudflare"),
      match,
      consistency: "edge-eventual",
    });
    expect(response.status).toBe(200);
    if (match === "all")
      expect(response.headers.get("server-timing")).toContain(
        'text_uniform_hits;desc="segments=0"',
      );
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    if (match === "all") expect(result.rows.map((row) => row.id)).toEqual(["complete"]);
    else expect(result.rows).toEqual([]);
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    if (match === "all") {
      expect(after.rangeReads - before.rangeReads).toBe(1);
      expect(response.headers.get("server-timing")).toContain(
        'text_singleton_hits;desc="segments=1"',
      );
      expect(response.headers.get("server-timing")).toMatch(
        /text_posting_acquire;dur=[^,]*;desc="spans=0 bytes=0 ranges=0"/,
      );
    } else expect(after.rangeReads - before.rangeReads).toBe(0);
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
  expect(after.directoryCacheHits - before.directoryCacheHits).toBe(0);
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
  await request(
    worker,
    namespace,
    "write",
    write([document("complete", "cloudflare cloudflare rust")]),
  );
  const input = { ...textQuery("cloudflare rust"), match: "all", consistency: "edge-eventual" };
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(original.rows.map((row) => row.id)).toEqual(["complete"]);
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const restoredResponse = await request(worker, namespace, "query", input);
  expect(restoredResponse.headers.get("server-timing")).toContain(
    'text_uniform_hits;desc="segments=0"',
  );
  const restored = Schema.decodeUnknownSync(QueryResult)(await restoredResponse.json());
  expect(restored.rows).toEqual(original.rows);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(1);
  expect(restoredResponse.headers.get("server-timing")).toContain(
    'text_singleton_hits;desc="segments=1"',
  );
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
          document(String(index * 16 + row).padStart(5, "0"), "equal equal terms"),
        ),
      ),
    );
  await clearLeaderIndex(worker, namespace);
  const input = { ...textQuery("equal terms", 1), consistency: "edge-eventual" };
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(original.rows.map((row) => row.id)).toEqual(["00000"]);
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const restoredResponse = await request(worker, namespace, "query", input);
  expect(restoredResponse.headers.get("server-timing")).toContain(
    'text_uniform_hits;desc="segments=0"',
  );
  const restored = Schema.decodeUnknownSync(QueryResult)(await restoredResponse.json());
  expect(restored.rows).toEqual(original.rows);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(1);
  expect(after.directoryR2CacheReads - before.directoryR2CacheReads).toBe(1);
  expect(after.directoryCommonHits).toBeGreaterThan(before.directoryCommonHits);
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
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootKey = `namespaces/${namespace}/root.json`;
  const object = await bucket.get(rootKey);
  if (object === null) throw new Error("Missing projection-isolation Root");
  const root = decodeRoot(await object.text());
  await bucket.put(
    rootKey,
    encodeRoot({
      ...root,
      segments: root.segments.map((segment) => Object.assign({}, segment, { eligibility: null })),
    }),
  );
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
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
  expect(after.termReads - before.termReads).toBe(1);
  expect(after.termMemoryHits - before.termMemoryHits).toBe(1);
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
      write([document(String(index).padStart(5, "0"), "equal equal terms")]),
    );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const response = await request(worker, namespace, "query", {
    ...textQuery("equal terms", 1),
    consistency: "edge-eventual",
  });
  expect(response.headers.get("server-timing")).toContain('text_uniform_hits;desc="segments=0"');
  const found = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(found.rows.map((row) => row.id)).toEqual(["00000"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(1);
  expect(response.headers.get("server-timing")).toContain('text_singleton_hits;desc="segments=1"');
});

test("filtered score projections prune headers after directory eviction", async () => {
  const namespace = "filtered-projection";
  for (const index of Array.from({ length: 16 }, (_, ordinal) => ordinal))
    await request(
      worker,
      namespace,
      "write",
      write([document(String(index).padStart(5, "0"), "equal equal terms", { group: 1 })]),
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
  const restoredResponse = await request(worker, namespace, "query", input);
  expect(restoredResponse.headers.get("server-timing")).toContain(
    'text_uniform_hits;desc="segments=0"',
  );
  const restored = Schema.decodeUnknownSync(QueryResult)(await restoredResponse.json());
  expect(restored.rows).toEqual(original.rows);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(1);
  expect(restoredResponse.headers.get("server-timing")).toContain(
    'text_singleton_hits;desc="segments=1"',
  );
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
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootKey = `namespaces/${namespace}/root.json`;
  const object = await bucket.get(rootKey);
  if (object === null) throw new Error("Missing negative-eligibility Root");
  const root = decodeRoot(await object.text());
  await bucket.put(
    rootKey,
    encodeRoot({
      ...root,
      segments: root.segments.map((segment) => Object.assign({}, segment, { eligibility: null })),
    }),
  );
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
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

test("zero score certificates skip repeated empty phrases and respect revisions", async () => {
  const namespace = "zero-score-phrase";
  for (const batch of [0, 1, 2, 3, 4, 5])
    await request(
      worker,
      namespace,
      "write",
      write([document(`${batch}-a`, "cloudflare rust"), document(`${batch}-b`, "cloudflare rust")]),
    );
  const input = { ...textQuery("rust cloudflare"), match: "phrase" };
  const initial = await request(worker, namespace, "query", input);
  expect(initial.status).toBe(200);
  const first = Schema.decodeUnknownSync(QueryResult)(await initial.json());
  expect(first.rows).toEqual([]);
  expect(initial.headers.get("server-timing")).toMatch(/text_score;dur=[^,]*;desc="segments=6"/u);
  const repeated = await request(worker, namespace, "query", input);
  expect(repeated.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await repeated.json())).toEqual(first);
  expect(repeated.headers.get("server-timing")).toMatch(/text_score;dur=[^,]*;desc="segments=0"/u);
  await request(worker, namespace, "write", write([document("0-a", "rust cloudflare")]));
  const changed = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...input, minimumSequence: 7 })).json(),
  );
  expect(changed.rows.map((row) => row.id)).toEqual(["0-a"]);
});

test("retained Bloom candidates stay bounded across root updates and namespace rebuilds", async () => {
  const namespace = "retained-bloom-lifecycle";
  await request(worker, namespace, "write", write([document("a", "alpha"), document("b", "beta")]));
  const input = { ...textQuery("alpha"), consistency: "edge-eventual", minimumSequence: 1 };
  for (const _iteration of [0, 1, 2]) {
    const result = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, namespace, "query", input)).json(),
    );
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  }
  await request(
    worker,
    namespace,
    "write",
    write([document("a", "gamma"), document("c", "alpha")], ["b"]),
  );
  const updated = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...input, minimumSequence: 2 })).json(),
  );
  expect(updated.rows.map((row) => row.id)).toEqual(["c"]);
  await request(worker, namespace, "rebuild", {});
  const rebuilt = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...input, minimumSequence: 2 })).json(),
  );
  expect(rebuilt.rows).toEqual(updated.rows);
  const health = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(health.bloomCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

test("document Bloom windows preserve newest revisions across partial sixty-four-segment boundaries", async () => {
  const namespace = "document-bloom-boundaries";
  const windows = EffectArray.chunksOf(
    Array.from({ length: 130 }, (_, ordinal) => ordinal),
    64,
  );
  for (const window of windows)
    await Effect.runPromise(
      Effect.forEach(
        window,
        (index) =>
          Effect.tryPromise(() =>
            request(
              worker,
              namespace,
              "write",
              write([document(String(index).padStart(3, "0"), "source common", { group: index })]),
            ),
          ),
        { concurrency: 4 },
      ),
    );
  const rootObject = await (
    await worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  expect(rootObject).not.toBeNull();
  if (rootObject === null) return;
  const seeded = decodeRoot(await rootObject.text());
  expect(seeded.segments).toHaveLength(130);
  for (const [index, window] of windows.entries())
    expect(
      seeded.segments
        .slice(index * 64, index * 64 + window.length)
        .map((segment) => segment.minimumId)
        .toSorted(),
    ).toEqual(window.map((id) => String(id).padStart(3, "0")));
  await request(
    worker,
    namespace,
    "write",
    write(
      [0, 64, 129].map((index) =>
        document(String(index).padStart(3, "0"), "replacement common", { group: index }),
      ),
      ["001", "065", "128"],
    ),
  );
  const replacements = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("replacement"))).json(),
  );
  expect(replacements.rows.map((row) => row.id)).toEqual(["000", "064", "129"]);
  const retired = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("source", 10, [{ field: "group", op: "in", value: [0, 1, 64, 65, 128, 129] }]),
      )
    ).json(),
  );
  expect(retired.rows).toEqual([]);
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(metadata.documents).toBe(127);
  expect(metadata.cache.bloomCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
}, 15_000);

test("decoded frequency pages share the range budget and keep tombstones query-local", async () => {
  const namespace = "frequency-page-lifecycle";
  await request(
    worker,
    namespace,
    "write",
    write(
      Array.from({ length: 300 }, (_, index) =>
        document(String(index).padStart(3, "0"), "alpha beta ".repeat(20), { group: index % 2 }),
      ),
    ),
  );
  await useHeaderOnlyCommonFrames(worker, namespace);
  expect((await request(worker, namespace, "query", textQuery("alpha"))).status).toBe(200);
  const first = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("alpha beta"))).json(),
  );
  const warm = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("alpha beta"))).json(),
  );
  expect(warm.rows).toEqual(first.rows);
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(metadata.cache.postingCacheBytes).toBeGreaterThan(0);
  expect(metadata.cache.rangeCacheBytes + metadata.cache.postingCacheBytes).toBeLessThanOrEqual(
    12 * 1024 * 1024,
  );
  await request(
    worker,
    namespace,
    "write",
    write([document("000", "gamma", { group: 0 })], ["001"]),
  );
  const changed = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("alpha beta", 10, [{ field: "group", op: "eq", value: 1 }]),
      )
    ).json(),
  );
  expect(changed.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index * 2 + 3).padStart(3, "0")),
  );
  await request(worker, namespace, "rebuild", {});
  const rebuilt = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        namespace,
        "query",
        textQuery("alpha beta", 10, [{ field: "group", op: "eq", value: 1 }]),
      )
    ).json(),
  );
  expect(rebuilt.rows).toEqual(changed.rows);
});

test("a prior segment cutoff rejects noncompetitive posting pages before acquisition", async () => {
  const namespace = "cutoff-posting-pages";
  for (const [index, prefix] of ["a", "c", "d"].entries()) {
    const rows = Array.from({ length: 499 }, (_, row) =>
      document(`${prefix}${String(row).padStart(4, "0")}`, "alpha beta"),
    );
    if (index === 0)
      rows.splice(
        0,
        10,
        ...Array.from({ length: 10 }, (_, row) =>
          document(`a${String(row).padStart(4, "0")}`, "alpha beta ".repeat(8)),
        ),
      );
    rows.push(
      document(`${prefix}z`, `${"alpha beta ".repeat(64 - index * 16)}${"padding ".repeat(5000)}`),
    );
    expect((await request(worker, namespace, "write", write(rows))).status).toBe(200);
  }
  const bucket = await worker.getR2Bucket("STORAGE");
  const derived = await bucket.list({
    prefix: `cache/correlated-pool-v3/namespaces/${namespace}/`,
  });
  await bucket.delete(derived.objects.map((object) => object.key));
  await evictWrittenOverviews(worker, namespace);
  await useHeaderOnlyCommonFrames(worker, namespace);
  const rootKey = `namespaces/${namespace}/root.json`;
  const object = await bucket.get(rootKey);
  if (object === null) throw new Error("Missing posting-cutoff Root");
  const root = decodeRoot(await object.text());
  await bucket.put(
    rootKey,
    encodeRoot({
      ...root,
      segments: root.segments.map((segment) =>
        Object.assign({}, segment, { commonProjection: null }),
      ),
    }),
  );
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  for (const match of ["any", "all", "phrase"] as const) {
    const response = await request(worker, namespace, "query", {
      ...textQuery("alpha beta"),
      match,
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 10 }, (_, row) => `a${String(row).padStart(4, "0")}`),
    );
    const expectedBlocks = { any: 8, all: 8, phrase: 12 };
    expect(response.headers.get("server-timing")).toContain(`blocks=${expectedBlocks[match]}`);
  }
});

test("parallel segment ranking matches an unfragmented index across revisions and phrase order", async () => {
  const documents = Array.from({ length: 624 }, (_, index) => {
    const words = ["alpha beta alpha", "beta alpha", "alpha gamma", "beta gamma"];
    const text = words[index % words.length];
    if (text === undefined) throw new Error("Missing fixture text");
    return document(String(623 - index).padStart(4, "0"), text, { group: index % 3 });
  });
  const fragmented = "parallel-fragmented";
  const reference = "parallel-reference";
  for (const offset of Array.from({ length: 13 }, (_, index) => index * 48))
    for (const namespace of [fragmented, reference])
      await request(worker, namespace, "write", write(documents.slice(offset, offset + 48)));
  expect((await request(worker, reference, "compact", {})).status).toBe(200);
  for (const namespace of [fragmented, reference])
    await request(
      worker,
      namespace,
      "write",
      write([document("0623", "alpha beta alpha", { group: 2 })], ["0000", "0048", "0096"]),
    );
  for (const mode of ["any", "all", "phrase"] as const)
    for (const text of ["alpha beta alpha", "beta alpha"])
      for (const topK of [1, 17, 100]) {
        const input = {
          ...textQuery(text, topK, [{ field: "group", op: "in", value: [1, 2] }]),
          match: mode,
        };
        const expected = Schema.decodeUnknownSync(QueryResult)(
          await (await request(worker, reference, "query", input)).json(),
        );
        const actual = Schema.decodeUnknownSync(QueryResult)(
          await (await request(worker, fragmented, "query", input)).json(),
        );
        expect(actual.rows).toEqual(expected.rows);
        expect(actual.sequence).toBe(14);
      }
});

test("the sequential ranking prefix preserves common-query pruning before parallel fanout", async () => {
  const namespace = "parallel-priority-prefix";
  for (const offset of Array.from({ length: 20 }, (_, index) => index * 500))
    expect((await request(worker, namespace, "write", write(corpus(offset, 10000)))).status).toBe(
      200,
    );
  await clearLeaderIndex(worker, namespace);
  const response = await request(worker, namespace, "query", textQuery("cloudflare rust"));
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.sequence).toBe(20);
  expect(result.rows.map((row) => row.id)).toEqual([
    "0",
    "1000",
    "1008",
    "1016",
    "1024",
    "1032",
    "104",
    "1040",
    "1048",
    "1056",
  ]);
  expect(response.headers.get("server-timing")).toContain('text_uniform_hits;desc="segments=2"');
  expect(response.headers.get("server-timing")).toContain(
    'text_posting_decode;dur=0;desc="blocks=0"',
  );
  expect(response.headers.get("server-timing")).toMatch(/text_score;dur=[^,]*;desc="segments=2"/);
});
