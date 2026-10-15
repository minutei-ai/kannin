import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Response } from "miniflare";
import { Metadata, QueryResult, Root, SharedTextPlan, TextPlanIdentity } from "../src/protocol";
import { initSync, pack, unpack } from "../dist/wasm/raio_engine";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")).arrayBuffer(),
  ),
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
              document(
                `${String(segment).padStart(2, "0")}-${String(row).padStart(2, "0")}`,
                `${"alpha beta gamma delta ".repeat(2 + (row % 8))}unique${segment}row${row}`,
              ),
            ),
          ),
        )
      ).status,
    ).toBe(200);
  const query = textQuery("alpha beta gamma delta", 3);
  const first = await request(active.worker, namespace, "query", query);
  const expected = Schema.decodeUnknownSync(QueryResult)(await first.json());
  expect(first.headers.get("server-timing")).toContain('text_plan;desc="miss"');
  expect(first.headers.get("server-timing")).toContain('desc="segments=12"');
  expect(first.headers.get("server-timing")).toContain("text_plan_published");
  const object = await (
    await active.worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing fixture manifest");
  const root = Schema.decodeSync(Schema.fromJsonString(Root))(await object.text());
  const segment = root.segments[0];
  if (segment === undefined) throw new Error("Missing fixture segment");
  const identity = Schema.encodeSync(Schema.fromJsonString(TextPlanIdentity))({
    text: query.text,
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
  const frame = await cache.match(cacheKey);
  expect(frame).toBeDefined();
  if (frame === undefined) throw new Error("Missing published plan");
  const bytes = new Uint8Array(await frame.arrayBuffer());
  const shared = Schema.decodeSync(Schema.fromJsonString(SharedTextPlan))(unpack(bytes));
  expect(shared.identity).toBe(key);
  expect(shared.version).toBe("kannin-local-test-version");
  expect(shared.plan.segments).toHaveLength(12);
  await active.worker.dispose();
  active.worker = await startWorker(persistence);
  const blocked = await request(active.worker, namespace, "query", {
    ...query,
    minimumSequence: 13,
  });
  expect(blocked.status).toBe(409);
  const restored = await request(active.worker, namespace, "query", query);
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
      if (fault === "negative-bound") candidate.plan.segments[0] = { eligible: true, bound: -1 };
      encoded.value = new Uint8Array(pack(JSON.stringify(candidate)));
    }
    const nativeCache = await (await active.worker.getCaches()).open("kannin-text-plans-v1");
    await nativeCache.put(
      cacheKey,
      new Response(new Uint8Array(encoded.value), {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-length": String(encoded.value.byteLength),
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
