import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { document, request, startWorker, textQuery, write } from "./harness";

test("edge query deadline retains request-local progress and snapshot timings", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-query-progress-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "query-progress-worker.ts")],
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
  const namespace = "query-progress";
  expect(
    (await request(worker, namespace, "write", write([document("a", "alpha beta")]))).status,
  ).toBe(200);
  const response = await request(worker, namespace, "query", {
    ...textQuery("alpha"),
    consistency: "edge-eventual",
    minimumSequence: 1,
  });
  expect(response.status).toBe(504);
  const timings = response.headers.get("server-timing");
  expect(timings).toContain('text_phase;desc="catalog"');
  expect(timings).not.toContain('text_phase;desc="ranking"');
  expect(timings).toContain("edge_snapshot_r2;");
  expect(timings).toContain("gateway;");
}, 40000);
