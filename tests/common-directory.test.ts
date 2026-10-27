import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Directory, common_directory_compress, initSync } from "../dist/wasm/raio_engine";
import { decodeRoot } from "../src/manifest";
import { Metadata, QueryResult, TermProjectionRange } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("first covered reads do not reserve compressed cache memory", async () => {
  await using cleanup = new AsyncDisposableStack();
  const worker = await startWorker();
  cleanup.defer(() => worker.dispose());
  const namespace = "common-first-admission";
  const written = await request(
    worker,
    namespace,
    "write",
    write(
      Array.from({ length: 96 }, (_, row) =>
        document(String(row).padStart(3, "0"), "rust cloudflare rust"),
      ),
    ),
  );
  expect(written.status).toBe(200);
  const previousResponse = await request(worker, namespace, "metadata");
  const previous = Schema.decodeUnknownSync(Metadata)(await previousResponse.json());
  const response = await request(worker, namespace, "query", {
    ...textQuery("rust cloudflare rust"),
    match: "phrase",
    minimumSequence: 1,
  });
  expect(response.status).toBe(200);
  const metadataResponse = await request(worker, namespace, "metadata");
  const metadata = Schema.decodeUnknownSync(Metadata)(await metadataResponse.json());
  expect(metadata.cache.directoryCommonHits).toBeGreaterThan(previous.cache.directoryCommonHits);
  expect(
    metadata.cache.encodedDirectoryCacheChargedBytes -
      metadata.cache.encodedDirectoryAdmissionChargedBytes,
  ).toBe(
    previous.cache.encodedDirectoryCacheChargedBytes -
      previous.cache.encodedDirectoryAdmissionChargedBytes,
  );
  expect(metadata.cache.encodedDirectoryCacheEntries).toBe(
    previous.cache.encodedDirectoryCacheEntries,
  );
});

test("segments without common terms publish only useful directory caches", async () => {
  await using cleanup = new AsyncDisposableStack();
  const worker = await startWorker();
  cleanup.defer(() => worker.dispose());
  const namespace = "no-common-terms";
  const response = await request(
    worker,
    namespace,
    "write",
    write([document("0", "uniquealpha", { group: 0 }), document("1", "uniquebeta", { group: 1 })]),
  );
  expect(response.status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const stored = await bucket.get(`namespaces/${namespace}/root.json`);
  if (stored === null) throw new Error("Missing no-common Root");
  const segment = decodeRoot(await stored.text()).segments[0];
  if (segment === undefined) throw new Error("Missing no-common segment");
  expect(
    await bucket.head(`cache/directory-v5/${segment.key}/${segment.headerBytes}`),
  ).not.toBeNull();
  expect(
    await bucket.head(`cache/directory-common-v3/${segment.key}/${segment.headerBytes}`),
  ).toBeNull();
  expect(await bucket.head(`cache/correlated-pool-v3/${segment.key}`)).not.toBeNull();
  const query = await request(worker, namespace, "query", textQuery("uniquealpha"));
  expect(query.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await query.json()).rows.map((row) => row.id),
  ).toEqual(["0"]);
});

