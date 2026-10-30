import { decodeRoot, encodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Response } from "miniflare";
import { Clock, Effect, Schema } from "effect";
import { Health, QueryResult, SnapshotCacheHeaders, WriteResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

import { snapshotFrame, readSnapshotFrame } from "../src/snapshot";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("overlapping cold snapshots share R2 acquisition and check sequence barriers independently", async () => {
  const namespace = "cold-snapshot-sharing";
  await request(worker, namespace, "write", write([document("a", "shared snapshot")]));
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      request(worker, namespace, "query", {
        ...textQuery("shared"),
        consistency: "edge-eventual",
        minimumSequence: 1 + (index % 2),
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    if (index % 2 === 1) {
      expect(response.status).toBe(409);
      continue;
    }
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.sequence).toBe(1);
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  }
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.snapshotR2Reads - before.snapshotR2Reads).toBeLessThan(responses.length);
  expect(after.snapshotSharedReads - before.snapshotSharedReads).toBeGreaterThan(0);
  expect(
    responses.some((response) =>
      /edge_snapshot_cache;dur=\d/.test(response.headers.get("server-timing") ?? ""),
    ),
  ).toBe(true);
});

test("failed shared snapshot acquisitions release their entry and allow canonical recovery", async () => {
  const namespace = "snapshot-sharing-recovery";
  await request(worker, namespace, "write", write([document("a", "recovered snapshot")]));
  const bucket = await worker.getR2Bucket("STORAGE");
  const key = `namespaces/${namespace}/root.json`;
  const object = await bucket.get(key);
  if (object === null) throw new Error("Missing canonical manifest");
  const canonical = await object.text();
  await bucket.put(key, "corrupted canonical manifest");
  const input = { ...textQuery("recovered"), consistency: "edge-eventual", minimumSequence: 1 };
  const failures = await Promise.all(
    Array.from({ length: 6 }, () => request(worker, namespace, "query", input)),
  );
  for (const response of failures) expect(response.status).toBe(503);
  await bucket.put(key, canonical);
  const response = await request(worker, namespace, "query", input);
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.sequence).toBe(1);
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
});

test("R2 snapshot frames retain validated original UTF-8 bytes without reserialization", async () => {
  const namespace = "original-root-bytes";
  await request(
    worker,
    namespace,
    "write",
    write([document("café-日本語", "original café 日本語")]),
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootKey = `namespaces/${namespace}/root.json`;
  const object = await bucket.get(rootKey);
  if (object === null) throw new Error("Missing canonical manifest");
  const manifest = decodeRoot(await object.text());
  const payload = `\n${encodeRoot(manifest)}\n`;
  await bucket.put(rootKey, payload);
  const response = await request(worker, namespace, "query", {
    ...textQuery("café 日本語"),
    consistency: "edge-eventual",
    minimumSequence: 1,
  });
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.rows.map((row) => row.id)).toEqual(["café-日本語"]);
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  const key = `https://raio-cache.internal/snapshots-v8/${namespace}?bucket=raio-test`;
  const cached = await cache.match(key);
  if (cached === undefined) throw new Error("Missing snapshot frame");
  const decoded = await Effect.runPromise(readSnapshotFrame(await cached.arrayBuffer()));
  expect(new TextDecoder().decode(decoded.payload)).toBe(payload);
  expect(decoded.snapshot.manifest).toEqual(manifest);
});

async function seedSnapshot(namespace: string, observedAt: number, advertisedAt = observedAt) {
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing manifest");
  const manifest = decodeRoot(await object.text());
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  const key = new URL(`https://raio-cache.internal/snapshots-v8/${namespace}`);
  key.searchParams.set("bucket", "raio-test");
  await cache.put(
    key,
    new Response(
      await snapshotFrame(
        { observedAt, manifest },
        new TextEncoder().encode(encodeRoot(manifest)),
      ).arrayBuffer(),
      {
        headers: {
          "cache-control": "public, max-age=60",
          "content-type": "application/octet-stream",
          ...Schema.encodeSync(SnapshotCacheHeaders)({
            "x-raio-observed-at": advertisedAt,
            "x-raio-sequence": manifest.sequence,
          }),
        },
      },
    ),
  );
}

