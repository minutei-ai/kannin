import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("cold catalog publication does not delay rows or change subsequent results", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-overview-publication-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "overview-publication-worker.ts")],
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
  const namespace = "overview-publication";
  for (const index of Array.from({ length: 6 }, (_, ordinal) => ordinal))
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document(String(index), "alpha beta", { group: 0 })]),
        )
      ).status,
    ).toBe(200);
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const pending = request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
  });
  const response = await pending;

  expect(response.status).toBe(200);
  const first = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(first.rows).toHaveLength(6);
  expect(response.headers.get("server-timing")).toContain("origins=1");
  expect(response.headers.get("server-timing")).toContain("reads=6 hits=6");
  const state = await fetch(new URL("/fixture/state", await worker.ready));
  expect(state.headers.get("x-fixture-started")).toBe("1");
  expect(state.headers.get("x-fixture-completed")).toBe("0");
  const next = await request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
  });
  expect(Schema.decodeUnknownSync(QueryResult)(await next.json())).toEqual(first);
  expect(next.headers.get("server-timing")).toContain('text_plan;desc="memory"');
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const completed = await fetch(new URL("/fixture/state", await worker.ready));
    if (completed.headers.get("x-fixture-completed") === "1") break;
    if (attempt === 99) throw new Error("Background plan publication did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const reused = await request(worker, namespace, "query", {
    ...textQuery("alpha", 10, [{ field: "group", op: "eq", value: 0 }]),
    consistency: "edge-eventual",
  });
  expect(reused.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await reused.json())).toEqual(first);
  expect(reused.headers.get("server-timing")).toContain('desc="memory=0 api=6"');
  const settled = await fetch(new URL("/fixture/state", await worker.ready));
  expect(settled.headers.get("x-fixture-started")).toBe("1");
}, 15000);
