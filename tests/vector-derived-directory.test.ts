import { expect, test } from "bun:test";
import { Response } from "miniflare";
import { Effect, Schema } from "effect";
import { Directory, directory_compress, initSync } from "../dist/wasm/raio_engine";
import { decodeRoot } from "../src/manifest";
import { LocatedDocument, Metadata, QueryResult, TermProjectionRange } from "../src/protocol";
import { request, startWorker, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

for (const phase of ["prepared", "missing", "corrupt"] as const)
  test(`pure vector preserves complete results through ${phase} derived R2 directories`, async () => {
    await using cleanup = new AsyncDisposableStack();
    const worker = await startWorker();
    cleanup.defer(() => worker.dispose());
    const namespace = `vector-directory-${phase}`;
    const vector = [1, ...Array.from({ length: 767 }, () => 0)];
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([
            { id: "a", text: "lexical alpha", attributes: { source: "first" }, vector },
            {
              id: "b",
              text: "lexical beta",
              attributes: { source: "second" },
              vector: [0.8, 0.6, ...Array.from({ length: 766 }, () => 0)],
            },
          ]),
        )
      ).status,
    ).toBe(200);
    expect((await request(worker, namespace, "vector-sync", {})).status).toBe(200);
    const query = { kind: "vector", vector, topK: 2, filters: [] };
    const reference = await request(worker, namespace, "query", query);
    expect(reference.status).toBe(200);
    const expected = Schema.decodeUnknownSync(QueryResult)(await reference.json());
    expect(expected.rows.map((row) => row.id)).toEqual(["a", "b"]);
    const bucket = await worker.getR2Bucket("STORAGE");
    const rootObject = await bucket.get(`namespaces/${namespace}/root.json`);
    if (rootObject === null) throw new Error("Missing fixture root");
    const root = decodeRoot(await rootObject.text());
    expect(root.segments).toHaveLength(1);
    const segment = root.segments[0];
    if (segment === undefined) throw new Error("Missing fixture segment");
    const canonical = await bucket.get(segment.key);
    if (canonical === null) throw new Error("Missing canonical segment");
    const canonicalEtag = canonical.etag;
    const bytes = new Uint8Array(await canonical.arrayBuffer());
    const identity = `cache/directory-v8/${segment.key}/${segment.headerBytes}`;
    const source = Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
      key: segment.key,
      headerBytes: segment.headerBytes,
    });
    const frame = new Uint8Array(directory_compress(bytes.subarray(0, segment.headerBytes)));
    await bucket.put(identity, frame, { customMetadata: { source } });
    if (phase === "missing") await bucket.delete(identity);
    if (phase === "corrupt")
      await bucket.put(identity, new Uint8Array([1, 2, 3]), { customMetadata: { source } });
    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
    await worker.purgeCache("raio-segments-v1");
    await worker.purgeCache("kannin-vectors-v2");
    const before = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    const response = await request(worker, namespace, "query", query);
    expect(response.status).toBe(200);
    const actual = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(actual).toEqual(expected);
    const after = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    expect(after.cache.directoryR2CacheReads - before.cache.directoryR2CacheReads).toBeGreaterThan(
      0,
    );
    expect((await bucket.head(segment.key))?.etag).toBe(canonicalEtag);
    expect((await bucket.head(segment.key))?.size).toBe(bytes.byteLength);
    if (phase === "prepared") {
      expect(after.cache.directoryR2CacheHits - before.cache.directoryR2CacheHits).toBe(1);
      expect(
        after.cache.directoryR2CacheOriginResponses - before.cache.directoryR2CacheOriginResponses,
      ).toBe(0);
      expect(after.cache.directoryR2CacheBytes - before.cache.directoryR2CacheBytes).toBe(
        frame.byteLength,
      );
    } else {
      expect(after.cache.directoryR2CacheReads - before.cache.directoryR2CacheReads).toBe(1);
      if (phase === "corrupt")
        expect(
          after.cache.directoryR2CacheRejected - before.cache.directoryR2CacheRejected,
        ).toBeGreaterThan(0);
      for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
        const object = await bucket.head(identity);
        if (object !== null && object.size > 3) break;
        if (attempt === 99) throw new Error("Recovered R2 directory publication did not settle");
        await Effect.runPromise(Effect.sleep("10 millis"));
      }
    }
    const recovered = await bucket.get(identity);
    if (recovered === null) throw new Error("Missing recovered derived R2 directory");
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(TermProjectionRange))(
        recovered.customMetadata?.source,
      ),
    ).toEqual({ key: segment.key, headerBytes: segment.headerBytes });
    using directory = Directory.compressed(
      new Uint8Array(await recovered.arrayBuffer()),
      segment.headerBytes,
      40 * 1024 * 1024,
    );
    const located = Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
      directory.lookup('["a","b"]', "[]"),
    );
    expect(located.map((entry) => entry.document.id)).toEqual(["a", "b"]);

    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
    await worker.purgeCache("raio-segments-v1");
    await worker.purgeCache("kannin-vectors-v2");
    const hybridBefore = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    const hybrid = await request(worker, namespace, "query", {
      ...query,
      kind: "hybrid",
      text: "lexical",
    });
    expect(hybrid.status).toBe(200);
    const fused = Schema.decodeUnknownSync(QueryResult)(await hybrid.json());
    expect(fused.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(fused.rows[0]?.score).toBe(2 / 61);
    expect(fused.rows[1]?.score).toBe(2 / 62);
    const hybridAfter = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    expect(
      hybridAfter.cache.directoryR2CacheOriginResponses -
        hybridBefore.cache.directoryR2CacheOriginResponses,
    ).toBe(1);
  });

