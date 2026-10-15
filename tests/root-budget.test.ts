import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health, QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("expired R2 acquisition recovers through the coordinator without restarting its budget", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-root-budget-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "root-budget-worker.ts")],
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
    await worker.dispose();
  });
  const namespace = "root-budget";
  expect(
    (await request(worker, namespace, "write", write([document("a", "alpha old")]))).status,
  ).toBe(200);
  await fetch(new URL("/fixture/arm", await worker.ready));
  const first = request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
    minimumSequence: 1,
  });
  const timely = await Promise.race([
    first.then(() => true),
    Effect.runPromise(Effect.sleep("1300 millis")).then(() => false),
  ]);
  const response = await first;
  expect(timely).toBe(true);
  expect(response.status).toBe(200);
  expect(response.headers.get("server-timing")).toContain("edge_snapshot_r2_timeout");
  expect(response.headers.get("server-timing")).toContain("edge_snapshot_fallback");
  const selected = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(selected.sequence).toBe(1);
  expect(selected.rows[0]?.text).toBe("alpha old");
  const state = await fetch(new URL("/fixture/state", await worker.ready));
  expect(state.headers.get("x-fixture-started")).toBe("1");
  expect(state.headers.get("x-fixture-completed")).toBe("0");
  expect(
    (await request(worker, namespace, "write", write([document("a", "alpha new")]))).status,
  ).toBe(200);
  const newer = await request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
    minimumSequence: 2,
  });
  expect(newer.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await newer.json()).rows[0]?.text).toBe("alpha new");
  expect(newer.headers.get("server-timing")).toContain("edge_snapshot_r2_timeout");
  const future = await request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
    minimumSequence: 3,
  });
  expect(future.status).toBe(409);
  const pending = await fetch(new URL("/fixture/state", await worker.ready));
  expect(pending.headers.get("x-fixture-started")).toBe("1");
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const done = await fetch(new URL("/fixture/state", await worker.ready));
    if (done.headers.get("x-fixture-completed") === "1") break;
    if (attempt === 99) throw new Error("Detached R2 body did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  const namespaces = ["root-budget-pooled-a", "root-budget-pooled-b"];
  for (const name of namespaces)
    expect(
      (await request(worker, name, "write", write([document("a", "alpha pooled")]))).status,
    ).toBe(200);
  const pooled = await Promise.all(
    namespaces.map((name) =>
      request(worker, name, "query", {
        ...textQuery("alpha"),
        consistency: "edge-eventual",
        minimumSequence: 1,
      }),
    ),
  );
  expect(
    pooled.filter((returned) =>
      returned.headers.get("server-timing")?.includes("edge_snapshot_r2_body_admission"),
    ),
  ).toHaveLength(1);
  expect(
    pooled.filter((returned) =>
      returned.headers.get("server-timing")?.includes("edge_snapshot_r2_timeout"),
    ),
  ).toHaveLength(1);
  for (const returned of pooled) {
    expect(returned.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await returned.json()).sequence).toBe(1);
  }
  for (const attempt of Array.from({ length: 400 }, (_, index) => index)) {
    const done = await fetch(new URL("/fixture/state", await worker.ready));
    if (
      done.headers.get("x-fixture-completed") === "2" &&
      done.headers.get("x-fixture-cancelled") === "1"
    )
      break;
    if (attempt === 399) throw new Error("Cross-namespace acquisition did not settle or cancel");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  const health = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(health.snapshotMemoryChargedBytes).toBe(0);
  expect(health.snapshotCachePutAttempts).toBe(0);
}, 15000);
