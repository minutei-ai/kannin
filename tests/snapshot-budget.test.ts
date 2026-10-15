import { expect, test } from "bun:test";
import { Response } from "miniflare";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health, QueryResult, Root, SnapshotCacheHeaders } from "../src/protocol";
import { snapshotFrame } from "../src/snapshot";
import { document, request, startWorker, textQuery, write } from "./harness";

test("a stalled snapshot cache cannot delay R2 selection or replace its newer root", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-cache-budget-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "snapshot-cache-worker.ts")],
    outdir: artifacts,
    naming: "worker.js",
    target: "browser",
    format: "esm",
    minify: true,
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "wasm",
        setup(builder) {
          builder.onResolve({ filter: /^raio:wasm$/ }, () => ({
            path: "./raio_engine_bg.wasm",
            external: true,
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs);
  await Bun.write(
    join(artifacts, "raio_engine_bg.wasm"),
    Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")),
  );
  const worker = await startWorker(undefined, false, artifacts);
  cleanup.defer(async () => {
    await fetch(new URL("/fixture/release", await worker.ready));
    await worker.dispose();
  });
  const namespace = "snapshot-cache-budget";
  expect(
    (await request(worker, namespace, "write", write([document("a", "alpha old")]))).status,
  ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const old = await bucket.get(`namespaces/${namespace}/root.json`);
  if (old === null) throw new Error("Missing old root");
  const payload = new Uint8Array(await old.arrayBuffer());
  const manifest = Schema.decodeSync(Schema.fromJsonString(Root))(
    new TextDecoder().decode(payload),
  );
  expect(
    (await request(worker, namespace, "write", write([document("a", "alpha new")]))).status,
  ).toBe(200);
  const observedAt = Date.now();
  const cache = await (await worker.getCaches()).open("raio-snapshots-v2");
  await cache.put(
    `https://raio-cache.internal/snapshots/${namespace}?bucket=raio-test`,
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
  const pending = request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
  });
  const returnedBeforeRelease = await Promise.race([
    pending.then(() => true),
    Effect.runPromise(Effect.sleep("750 millis")).then(() => false),
  ]);
  const blocked = await fetch(new URL("/fixture/state", await worker.ready));
  expect(blocked.headers.get("x-fixture-started")).toBe("1");
  expect(blocked.headers.get("x-fixture-completed")).toBe("0");
  await fetch(new URL("/fixture/release", await worker.ready));
  const response = await pending;
  expect(returnedBeforeRelease).toBe(true);
  expect(response.status).toBe(200);
  expect(response.headers.get("server-timing")).toContain("edge_snapshot_cache_timeout");
  const selected = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(selected.sequence).toBe(2);
  expect(selected.rows[0]?.text).toBe("alpha new");
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const health = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    if (health.snapshotCacheDecodes + health.snapshotCacheRejected >= 1) break;
    if (attempt === 99) throw new Error("Detached cache lookup did not finish");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  const second = await request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
    minimumSequence: 2,
  });
  expect(Schema.decodeUnknownSync(QueryResult)(await second.json())).toEqual(selected);
  expect(second.headers.get("server-timing")).not.toContain("edge_snapshot_r2");
  expect(second.headers.get("server-timing")).not.toContain("edge_snapshot_cache;");
}, 15000);