for (const [phase, title] of [
  [
    "missing",
    "a healthy Cache API directory survives a missing derived R2 frame without another probe",
  ],
  [
    "corrupt",
    "a healthy Cache API directory survives a corrupt derived R2 frame without another probe",
  ],
  ["corrupt-api", "pure vector recovers a corrupt Cache API directory from one healthy R2 frame"],
] as const)
  test(title, async () => {
    await using cleanup = new AsyncDisposableStack();
    const worker = await startWorker();
    cleanup.defer(() => worker.dispose());
    const namespace = `vector-api-${phase}`;
    const vector = [1, ...Array.from({ length: 767 }, () => 0)];
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([
            { id: "a", text: "lexical alpha", attributes: { source: "first" }, vector },
            {
              id: "b",
              text: "lexical beta",
              attributes: { source: "second" },
              vector: [0.8, 0.6, ...Array.from({ length: 766 }, () => 0)],
            },
          ]),
        )
      ).status,
    ).toBe(200);
    expect((await request(worker, namespace, "vector-sync", {})).status).toBe(200);
    const query = { kind: "vector", vector, topK: 2, filters: [] };
    const bucket = await worker.getR2Bucket("STORAGE");
    const rootObject = await bucket.get(`namespaces/${namespace}/root.json`);
    if (rootObject === null) throw new Error("Missing Cache API fixture root");
    const root = decodeRoot(await rootObject.text());
    const segment = root.segments[0];
    if (segment === undefined) throw new Error("Missing Cache API fixture segment");
    const canonical = await bucket.get(segment.key);
    if (canonical === null) throw new Error("Missing Cache API fixture canonical segment");
    const canonicalEtag = canonical.etag;
    const bytes = new Uint8Array(await canonical.arrayBuffer());
    const identity = `cache/directory-v8/${segment.key}/${segment.headerBytes}`;
    const source = Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
      key: segment.key,
      headerBytes: segment.headerBytes,
    });
    const frame = new Uint8Array(directory_compress(bytes.subarray(0, segment.headerBytes)));
    await bucket.put(identity, frame, { customMetadata: { source } });
    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
    await worker.purgeCache("raio-segments-v1");
    const primeBefore = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    const primed = await request(worker, namespace, "query", {
      ...query,
      kind: "hybrid",
      text: "lexical",
    });
    expect(primed.status).toBe(200);
    await primed.arrayBuffer();
    const primeAfter = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    expect(
      primeAfter.cache.directoryR2CacheOriginResponses -
        primeBefore.cache.directoryR2CacheOriginResponses,
    ).toBe(1);
    const cache = await (await worker.getCaches()).open("raio-segments-v1");
    const cacheKey = new URL("https://raio-cache.internal/directory-v8");
    cacheKey.searchParams.set("key", segment.key);
    cacheKey.searchParams.set("offset", "0");
    cacheKey.searchParams.set("length", String(segment.headerBytes));
    cacheKey.searchParams.set("bucket", "raio-test");
    cacheKey.searchParams.set("format", "compact-json-v2");
    for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
      const cached = await cache.match(cacheKey);
      if (cached !== undefined) {
        expect(new Uint8Array(await cached.arrayBuffer())).toEqual(frame);
        break;
      }
      if (attempt === 99) throw new Error("Header Cache API publication did not settle");
      await Effect.runPromise(Effect.sleep("10 millis"));
    }
    const reference = await request(worker, namespace, "query", query);
    expect(reference.status).toBe(200);
    const expected = Schema.decodeUnknownSync(QueryResult)(await reference.json());
    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
    await worker.purgeCache("kannin-vectors-v2");
    if (phase === "missing") await bucket.delete(identity);
    if (phase === "corrupt")
      await bucket.put(identity, new Uint8Array([1, 2, 3]), { customMetadata: { source } });
    if (phase === "corrupt-api")
      await cache.put(
        cacheKey,
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "cache-control": "public, max-age=3600", "content-length": "3" },
        }),
      );
    const before = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    const response = await request(worker, namespace, "query", query);
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(expected);
    const after = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    if (phase === "corrupt-api") {
      expect(after.cache.directoryR2CacheReads - before.cache.directoryR2CacheReads).toBe(1);
      expect(after.cache.directoryR2CacheHits - before.cache.directoryR2CacheHits).toBe(1);
      const unchanged = await bucket.get(identity);
      if (unchanged === null) throw new Error("Healthy derived R2 frame was unexpectedly removed");
      expect(new Uint8Array(await unchanged.arrayBuffer())).toEqual(frame);
    } else {
      expect(after.cache.directoryR2CacheReads - before.cache.directoryR2CacheReads).toBe(0);
      expect(after.cache.directoryR2CacheHits - before.cache.directoryR2CacheHits).toBe(0);
      expect(after.cache.cacheApiHits - before.cache.cacheApiHits).toBeGreaterThan(0);
    }
    expect(after.cache.directoryR2FallbackReads - before.cache.directoryR2FallbackReads).toBe(0);
    expect((await bucket.head(segment.key))?.etag).toBe(canonicalEtag);
    if (phase === "missing") expect(await bucket.head(identity)).toBeNull();
    if (phase === "corrupt") {
      const unchanged = await bucket.get(identity);
      if (unchanged === null) throw new Error("Corrupt derived frame was unexpectedly removed");
      expect(new Uint8Array(await unchanged.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }
  });
