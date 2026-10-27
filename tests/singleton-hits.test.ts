import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metadata, QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

for (const state of ["present", "missing", "corrupt"] as const)
  test(`singleton ranking survives restart with ${state} derived proof`, async () => {
    const persistence = await mkdtemp(join(tmpdir(), "kannin-singletons-"));
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
    const namespace = `singletons-${state}`;
    {
      await using lifetime = new AsyncDisposableStack();
      const writer = await startWorker(persistence);
      lifetime.defer(() => writer.dispose());
      expect(
        (
          await request(
            writer,
            namespace,
            "write",
            write([
              document("a", "rare common", { group: 1 }),
              document("b", "unique common", { group: 1 }),
              document("c", "third common", { group: 1 }),
            ]),
          )
        ).status,
      ).toBe(200);
      const bucket = await writer.getR2Bucket("STORAGE");
      const objects = await bucket.list({
        prefix: `cache/correlated-pool-v3/namespaces/${namespace}/`,
      });
      expect(objects.objects).toHaveLength(1);
      for (const object of objects.objects) {
        if (state === "missing") await bucket.delete(object.key);
        if (state === "corrupt") await bucket.put(object.key, "corrupt derived overview");
      }
    }
    const worker = await startWorker(persistence);
    cleanup.defer(() => worker.dispose());
    const input = { ...textQuery("rare"), minimumSequence: 1 };
    const response = await request(worker, namespace, "query", input);
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
    const metadata = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    if (state === "present") {
      expect(response.headers.get("server-timing")).toContain(
        'text_singleton_hits;desc="segments=1"',
      );
      expect(metadata.cache.directoryR2CacheReads).toBe(0);
    } else {
      expect(response.headers.get("server-timing")).toContain(
        'text_singleton_hits;desc="segments=0"',
      );
      expect(metadata.cache.directoryR2CacheReads).toBeGreaterThan(0);
    }
    for (const match of ["any", "all", "phrase"] as const) {
      const filtered = await request(worker, namespace, "query", {
        ...input,
        match,
        filters: [{ field: "group", op: "eq", value: 1 }],
      });
      expect(filtered.status).toBe(200);
      expect(Schema.decodeUnknownSync(QueryResult)(await filtered.json())).toEqual(result);
    }
    const repeated = await request(worker, namespace, "query", {
      ...input,
      text: "rare rare",
      match: "phrase",
    });
    expect(repeated.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await repeated.json()).rows).toEqual([]);
    expect(repeated.headers.get("server-timing")).toContain(
      'text_singleton_hits;desc="segments=0"',
    );
    expect((await request(worker, namespace, "write", write([], ["a"]))).status).toBe(200);
    const deleted = await request(worker, namespace, "query", { ...input, minimumSequence: 2 });
    expect(deleted.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await deleted.json()).rows).toEqual([]);
  });
