import { decodeRoot } from "../src/manifest";
import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { initSync, directory_compress } from "../dist/wasm/raio_engine";
import { Metadata, QueryResult, TermProjectionRange } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("parallel cold ranking preserves complete results through missing and corrupt R2 directories", async () => {
  await using cleanup = new AsyncDisposableStack();
  const persistence = await mkdtemp(join(tmpdir(), "kannin-parallel-directories-"));
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const namespace = "parallel-directories";
  {
    await using lifetime = new AsyncDisposableStack();
    const worker = await startWorker(persistence);
    lifetime.defer(() => worker.dispose());
    for (const batch of [0, 1, 2, 3]) {
      const documents = Array.from({ length: 32 }, (_, offset) => {
        const index = batch * 32 + offset;
        return document(String(index).padStart(3, "0"), `rust cloudflare unique${index}`, {
          value: index,
        });
      });
      expect((await request(worker, namespace, "write", write(documents))).status).toBe(200);
    }
    const bucket = await worker.getR2Bucket("STORAGE");
    const object = await bucket.get(`namespaces/${namespace}/root.json`);
    if (object === null) throw new Error("Missing seeded root");
    const root = decodeRoot(await object.text());
    for (const segment of root.segments) {
      const source = await bucket.get(segment.key);
      if (source === null) throw new Error("Missing canonical segment");
      const bytes = new Uint8Array(await source.arrayBuffer());
      await bucket.put(
        `cache/directory-v5/${segment.key}/${segment.headerBytes}`,
        new Uint8Array(directory_compress(bytes.subarray(0, segment.headerBytes))),
        {
          customMetadata: {
            source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
              key: segment.key,
              headerBytes: segment.headerBytes,
            }),
          },
        },
      );
    }
  }
  const expected = new Map<string, typeof QueryResult.Type>();
  for (const phase of ["prepared", "missing", "corrupt"]) {
    await using lifetime = new AsyncDisposableStack();
    const isolated = await mkdtemp(join(tmpdir(), "kannin-parallel-cold-"));
    lifetime.defer(() => rm(isolated, { recursive: true, force: true }));
    await symlink(join(persistence, "r2"), join(isolated, "r2"), "dir");
    const worker = await startWorker(isolated);
    lifetime.defer(() => worker.dispose());
    const bucket = await worker.getR2Bucket("STORAGE");
    const object = await bucket.get(`namespaces/${namespace}/root.json`);
    if (object === null) throw new Error("Missing persisted root");
    const root = decodeRoot(await object.text());
    for (const segment of root.segments) {
      const key = `cache/directory-v5/${segment.key}/${segment.headerBytes}`;
      if (phase === "missing") await bucket.delete(key);
      if (phase === "corrupt")
        await bucket.put(key, new Uint8Array([1, 2, 3]), {
          customMetadata: {
            source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
              key: segment.key,
              headerBytes: segment.headerBytes,
            }),
          },
        });
    }
    for (const consistency of ["strong", "edge-eventual"] as const) {
      const response = await request(worker, namespace, "query", {
        ...textQuery("unique0 unique33 unique66 unique99", 10, [
          { field: "value", op: "gte", value: 0 },
        ]),
        consistency,
        minimumSequence: 4,
      });
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.rows.map((row) => row.id)).toEqual(["000", "033", "066", "099"]);
      expect(result.sequence).toBe(4);
      if (phase === "prepared") expected.set(consistency, result);
      else {
        const oracle = expected.get(consistency);
        if (oracle === undefined) throw new Error("Missing prepared query oracle");
        expect(result).toEqual(oracle);
      }
    }
    const response = await request(worker, namespace, "metadata");
    expect(response.status).toBe(200);
    const metadata = Schema.decodeUnknownSync(Metadata)(await response.json());
    if (phase === "prepared") {
      expect(metadata.cache.directoryR2CacheHits).toBeGreaterThanOrEqual(4);
      expect(metadata.cache.directoryR2CacheOriginResponses).toBe(0);
      expect(metadata.cache.encodedDirectoryCacheEntries).toBeGreaterThanOrEqual(4);
    } else {
      expect(metadata.cache.directoryR2CacheReads).toBeGreaterThanOrEqual(4);
      for (const segment of root.segments) {
        const repaired = await bucket.get(
          `cache/directory-v5/${segment.key}/${segment.headerBytes}`,
        );
        expect(repaired).not.toBeNull();
        if (repaired === null) throw new Error("Missing recovered directory frame");
        expect(repaired.size).toBeGreaterThan(3);
      }
    }
    if (phase === "corrupt")
      expect(metadata.cache.directoryR2CacheRejected).toBeGreaterThanOrEqual(4);
  }
});

test("filtered cold seed reads the prepared R2 directory without a segment origin", async () => {
  await using cleanup = new AsyncDisposableStack();
  const persistence = await mkdtemp(join(tmpdir(), "kannin-filtered-directory-"));
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const namespace = "filtered-directory";
  {
    const writer = await startWorker(persistence);
    await using lifetime = new AsyncDisposableStack();
    lifetime.defer(() => writer.dispose());
    for (const batch of Array.from({ length: 8 }, (_, index) => index)) {
      const documents = Array.from({ length: 32 }, (_, offset) =>
        document(String(batch * 32 + offset).padStart(3, "0"), "rust cloudflare", {
          group: offset % 2,
        }),
      );
      expect((await request(writer, namespace, "write", write(documents))).status).toBe(200);
    }
    const bucket = await writer.getR2Bucket("STORAGE");
    const object = await bucket.get(`namespaces/${namespace}/root.json`);
    if (object === null) throw new Error("Missing filtered Root");
    const root = decodeRoot(await object.text());
    expect(root.segments).toHaveLength(8);
    for (const segment of root.segments) {
      const source = await bucket.get(segment.key);
      if (source === null) throw new Error("Missing filtered segment");
      const bytes = new Uint8Array(await source.arrayBuffer());
      await bucket.put(
        `cache/directory-v5/${segment.key}/${segment.headerBytes}`,
        new Uint8Array(directory_compress(bytes.subarray(0, segment.headerBytes))),
        {
          customMetadata: {
            source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
              key: segment.key,
              headerBytes: segment.headerBytes,
            }),
          },
        },
      );
    }
  }
  const isolated = await mkdtemp(join(tmpdir(), "kannin-filtered-directory-reader-"));
  cleanup.defer(() => rm(isolated, { recursive: true, force: true }));
  await symlink(join(persistence, "r2"), join(isolated, "r2"), "dir");
  const reader = await startWorker(isolated);
  cleanup.defer(() => reader.dispose());
  for (const phase of ["cold", "warm"]) {
    const response = await request(reader, namespace, "query", {
      ...textQuery("rust cloudflare", 1, [{ field: "group", op: "eq", value: 1 }]),
      minimumSequence: 8,
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.rows.map((row) => row.id)).toEqual(["001"]);
    expect(result.sequence).toBe(8);
    const timing = response.headers.get("server-timing") ?? "";
    if (phase === "cold") {
      expect(timing).toContain('text_plan;desc="miss"');
      expect(timing).toMatch(/text_score;dur=[^,]*;desc="segments=1"/);
    }
  }
  const response = await request(reader, namespace, "metadata");
  expect(response.status).toBe(200);
  const metadata = Schema.decodeUnknownSync(Metadata)(await response.json());
  expect(metadata.cache.directoryR2CacheHits).toBeGreaterThanOrEqual(1);
  expect(metadata.cache.directoryR2CacheOriginResponses).toBe(0);
});