test("malformed binary cache frames recover through canonical R2", async () => {
  const namespace = "broken-binary-cache";
  await request(worker, namespace, "write", write([document("a", "canonical text")]));
  await seedSnapshot(namespace, Effect.runSync(Clock.currentTimeMillis));
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  const key = new URL(`https://raio-cache.internal/snapshots-v8/${namespace}?bucket=raio-test`);
  const cached = await cache.match(key);
  if (cached === undefined) throw new Error("Missing seeded snapshot");
  const bytes = new Uint8Array(await cached.arrayBuffer());
  bytes[0] = 0;
  await cache.put(key, new Response(bytes, { headers: cached.headers }));
  const response = await request(worker, namespace, "query", {
    ...textQuery("canonical"),
    consistency: "edge-eventual",
    minimumSequence: 1,
  });
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.sequence).toBe(1);
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
});

test("strong is the default and edge reads evaluate the same BM25 snapshot", async () => {
  await request(
    worker,
    "edge-ranking",
    "write",
    write([document("a", "cloudflare cloudflare rust"), document("b", "cloudflare storage")]),
  );
  const strong = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "edge-ranking", "query", textQuery("cloudflare"))).json(),
  );
  const edge = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "edge-ranking", "query", {
        ...textQuery("cloudflare"),
        consistency: "edge-eventual",
      })
    ).json(),
  );
  expect(strong.consistency).toBe("strong");
  expect(edge.consistency).toBe("edge-eventual");
  expect(edge.rows).toEqual(strong.rows);
  expect(edge.sequence).toBe(strong.sequence);
});

test("identical cache rehydration preserves R2 conditional-read provenance", async () => {
  const namespace = "cache-etag-identity";
  await request(worker, namespace, "write", write([document("a", "same payload")]));
  const input = { ...textQuery("payload"), consistency: "edge-eventual", minimumSequence: 1 };
  expect((await request(worker, namespace, "query", input)).status).toBe(200);
  const object = await (
    await worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing canonical manifest");
  const payload = new Uint8Array(await object.arrayBuffer());
  const manifest = decodeRoot(new TextDecoder().decode(payload));
  await Effect.runPromise(Effect.sleep(1100));
  const observedAt = Effect.runSync(Clock.currentTimeMillis);
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  await cache.put(
    `https://raio-cache.internal/snapshots-v8/${namespace}?bucket=raio-test`,
    new Response(await snapshotFrame({ observedAt, manifest }, payload).arrayBuffer(), {
      headers: {
        "cache-control": "public, max-age=60",
        ...Schema.encodeSync(SnapshotCacheHeaders)({
          "x-raio-observed-at": observedAt,
          "x-raio-sequence": manifest.sequence,
        }),
      },
    }),
  );
  expect((await request(worker, namespace, "query", input)).status).toBe(200);
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const response = await request(worker, namespace, "query", { ...input, minimumSequence: 2 });
  expect(response.status).toBe(409);
  expect(response.headers.get("server-timing")).toContain("edge_snapshot_revalidated");
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.snapshotRevalidations - before.snapshotRevalidations).toBe(1);
  expect(after.snapshotR2BodyBytes - before.snapshotR2BodyBytes).toBe(0);
});

