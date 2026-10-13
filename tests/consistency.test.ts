import { afterAll, expect, test } from "bun:test";
import { Response } from "miniflare";
import { Clock, Effect, Schema } from "effect";
import { QueryResult, Root, Snapshot, WriteResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

async function seedSnapshot(namespace: string, observedAt: number) {
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (!object) throw new Error("Missing manifest");
  const manifest = Schema.decodeSync(Schema.fromJsonString(Root))(await object.text());
  const cache = await (await worker.getCaches()).open("raio-snapshots-v1");
  const key = new URL(`https://raio-cache.internal/snapshots/${namespace}`);
  key.searchParams.set("bucket", "raio-test");
  await cache.put(
    key,
    new Response(Schema.encodeSync(Schema.fromJsonString(Snapshot))({ observedAt, manifest }), {
      headers: { "cache-control": "public, max-age=60", "content-type": "application/json" },
    }),
  );
}

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
  const edge = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "edge-barrier", "query", {
        ...textQuery("new"),
        consistency: "edge-eventual",
        minimumSequence: updated.sequence,
      })
    ).json(),
  );
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
  }
});

test("future sequence barriers fail for both modes without waiting for Vectorize", async () => {
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
  const cache = await (await worker.getCaches()).open("raio-snapshots-v1");
  const key = new URL("https://raio-cache.internal/snapshots/edge-refresh?bucket=raio-test");
  const state = { refreshed: false };
  for (const attempt of Array.from({ length: 20 }, (_, index) => index)) {
    const cached = await cache.match(key);
    if (cached) {
      const snapshot = Schema.decodeSync(Schema.fromJsonString(Snapshot))(await cached.text());
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
