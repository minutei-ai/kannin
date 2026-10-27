import { decodeRoot, encodeRoot } from "../src/manifest";
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Response } from "miniflare";
import {
  Metadata,
  QueryResult,
  SharedTextPlan,
  SharedTextPlanCacheHeaders,
  TextPlanIdentity,
} from "../src/protocol";
import { initSync, pack, unpack } from "../dist/wasm/raio_engine";
import { document, request, startWorker, textQuery, write, evictWrittenOverviews } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});

test("shared match ceilings preserve unions, intersections and excluded filters", async () => {
  const worker = await startWorker();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  const namespace = "plan-match-ceilings";
  for (const index of Array.from({ length: 8 }, (_, row) => row))
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([
            document(`${index}-a`, "alpha", { group: 0 }),
            document(`${index}-b`, "beta", { group: 1 }),
            document(`${index}-c`, "constructor", { group: 2 }),
          ]),
        )
      ).status,
    ).toBe(200);
  const object = await (
    await worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing fixture manifest");
  const root = decodeRoot(await object.text());
  const first = root.segments[0];
  if (first === undefined) throw new Error("Missing fixture segment");
  const cache = await (await worker.getCaches()).open("kannin-text-plans-v1");
  for (const sample of [
    { text: "alpha beta", mode: "any", filters: [], maximum: 2, rows: 16 },
    { text: "alpha beta", mode: "all", filters: [], maximum: 1, rows: 0 },
    { text: "alpha beta", mode: "phrase", filters: [], maximum: 1, rows: 0 },
    { text: "alpha alpha", mode: "phrase", filters: [], maximum: 0, rows: 0 },
    { text: "constructor", mode: "any", filters: [], maximum: 1, rows: 8 },
    {
      text: "alpha beta",
      mode: "any",
      filters: [{ field: "group", op: "eq", value: 99 }],
      maximum: 0,
      rows: 0,
    },
  ] as const) {
    const response = await request(worker, namespace, "query", {
      ...textQuery(sample.text, 20, [...sample.filters]),
      match: sample.mode,
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.sequence).toBe(8);
    expect(result.rows).toHaveLength(sample.rows);
    const identity = Schema.encodeSync(Schema.fromJsonString(TextPlanIdentity))({
      correlatedRoot: false,
      text: sample.text,
      mode: sample.mode,
      filters: sample.filters,
      documents: root.documents,
      titleLength: root.titleLength,
      bodyLength: root.bodyLength,
      segments: root.segments,
    });
    const key = `raio-test:${first.key}/plan:${createHash("sha256").update(identity).digest("hex")}`;
    const cacheKey = new URL("https://raio-cache.internal/text-plans-v1");
    cacheKey.searchParams.set("identity", key);
    cacheKey.searchParams.set("version", "kannin-local-test-version");
    const stored = { frame: await cache.match(cacheKey) };
    for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
      if (stored.frame !== undefined) break;
      if (attempt === 99) throw new Error("Plan publication did not settle");
      await Effect.runPromise(Effect.sleep("10 millis"));
      stored.frame = await cache.match(cacheKey);
    }
    const frame = stored.frame;
    if (frame === undefined) throw new Error("Missing published plan");
    const shared = Schema.decodeSync(Schema.fromJsonString(SharedTextPlan))(
      unpack(new Uint8Array(await frame.arrayBuffer())),
    );
    expect(shared.plan.segments.map((segment) => segment.maximumMatches)).toEqual(
      Array.from({ length: 8 }, () => sample.maximum),
    );
  }
  const damaged = { ...root, segments: [...root.segments] };
  damaged.segments[0] = { ...first, count: 0 };
  await (
    await worker.getR2Bucket("STORAGE")
  ).put(`namespaces/${namespace}/root.json`, encodeRoot(damaged));
  const rejected = await request(worker, namespace, "query", {
    ...textQuery("alpha beta", 20),
    consistency: "edge-eventual",
    minimumSequence: 8,
  });
  expect(rejected.status).toBe(503);
});