test("same-sequence cache bodies with different bytes discard R2 provenance", async () => {
  for (const kind of ["same-length", "different-length"]) {
    const namespace = `cache-etag-${kind}`;
    await request(worker, namespace, "write", write([document("a", "original payload")]));
    const input = { ...textQuery("payload"), consistency: "edge-eventual", minimumSequence: 1 };
    expect((await request(worker, namespace, "query", input)).status).toBe(200);
    const object = await (
      await worker.getR2Bucket("STORAGE")
    ).get(`namespaces/${namespace}/root.json`);
    if (object === null) throw new Error("Missing canonical manifest");
    const original = await object.text();
    const manifest = decodeRoot(original);
    const changed = { manifest, text: `\n${original}\n` };
    if (kind === "same-length") {
      changed.manifest = {
        ...manifest,
        vectorEpoch: `${manifest.vectorEpoch.slice(0, 14)}${((Number.parseInt(manifest.vectorEpoch.slice(14, 15), 16) + 1) % 16).toString(16)}${manifest.vectorEpoch.slice(15)}`,
      };
      expect(changed.manifest.vectorEpoch).not.toBe(manifest.vectorEpoch);
      changed.text = encodeRoot(changed.manifest);
      expect(changed.text.length).toBe(original.length);
    }
    await Effect.runPromise(Effect.sleep(1100));
    const observedAt = Effect.runSync(Clock.currentTimeMillis);
    const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
    await cache.put(
      `https://raio-cache.internal/snapshots-v8/${namespace}?bucket=raio-test`,
      new Response(
        await snapshotFrame(
          { observedAt, manifest: changed.manifest },
          new TextEncoder().encode(changed.text),
        ).arrayBuffer(),
        {
          headers: {
            "cache-control": "public, max-age=60",
            ...Schema.encodeSync(SnapshotCacheHeaders)({
              "x-raio-observed-at": observedAt,
              "x-raio-sequence": manifest.sequence,
            }),
          },
        },
      ),
    );
    expect((await request(worker, namespace, "query", input)).status).toBe(200);
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const response = await request(worker, namespace, "query", { ...input, minimumSequence: 2 });
    expect(response.status).toBe(409);
    expect(response.headers.get("server-timing")).not.toContain("edge_snapshot_revalidated");
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    expect(after.snapshotRevalidations - before.snapshotRevalidations).toBe(0);
    expect(after.snapshotR2BodyBytes - before.snapshotR2BodyBytes).toBeGreaterThan(0);
  }
});

test("recent unchanged snapshot publications coalesce without hiding changes or cache eviction", async () => {
  const namespace = "publication-interval";
  await request(worker, namespace, "write", write([document("a", "original content")]));
  const input = { ...textQuery("original"), consistency: "edge-eventual", minimumSequence: 1 };
  expect((await request(worker, namespace, "query", input)).status).toBe(200);
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  for (const _iteration of Array.from({ length: 8 }, (_, index) => index))
    expect(
      (await request(worker, namespace, "query", { ...input, minimumSequence: 2 })).status,
    ).toBe(409);
  const grouped = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(grouped.snapshotRevalidations - before.snapshotRevalidations).toBe(8);
  expect(grouped.snapshotR2BodyBytes - before.snapshotR2BodyBytes).toBe(0);
  expect(grouped.snapshotCachePutAttempts - before.snapshotCachePutAttempts).toBeLessThan(8);
  expect(grouped.snapshotCachePutSkipped - before.snapshotCachePutSkipped).toBeGreaterThan(0);
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  const key = `https://raio-cache.internal/snapshots-v8/${namespace}?bucket=raio-test`;
  await cache.delete(key);
  expect((await request(worker, namespace, "query", input)).status).toBe(200);
  await Effect.runPromise(Effect.sleep(550));
  expect((await request(worker, namespace, "query", { ...input, minimumSequence: 2 })).status).toBe(
    409,
  );
  const restored = await cache.match(key);
  if (restored === undefined) throw new Error("Missing republished snapshot");
  expect(
    Effect.runSync(readSnapshotFrame(await restored.arrayBuffer())).snapshot.manifest.sequence,
  ).toBe(1);
  await request(worker, namespace, "write", write([document("a", "changed content")]));
  const changed = await request(worker, namespace, "query", {
    ...textQuery("changed"),
    consistency: "edge-eventual",
    minimumSequence: 2,
  });
  expect(changed.status).toBe(200);
  const published = await cache.match(key);
  if (published === undefined) throw new Error("Missing changed snapshot");
  expect(
    Effect.runSync(readSnapshotFrame(await published.arrayBuffer())).snapshot.manifest.sequence,
  ).toBe(2);
});