test("common positional directories preserve cold and warm results through eviction and repair", async () => {
  await using cleanup = new AsyncDisposableStack();
  const persistence = await mkdtemp(join(tmpdir(), "kannin-common-directories-"));
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const namespace = "common-directories";
  {
    await using lifetime = new AsyncDisposableStack();
    const writer = await startWorker(persistence);
    lifetime.defer(() => writer.dispose());
    for (const batch of [0, 1]) {
      const documents = Array.from({ length: 96 }, (_, offset) => {
        const index = batch * 96 + offset;
        return document(
          String(index).padStart(3, "0"),
          `${"rust cloudflare rust ".repeat(1 + (index % 3))}unique${index}`,
          { group: index % 3 },
        );
      });
      expect((await request(writer, namespace, "write", write(documents))).status).toBe(200);
    }
  }
  const golden = new Map<string, typeof QueryResult.Type>();
  for (const phase of ["missing", "repaired", "corrupt", "prepared"]) {
    await using lifetime = new AsyncDisposableStack();
    const isolated = await mkdtemp(join(tmpdir(), "kannin-common-reader-"));
    lifetime.defer(() => rm(isolated, { recursive: true, force: true }));
    await symlink(join(persistence, "r2"), join(isolated, "r2"), "dir");
    const reader = await startWorker(isolated);
    lifetime.defer(() => reader.dispose());
    const bucket = await reader.getR2Bucket("STORAGE");
    const stored = await bucket.get(`namespaces/${namespace}/root.json`);
    if (stored === null) throw new Error("Missing common-directory Root");
    const root = decodeRoot(await stored.text());
    expect(root.segments).toHaveLength(2);
    for (const segment of root.segments) {
      const key = `cache/directory-common-v3/${segment.key}/${segment.headerBytes}`;
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
      if (phase === "prepared") {
        const canonical = await bucket.get(segment.key);
        if (canonical === null) throw new Error("Missing common canonical segment");
        const bytes = new Uint8Array(await canonical.arrayBuffer());
        await bucket.put(
          key,
          new Uint8Array(common_directory_compress(bytes.subarray(0, segment.headerBytes))),
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
    const beforeResponse = await request(reader, namespace, "metadata");
    expect(beforeResponse.status).toBe(200);
    const before = Schema.decodeUnknownSync(Metadata)(await beforeResponse.json());
    for (const temperature of ["cold", "warm"]) {
      const response = await request(reader, namespace, "query", {
        ...textQuery("rust cloudflare rust", 20, [{ field: "group", op: "eq", value: 1 }]),
        match: "phrase",
        minimumSequence: 2,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.rows).toHaveLength(20);
      expect(result.rows.every((row) => row.attributes.group === 1)).toBe(true);
      const expected = golden.get("covered-phrase");
      if (expected === undefined) golden.set("covered-phrase", result);
      else expect(result).toEqual(expected);
      if (temperature === "cold" && (phase === "prepared" || phase === "repaired")) {
        for (const segment of root.segments)
          await bucket.delete(`cache/directory-common-v3/${segment.key}/${segment.headerBytes}`);
      }
    }
    const phraseResponse = await request(reader, namespace, "metadata");
    const phraseMetadata = Schema.decodeUnknownSync(Metadata)(await phraseResponse.json());
    if (phase === "prepared" || phase === "repaired")
      expect(
        phraseMetadata.cache.directoryCommonHits - before.cache.directoryCommonHits,
      ).toBeGreaterThan(0);
    else {
      expect(phraseMetadata.cache.directoryCommonHits - before.cache.directoryCommonHits).toBe(0);
      for (const segment of root.segments) {
        const key = `cache/directory-common-v3/${segment.key}/${segment.headerBytes}`;
        if (phase === "corrupt") {
          const preserved = await bucket.get(key);
          if (preserved === null) throw new Error("Missing preserved corrupt frame");
          expect(new Uint8Array(await preserved.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
          continue;
        }
        for (const attempt of Array.from({ length: 40 }, (_, index) => index)) {
          const repaired = await bucket.get(key);
          if (repaired !== null && repaired.size > 20) break;
          if (attempt === 39) throw new Error("Common directory repair did not settle");
          await Effect.runPromise(Effect.sleep("25 millis"));
        }
        const repaired = await bucket.get(key);
        if (repaired === null) throw new Error("Missing repaired common directory");
        using directory = Directory.common(
          new Uint8Array(await repaired.arrayBuffer()),
          segment.headerBytes,
          40 * 1024 * 1024,
        );
        expect(directory.heap_bytes()).toBeGreaterThan(0);
      }
    }
    for (const match of ["any", "all", "phrase"] as const) {
      const response = await request(reader, namespace, "query", {
        ...textQuery("rust unique1", 20),
        match,
        minimumSequence: 2,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      const expected = golden.get(`mixed-${match}`);
      if (expected === undefined) golden.set(`mixed-${match}`, result);
      else expect(result).toEqual(expected);
    }
    const afterResponse = await request(reader, namespace, "metadata");
    const after = Schema.decodeUnknownSync(Metadata)(await afterResponse.json());
    expect(after.cache.directoryCommonHits).toBe(phraseMetadata.cache.directoryCommonHits);
    expect(after.cache.directoryCacheChargedBytes).toBeLessThanOrEqual(29 * 1024 * 1024);
    if (phase === "corrupt")
      expect(after.cache.directoryR2CacheRejected).toBeGreaterThan(
        before.cache.directoryR2CacheRejected,
      );
  }
}, 30000);

test("projected and full directories share decoded admission and recover an evicted projection", async () => {
  await using cleanup = new AsyncDisposableStack();
  const persistence = await mkdtemp(join(tmpdir(), "kannin-common-pressure-"));
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const namespace = "common-pressure";
  const groups = Array.from({ length: 32 }, (_, index) => index);
  {
    await using lifetime = new AsyncDisposableStack();
    const writer = await startWorker(persistence);
    lifetime.defer(() => writer.dispose());
    for (const group of groups) {
      const documents = Array.from({ length: 1000 }, (_, row) =>
        document(
          `${String(group).padStart(2, "0")}-${String(row).padStart(4, "0")}`,
          `rust cloudflare rust unique${group}x${row}`,
          { group, note: `${row}:${"x".repeat(1000)}` },
        ),
      );
      expect((await request(writer, namespace, "write", write(documents))).status).toBe(200);
    }
  }
  const isolated = await mkdtemp(join(tmpdir(), "kannin-common-pressure-reader-"));
  cleanup.defer(() => rm(isolated, { recursive: true, force: true }));
  await symlink(join(persistence, "r2"), join(isolated, "r2"), "dir");
  const reader = await startWorker(isolated);
  cleanup.defer(() => reader.dispose());
  const bucket = await reader.getR2Bucket("STORAGE");
  const stored = await bucket.get(`namespaces/${namespace}/root.json`);
  if (stored === null) throw new Error("Missing pressure-test Root");
  const root = decodeRoot(await stored.text());
  expect(root.segments).toHaveLength(groups.length);
  const footprint = { bytes: 0 };
  for (const segment of root.segments) {
    expect(segment.headerBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    const canonical = await bucket.get(segment.key);
    if (canonical === null) throw new Error("Missing pressure-test segment");
    const bytes = new Uint8Array(await canonical.arrayBuffer());
    const frame = new Uint8Array(common_directory_compress(bytes.subarray(0, segment.headerBytes)));
    using projected = Directory.common(frame, segment.headerBytes, 40 * 1024 * 1024);
    footprint.bytes += projected.heap_bytes();
    await bucket.put(`cache/directory-common-v3/${segment.key}/${segment.headerBytes}`, frame, {
      customMetadata: {
        source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
          key: segment.key,
          headerBytes: segment.headerBytes,
        }),
      },
    });
  }
  expect(footprint.bytes).toBeGreaterThan(29 * 1024 * 1024);
  const oracle = new Map<number, typeof QueryResult.Type>();
  for (const group of [...groups, 31, 31, 31]) {
    const response = await request(reader, namespace, "query", {
      ...textQuery("rust cloudflare rust", 10, [{ field: "group", op: "eq", value: group }]),
      match: "phrase",
      minimumSequence: groups.length,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.rows).toHaveLength(10);
    expect(result.rows.every((row) => row.attributes.group === group)).toBe(true);
    const expected = oracle.get(group);
    if (expected === undefined) oracle.set(group, result);
    else expect(result).toEqual(expected);
    const metadataResponse = await request(reader, namespace, "metadata");
    const metadata = Schema.decodeUnknownSync(Metadata)(await metadataResponse.json());
    expect(metadata.cache.directoryCacheChargedBytes).toBeLessThanOrEqual(29 * 1024 * 1024);
  }
  const beforeResponse = await request(reader, namespace, "metadata");
  const before = Schema.decodeUnknownSync(Metadata)(await beforeResponse.json());
  expect(before.cache.directoryCommonHits).toBeGreaterThanOrEqual(groups.length);
  const response = await request(reader, namespace, "query", {
    ...textQuery("rust cloudflare rust", 10, [{ field: "group", op: "eq", value: 0 }]),
    match: "phrase",
    minimumSequence: groups.length,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const expected = oracle.get(0);
  if (expected === undefined) throw new Error("Missing pressure-test oracle");
  expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(expected);
  const recoveredResponse = await request(reader, namespace, "metadata");
  const recovered = Schema.decodeUnknownSync(Metadata)(await recoveredResponse.json());
  expect(recovered.cache.directoryR2CacheReads).toBe(before.cache.directoryR2CacheReads + 1);
  const reusedResponse = await request(reader, namespace, "query", {
    ...textQuery("rust cloudflare rust", 10, [{ field: "group", op: "eq", value: 0 }]),
    match: "phrase",
    minimumSequence: groups.length,
  });
  expect(reusedResponse.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await reusedResponse.json())).toEqual(expected);
  const reusedMetadata = await request(reader, namespace, "metadata");
  const reused = Schema.decodeUnknownSync(Metadata)(await reusedMetadata.json());
  expect(reused.cache.directoryR2CacheReads).toBe(recovered.cache.directoryR2CacheReads);
  expect(reused.cache.encodedDirectoryCacheHits).toBeGreaterThan(
    recovered.cache.encodedDirectoryCacheHits,
  );
  expect(
    recovered.cache.encodedDirectoryCacheChargedBytes -
      recovered.cache.encodedDirectoryAdmissionChargedBytes,
  ).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(recovered.cache.encodedDirectoryAdmissionChargedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(recovered.cache.directoryCommonHits).toBeGreaterThan(before.cache.directoryCommonHits);
  for (const match of ["all", "phrase"] as const) {
    const mixed = await request(reader, namespace, "query", {
      ...textQuery("rust unique0x1", 10, [{ field: "group", op: "eq", value: 0 }]),
      match,
      minimumSequence: groups.length,
    });
    expect(mixed.status, await mixed.clone().text()).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await mixed.json());
    expect(result.rows.map((row) => row.id)).toEqual(["00-0001"]);
  }
  const mixedResponse = await request(reader, namespace, "metadata");
  const mixed = Schema.decodeUnknownSync(Metadata)(await mixedResponse.json());
  expect(mixed.cache.directoryCommonHits).toBe(reused.cache.directoryCommonHits);
  expect(mixed.cache.directoryCacheChargedBytes).toBeLessThanOrEqual(29 * 1024 * 1024);
}, 120000);