test("shared tightened plans survive fresh workerd instances and reject corrupt or mismatched frames", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "kannin-shared-plan-"));
  const active = { worker: await startWorker(persistence) };
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  cleanup.defer(() => active.worker.dispose());
  const namespace = "shared-plan";
  for (const segment of Array.from({ length: 12 }, (_, index) => index))
    expect(
      (
        await request(
          active.worker,
          namespace,
          "write",
          write(
            Array.from({ length: 24 }, (_, row) =>
              Object.assign(
                document(
                  `${String(segment).padStart(2, "0")}-${String(row).padStart(2, "0")}`,
                  `${"alpha beta gamma delta ".repeat(2 + (row % 8))}unique${segment}row${row}`,
                ),
                { title: "fixture" },
              ),
            ),
          ),
        )
      ).status,
    ).toBe(200);
  const bucket = await active.worker.getR2Bucket("STORAGE");
  const derived = await bucket.list({
    prefix: `cache/correlated-pool-v3/namespaces/${namespace}/`,
  });
  await bucket.delete(derived.objects.map((object) => object.key));
  await evictWrittenOverviews(active.worker, namespace);
  const query = textQuery("alpha beta gamma delta", 3);
  const first = await request(active.worker, namespace, "query", query);
  const expected = Schema.decodeUnknownSync(QueryResult)(await first.json());
  expect(first.headers.get("server-timing")).toContain('text_plan;desc="miss"');
  expect(first.headers.get("server-timing")).toContain('desc="segments=12"');
  expect(first.headers.get("server-timing")).toContain("text_plan_publish_scheduled");
  const object = await (
    await active.worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing fixture manifest");
  const root = decodeRoot(await object.text());
  const segment = root.segments[0];
  if (segment === undefined) throw new Error("Missing fixture segment");
  const identity = Schema.encodeSync(Schema.fromJsonString(TextPlanIdentity))({
    correlatedRoot: false,
    text: "alpha beta delta gamma",
    mode: "any",
    filters: [],
    documents: root.documents,
    titleLength: root.titleLength,
    bodyLength: root.bodyLength,
    segments: root.segments,
  });
  const key = `raio-test:${segment.key}/plan:${createHash("sha256").update(identity).digest("hex")}`;
  const cacheKey = new URL("https://raio-cache.internal/text-plans-v1");
  cacheKey.searchParams.set("identity", key);
  cacheKey.searchParams.set("version", "kannin-local-test-version");
  const cache = await (await active.worker.getCaches()).open("kannin-text-plans-v1");
  const stored = { frame: await cache.match(cacheKey) };
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    if (stored.frame !== undefined) break;
    if (attempt === 99) throw new Error("Plan publication did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
    stored.frame = await cache.match(cacheKey);
  }
  const frame = stored.frame;
  expect(frame).toBeDefined();
  if (frame === undefined) throw new Error("Missing published plan");
  const bytes = new Uint8Array(await frame.arrayBuffer());
  const shared = Schema.decodeSync(Schema.fromJsonString(SharedTextPlan))(unpack(bytes));
  expect(shared.identity).toBe(key);
  expect(shared.version).toBe("kannin-local-test-version");
  expect(shared.plan.segments).toHaveLength(12);
  expect(shared.plan.segments.map((planned) => planned.maximumMatches)).toEqual(
    Array.from({ length: 12 }, () => 24),
  );
  await active.worker.dispose();
  active.worker = await startWorker(persistence);
  const blocked = await request(active.worker, namespace, "query", {
    ...query,
    minimumSequence: 13,
  });
  expect(blocked.status).toBe(409);
  const restored = await request(active.worker, namespace, "query", {
    ...query,
    text: " DÉLTA alpha ALPHA gamma beta ",
  });
  expect(Schema.decodeUnknownSync(QueryResult)(await restored.json())).toEqual(expected);
  expect(restored.headers.get("server-timing")).toContain('text_plan;desc="shared"');
  expect(restored.headers.get("server-timing")).toContain('text_bound_hits;desc="0"');
  expect(restored.headers.get("server-timing")).toContain('desc="segments=1"');
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(active.worker, namespace, "metadata")).json(),
  );
  expect(metadata.cache.termRequests).toBe(0);
  for (const fault of [
    "checksum",
    "identity",
    "version",
    "count",
    "statistics",
    "negative-bound",
    "negative-matches",
    "fractional-matches",
  ]) {
    const encoded = { value: bytes };
    if (fault === "checksum") {
      const copy = new Uint8Array(bytes);
      const checksum = copy[12];
      if (checksum === undefined) throw new Error("Missing fixture checksum");
      copy[12] = checksum ^ 1;
      encoded.value = copy;
    } else {
      const candidate = {
        ...shared,
        plan: { ...shared.plan, segments: [...shared.plan.segments] },
      };
      if (fault === "identity") candidate.identity = "other-identity";
      if (fault === "version") candidate.version = "other-version";
      if (fault === "count") candidate.plan.segments.pop();
      if (fault === "statistics")
        candidate.plan.statistics = { ...candidate.plan.statistics, documents: 0 };
      const storedSegment = candidate.plan.segments[0];
      if (storedSegment === undefined) throw new Error("Missing fixture segment");
      if (fault === "negative-bound") candidate.plan.segments[0] = { ...storedSegment, bound: -1 };
      if (fault === "negative-matches")
        candidate.plan.segments[0] = { ...storedSegment, maximumMatches: -1 };
      if (fault === "fractional-matches")
        candidate.plan.segments[0] = { ...storedSegment, maximumMatches: 0.5 };
      encoded.value = new Uint8Array(pack(JSON.stringify(candidate)));
    }
    const nativeCache = await (await active.worker.getCaches()).open("kannin-text-plans-v1");
    await nativeCache.put(
      cacheKey,
      new Response(new Uint8Array(encoded.value), {
        headers: {
          "cache-control": "public, max-age=3600",
          ...Schema.encodeSync(SharedTextPlanCacheHeaders)({
            "content-length": encoded.value.byteLength,
            "x-kannin-plan-bytes": new DataView(
              encoded.value.buffer,
              encoded.value.byteOffset,
              encoded.value.byteLength,
            ).getUint32(8, true),
          }),
        },
      }),
    );
    await active.worker.dispose();
    active.worker = await startWorker(persistence);
    const fallback = await request(active.worker, namespace, "query", query);
    expect(Schema.decodeUnknownSync(QueryResult)(await fallback.json())).toEqual(expected);
    expect(fallback.headers.get("server-timing")).toContain('text_plan;desc="miss"');
    expect(fallback.headers.get("server-timing")).toContain('desc="segments=12"');
  }
  await active.worker.dispose();
  active.worker = await startWorker(persistence, false, undefined, "next-worker-version");
  const nextVersion = await request(active.worker, namespace, "query", query);
  expect(Schema.decodeUnknownSync(QueryResult)(await nextVersion.json())).toEqual(expected);
  expect(nextVersion.headers.get("server-timing")).toContain('text_plan;desc="miss"');
  expect(nextVersion.headers.get("server-timing")).toContain('desc="segments=12"');
}, 30000);