test("expired warm snapshots revalidate unchanged R2 content without transferring its body", async () => {
  const namespace = "etag-unchanged";
  await request(worker, namespace, "write", write([document("a", "unchanged content")]));
  const input = { ...textQuery("unchanged"), consistency: "edge-eventual", minimumSequence: 1 };
  expect((await request(worker, namespace, "query", input)).status).toBe(200);
  await Effect.runPromise(Effect.sleep(1100));
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  await cache.delete(`https://raio-cache.internal/snapshots-v8/${namespace}?bucket=raio-test`);
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const response = await request(worker, namespace, "query", input);
  expect(response.status).toBe(200);
  expect(response.headers.get("server-timing")).toContain("edge_snapshot_revalidated");
  expect(response.headers.get("server-timing")).toMatch(/edge_snapshot_r2;dur=\d/);
  expect(response.headers.get("server-timing")).toMatch(/edge_snapshot_body;dur=\d/);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.sequence).toBe(1);
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.snapshotRevalidations - before.snapshotRevalidations).toBe(1);
  expect(after.snapshotR2BodyBytes - before.snapshotR2BodyBytes).toBe(0);
  expect(after.snapshotMemoryChargedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  expect(after.snapshotPayloadRetainedBytes).toBeGreaterThan(0);
  expect(after.snapshotPayloadRetainedBytes).toBeLessThanOrEqual(
    after.snapshotMemoryChargedBytes / 4,
  );
  const future = await request(worker, namespace, "query", { ...input, minimumSequence: 2 });
  expect(future.status).toBe(409);
  expect(future.headers.get("server-timing")).toContain("edge_snapshot_revalidated");
  expect(future.headers.get("server-timing")).toContain("edge_snapshot_fallback");
  await request(worker, namespace, "write", write([document("a", "changed content")]));
  const changedBefore = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const changedResponse = await request(worker, namespace, "query", {
    ...textQuery("changed"),
    consistency: "edge-eventual",
    minimumSequence: 2,
  });
  expect(changedResponse.status).toBe(200);
  const changed = Schema.decodeUnknownSync(QueryResult)(await changedResponse.json());
  expect(changed.sequence).toBe(2);
  expect(changed.rows.map((row) => row.id)).toEqual(["a"]);
  const changedAfter = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(changedAfter.snapshotRevalidations - changedBefore.snapshotRevalidations).toBe(0);
  expect(changedAfter.snapshotR2BodyBytes - changedBefore.snapshotR2BodyBytes).toBeGreaterThan(0);
  await request(worker, namespace, "write", write([], ["a"]));
  const deletedResponse = await request(worker, namespace, "query", {
    ...textQuery("changed"),
    consistency: "edge-eventual",
    minimumSequence: 3,
  });
  expect(deletedResponse.status).toBe(200);
  const deleted = Schema.decodeUnknownSync(QueryResult)(await deletedResponse.json());
  expect(deleted.sequence).toBe(3);
  expect(deleted.rows).toEqual([]);
});

test("minimumSequence bypasses a cached manifest after update and deletion", async () => {
  await request(worker, "edge-barrier", "write", write([document("a", "old text")]));
  await seedSnapshot("edge-barrier", Effect.runSync(Clock.currentTimeMillis));
  const updated = Schema.decodeUnknownSync(WriteResult)(
    await (
      await request(worker, "edge-barrier", "write", write([document("a", "new text")]))
    ).json(),
  );
  const strong = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "edge-barrier", "query", textQuery("old"))).json(),
  );
  expect(strong.rows).toEqual([]);
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const edge = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "edge-barrier", "query", {
        ...textQuery("new"),
        consistency: "edge-eventual",
        minimumSequence: updated.sequence,
      })
    ).json(),
  );
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.snapshotCacheDecodes - before.snapshotCacheDecodes).toBe(0);
  expect(after.snapshotCacheRejected - before.snapshotCacheRejected).toBe(1);
  expect(edge.sequence).toBe(updated.sequence);
  expect(edge.rows.map((row) => row.id)).toEqual(["a"]);
  const deleted = Schema.decodeUnknownSync(WriteResult)(
    await (await request(worker, "edge-barrier", "write", write([], ["a"]))).json(),
  );
  const afterDelete = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "edge-barrier", "query", {
        ...textQuery("new"),
        consistency: "edge-eventual",
        minimumSequence: deleted.sequence,
      })
    ).json(),
  );
  expect(afterDelete.rows).toEqual([]);
  expect(afterDelete.sequence).toBe(deleted.sequence);
});

