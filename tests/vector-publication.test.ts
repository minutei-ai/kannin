import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, write } from "./harness";

test("native vector queries bypass obsolete shared ANN cache publication", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-vector-publication-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "vector-publication-worker.ts")],
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
  cleanup.defer(() => worker.dispose());
  const base = await worker.ready;
  const vector = [1, ...Array.from({ length: 767 }, () => 0)];
  expect(
    (
      await request(
        worker,
        "publication-vector",
        "write",
        write([{ ...document("a", "alpha"), vector }]),
      )
    ).status,
  ).toBe(200);
  expect((await request(worker, "publication-vector", "vector-sync", {})).status).toBe(200);
  const input = { kind: "vector", vector, topK: 1, filters: [] };
  const first = await request(worker, "publication-vector", "query", input);
  expect(first.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await first.json()).rows.map((row) => row.id),
  ).toEqual(["a"]);
  expect(first.headers.get("x-fixture-started")).toBe("0");
  await fetch(new URL("/fixture/fail", base));
  const next = await request(worker, "publication-vector", "query", input);
  expect(next.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await next.json());
  expect(result.consistency).toBe("strong");
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  const state = await fetch(new URL("/fixture/state", base));
  expect(state.headers.get("x-fixture-started")).toBe("0");
  expect(state.headers.get("x-fixture-failed")).toBe("0");
}, 20000);
