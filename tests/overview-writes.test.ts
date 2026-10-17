import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Root, QueryResult, StoredOverviewBatch } from "../src/protocol";
import { initSync, unpack } from "../dist/wasm/raio_engine";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});

for (const sample of [
  { operation: "write", count: 8 },
  { operation: "compact", count: 15 },
] as const) {
  test(`${sample.operation} prepares an immutable overview batch before its first query`, async () => {
    const persistence = await mkdtemp(join(tmpdir(), "kannin-write-overviews-"));
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
    const worker = await startWorker(persistence);
    const namespace = `write-overviews-${sample.operation}`;
    const reference = await (async () => {
      await using initial = new AsyncDisposableStack();
      initial.defer(() => worker.dispose());
      for (const index of Array.from({ length: sample.count }, (_, value) => value))
        expect(
          (
            await request(
              worker,
              namespace,
              "write",
              write([document(String(index), `alpha unique${index}`)]),
            )
          ).status,
        ).toBe(200);
      if (sample.operation === "compact")
        expect((await request(worker, namespace, "compact", {})).status).toBe(200);
      const bucket = await worker.getR2Bucket("STORAGE");
      const manifest = await bucket.get(`namespaces/${namespace}/root.json`);
      if (manifest === null) throw new Error("Missing canonical manifest");
      const encodedRoot = await manifest.text();
      const root = Schema.decodeSync(Schema.fromJsonString(Root))(encodedRoot);
      const source = root.segments[0];
      if (source === undefined) throw new Error("Missing committed segment");
      const found: { key: string | undefined } = { key: undefined };
      for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
        const objects = await bucket.list({
          prefix: `cache/correlated-pool-batches-v1/${source.key}/`,
        });
        found.key = objects.objects[0]?.key;
        if (found.key !== undefined || attempt === 99) break;
        await Effect.runPromise(Effect.sleep("10 millis"));
      }
      expect(found.key).toBeDefined();
      if (found.key === undefined) throw new Error("Missing prepared batch");
      const stored = await bucket.get(found.key);
      if (stored === null) throw new Error("Missing prepared frame");
      const encoded = unpack(new Uint8Array(await stored.arrayBuffer()));
      const batch = Schema.decodeSync(Schema.fromJsonString(StoredOverviewBatch))(encoded);
      expect(batch.ranges).toEqual(
        root.segments.map((segment) => ({ key: segment.key, headerBytes: segment.headerBytes })),
      );
      expect(batch.overviews).toHaveLength(8);
      expect(stored.customMetadata?.rawBytes).toBe(
        String(new TextEncoder().encode(encoded).byteLength),
      );
      const response = await request(worker, namespace, "query", textQuery("alpha"));
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.sequence).toBe(sample.count);
      expect(result.rows.map((row) => row.id)).toEqual(
        Array.from({ length: sample.count }, (_, index) => String(index))
          .toSorted()
          .slice(0, 10),
      );
      return { result, encodedRoot };
    })();
    const restartedPersistence = await mkdtemp(join(tmpdir(), "kannin-cold-overviews-"));
    cleanup.defer(() => rm(restartedPersistence, { recursive: true, force: true }));
    await symlink(join(persistence, "r2"), join(restartedPersistence, "r2"), "dir");
    const restarted = await startWorker(restartedPersistence);
    cleanup.defer(() => restarted.dispose());
    const response = await request(restarted, namespace, "query", textQuery("alpha"));
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference.result);
    expect(response.headers.get("server-timing")).toContain('desc="reads=1 hits=1');
    expect(response.headers.get("server-timing")).toContain("reads=0 hits=0 bytes=0 batch_peak=0");
    const object = await (
      await restarted.getR2Bucket("STORAGE")
    ).get(`namespaces/${namespace}/root.json`);
    expect(await object?.text()).toBe(reference.encodedRoot);
    if (sample.operation === "write") {
      expect((await request(restarted, namespace, "write", write([], ["0"]))).status).toBe(200);
      const removed = await request(restarted, namespace, "query", textQuery("alpha"));
      expect(removed.status).toBe(200);
      const surviving = Schema.decodeUnknownSync(QueryResult)(await removed.json());
      expect(surviving.sequence).toBe(9);
      expect(surviving.rows.map((row) => row.id)).toEqual(
        Array.from({ length: 7 }, (_, index) => String(index + 1)),
      );
      expect(
        (await request(restarted, namespace, "write", { ...write([]), reset: true })).status,
      ).toBe(200);
      const reset = await request(restarted, namespace, "query", textQuery("alpha"));
      expect(reset.status).toBe(200);
      const empty = Schema.decodeUnknownSync(QueryResult)(await reset.json());
      expect(empty.sequence).toBe(10);
      expect(empty.rows).toEqual([]);
    }
  }, 15000);
}