test("an expired or future-dated snapshot is rejected even if Cache API retains it", async () => {
  for (const offset of [-2000, 60000]) {
    const namespace = `edge-time-${offset}`;
    await request(worker, namespace, "write", write([document("a", "old text")]));
    await seedSnapshot(namespace, Effect.runSync(Clock.currentTimeMillis) + offset);
    await request(worker, namespace, "write", write([document("a", "new text")]));
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const edge = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(worker, namespace, "query", {
          ...textQuery("new"),
          consistency: "edge-eventual",
        })
      ).json(),
    );
    expect(edge.rows.map((row) => row.id)).toEqual(["a"]);
    expect(edge.sequence).toBe(2);
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    expect(after.snapshotCacheDecodes - before.snapshotCacheDecodes).toBe(0);
    expect(after.snapshotCacheRejected - before.snapshotCacheRejected).toBe(1);
  }
});

test("overlapping cache snapshots decode one body and preserve future sequence barriers", async () => {
  const namespace = "shared-cache-snapshot";
  await request(worker, namespace, "write", write([document("a", "shared cache snapshot")]));
  await seedSnapshot(namespace, Effect.runSync(Clock.currentTimeMillis));
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const responses = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      request(worker, namespace, "query", {
        ...textQuery("shared"),
        consistency: "edge-eventual",
        minimumSequence: 1 + Number(index % 4 === 3),
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    if (index % 4 === 3) {
      expect(response.status).toBe(409);
      continue;
    }
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.sequence).toBe(1);
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  }
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.snapshotCacheDecodes - before.snapshotCacheDecodes).toBe(1);
});

test("fresh cache headers cannot make an expired snapshot body eligible", async () => {
  const namespace = "edge-header-body-age";
  await request(worker, namespace, "write", write([document("a", "old text")]));
  const now = Effect.runSync(Clock.currentTimeMillis);
  await seedSnapshot(namespace, now - 2000, now);
  await request(worker, namespace, "write", write([document("a", "new text")]));
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const response = await request(worker, namespace, "query", {
    ...textQuery("new"),
    consistency: "edge-eventual",
  });
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.sequence).toBe(2);
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.snapshotCacheDecodes - before.snapshotCacheDecodes).toBe(1);
});

test("future sequence barriers fail for both modes before query evaluation", async () => {
  await request(worker, "edge-future", "write", write([document("a", "text")]));
  for (const consistency of ["strong", "edge-eventual"])
    expect(
      (
        await request(worker, "edge-future", "query", {
          ...textQuery("text"),
          consistency,
          minimumSequence: 2,
        })
      ).status,
    ).toBe(409);
});

test("edge snapshots remain behind authentication and namespace isolation", async () => {
  await request(worker, "edge-private", "write", write([document("secret", "private text")]));
  await request(worker, "edge-private", "query", {
    ...textQuery("private"),
    consistency: "edge-eventual",
  });
  const empty = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "edge-empty", "query", {
        ...textQuery("private"),
        consistency: "edge-eventual",
      })
    ).json(),
  );
  expect(empty.rows).toEqual([]);
  const unauthorized = await fetch(
    new URL("/v1/namespaces/edge-private/query", await worker.ready),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ consistency: Schema.String })))(
        { consistency: "edge-eventual" },
      ),
    },
  );
  expect(unauthorized.status).toBe(401);
  await unauthorized.arrayBuffer();
});

test("expired snapshots cannot hide canonical R2 corruption", async () => {
  await request(worker, "edge-corruption", "write", write([document("a", "private text")]));
  await seedSnapshot("edge-corruption", Effect.runSync(Clock.currentTimeMillis) - 2000);
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put("namespaces/edge-corruption/root.json", "invalid");
  const response = await request(worker, "edge-corruption", "query", {
    ...textQuery("private"),
    consistency: "edge-eventual",
  });
  expect(response.status).toBe(503);
});

test("edge consistency cannot silently relax vector or hybrid contracts", async () => {
  const response = await request(worker, "edge-vector", "query", {
    kind: "vector",
    vector: [1],
    topK: 1,
    filters: [],
    consistency: "edge-eventual",
  });
  expect(response.status).toBe(400);
});

test("a still-valid older snapshot serves immediately while native background work refreshes it", async () => {
  await request(worker, "edge-refresh", "write", write([document("a", "old text")]));
  await seedSnapshot("edge-refresh", Effect.runSync(Clock.currentTimeMillis) - 350);
  await request(worker, "edge-refresh", "write", write([document("a", "new text")]));
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "edge-refresh", "query", {
        ...textQuery("old"),
        consistency: "edge-eventual",
      })
    ).json(),
  );
  expect(result.sequence).toBe(1);
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  const key = new URL("https://raio-cache.internal/snapshots-v8/edge-refresh?bucket=raio-test");
  const state = { refreshed: false };
  for (const attempt of Array.from({ length: 20 }, (_, index) => index)) {
    const cached = await cache.match(key);
    if (cached !== undefined) {
      const { snapshot } = await Effect.runPromise(readSnapshotFrame(await cached.arrayBuffer()));
      if (snapshot.manifest.sequence === 2) {
        state.refreshed = true;
        break;
      }
    }
    await Effect.runPromise(Effect.sleep(10 + attempt));
  }
  expect(state.refreshed).toBe(true);
});

test("query timings stay request scoped and preserve coordinator and gateway measurements", async () => {
  await request(worker, "timing", "write", write([document("a", "measured rust search")]));
  const responses = await Promise.all(
    ["strong", "edge-eventual", "edge-eventual"].map((consistency) =>
      request(worker, "timing", "query", { ...textQuery("rust"), consistency }),
    ),
  );
  for (const response of responses) {
    expect(response.status).toBe(200);
    const timing = response.headers.get("server-timing");
    expect(timing).not.toBeNull();
    if (timing === null) throw new Error("Missing query timings");
    for (const phase of ["text_directory", "text_rank", "text_documents", "gateway"])
      expect(
        timing.split(",").filter((entry) => entry.trim().startsWith(`${phase};dur=`)),
      ).toHaveLength(1);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(responses[0]?.headers.get("server-timing")).toContain("raio;dur=");
  for (const response of responses.slice(1)) {
    expect(response.headers.get("server-timing")).toContain("edge_snapshot;dur=");
    expect(response.headers.get("server-timing")).not.toContain("raio;dur=");
  }
});

test("warm namespace snapshots survive Cache API eviction only within their original age budget", async () => {
  await request(worker, "warm-memory", "write", write([document("a", "warm namespace")]));
  const input = { ...textQuery("warm"), consistency: "edge-eventual" };
  expect((await request(worker, "warm-memory", "query", input)).status).toBe(200);
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  const key = new URL("https://raio-cache.internal/snapshots-v8/warm-memory");
  key.searchParams.set("bucket", "raio-test");
  expect(await cache.delete(key)).toBe(true);
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put("namespaces/warm-memory/root.json", "corrupted canonical root");
  const cached = await request(worker, "warm-memory", "query", input);
  expect(cached.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await cached.json()).rows.map((row) => row.id),
  ).toEqual(["a"]);
  await Effect.runPromise(Effect.sleep("1100 millis"));
  expect((await request(worker, "warm-memory", "query", input)).status).toBe(503);
});

test("large warm snapshots retain the same age limit after Cache API eviction", async () => {
  const namespace = "large-warm-memory";
  await request(worker, namespace, "write", write([document("a", "warm namespace")]));
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing manifest");
  const manifest = decodeRoot(await object.text());
  const encoded = encodeRoot({
    ...manifest,
    segments: manifest.segments.map((segment) =>
      Object.assign({}, segment, {
        removedFrequencies: {
          ...segment.removedFrequencies,
          ["padding".repeat(180000)]: 0,
        },
      }),
    ),
  });
  expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(1024 * 1024);
  await bucket.put(`namespaces/${namespace}/root.json`, encoded);
  const input = { ...textQuery("warm"), consistency: "edge-eventual", minimumSequence: 1 };
  expect((await request(worker, namespace, "query", input)).status).toBe(200);
  const cache = await (await worker.getCaches()).open("raio-snapshots-v8");
  const key = new URL(`https://raio-cache.internal/snapshots-v8/${namespace}?bucket=raio-test`);
  expect(await cache.delete(key)).toBe(true);
  await bucket.put(`namespaces/${namespace}/root.json`, "corrupted canonical root");
  const cached = await request(worker, namespace, "query", input);
  expect(cached.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await cached.json()).rows.map((row) => row.id),
  ).toEqual(["a"]);
  await Effect.runPromise(Effect.sleep("1100 millis"));
  expect((await request(worker, namespace, "query", input)).status).toBe(503);
});

test("parallel strong queries observe complete immutable revisions while writes advance", async () => {
  const namespace = "strong-parallel";
  await request(worker, namespace, "write", write([document("a", "shared revisionone")]));
  for (const revision of [2, 3, 4, 5]) {
    const responses = await Promise.all([
      request(worker, namespace, "write", write([document("a", `shared revision${revision}`)])),
      ...Array.from({ length: 12 }, () => request(worker, namespace, "query", textQuery("shared"))),
    ]);
    const acknowledged = Schema.decodeUnknownSync(WriteResult)(await responses[0]?.json());
    expect(acknowledged.sequence).toBe(revision);
    for (const response of responses.slice(1)) {
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect([revision - 1, revision]).toContain(result.sequence);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.revision).toBe(result.sequence);
      expect(result.consistency).toBe("strong");
    }
    const fresh = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(worker, namespace, "query", {
          ...textQuery("shared"),
          minimumSequence: revision,
        })
      ).json(),
    );
    expect(fresh.sequence).toBe(revision);
    expect(fresh.rows[0]?.text).toBe(`shared revision${revision}`);
  }
});

test("coordinator snapshot recovery preserves request bodies and sequence barriers", async () => {
  const namespace = "edge-coordinator-recovery";
  const empty = await request(worker, namespace, "query", {
    ...textQuery("recovered"),
    consistency: "edge-eventual",
  });
  expect(empty.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await empty.json()).rows).toEqual([]);
  expect(empty.headers.get("server-timing")).toContain("edge_snapshot_fallback;dur=");
  const future = await request(worker, namespace, "query", {
    ...textQuery("recovered"),
    consistency: "edge-eventual",
    minimumSequence: 1,
  });
  expect(future.status).toBe(409);
  expect(future.headers.get("server-timing")).toContain("edge_snapshot_fallback;dur=");
  const written = Schema.decodeUnknownSync(WriteResult)(
    await (
      await request(worker, namespace, "write", write([document("a", "recovered text")]))
    ).json(),
  );
  const current = await request(worker, namespace, "query", {
    ...textQuery("recovered"),
    consistency: "edge-eventual",
    minimumSequence: written.sequence,
  });
  expect(current.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await current.json());
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  expect(result.sequence).toBe(written.sequence);
  const uncommitted = await request(worker, namespace, "query", {
    ...textQuery("recovered"),
    consistency: "edge-eventual",
    minimumSequence: written.sequence + 1,
  });
  expect(uncommitted.status).toBe(409);
  expect(uncommitted.headers.get("server-timing")).toContain("edge_snapshot_fallback;dur=");
});
