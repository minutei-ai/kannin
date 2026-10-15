import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("optional ANN publication does not delay results and shares bounded admission with text plans", async () => {
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
  expect(first.headers.get("x-fixture-started")).toBe("1");
  expect(first.headers.get("x-fixture-completed")).toBe("0");
  expect(first.headers.get("server-timing")).toContain("vector_publish_scheduled");
  const duplicate = await request(worker, "publication-vector", "query", input);
  expect(duplicate.status).toBe(200);
  expect(duplicate.headers.get("x-fixture-started")).toBe("1");
  expect(duplicate.headers.get("server-timing")).toContain("vector_publish_skipped");
  for (const attempt of Array.from({ length: 120 }, (_, index) => index)) {
    const observed = await fetch(new URL("/fixture/state", base));
    if (observed.headers.get("x-fixture-completed") === "1") break;
    if (attempt === 119) throw new Error("Publication did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  const cached = await request(worker, "publication-vector", "query", input);
  expect(cached.headers.get("server-timing")).toContain('vector_cache;desc="hit"');
  for (const index of Array.from({ length: 8 }, (_, row) => row))
    expect(
      (
        await request(
          worker,
          "publication-text",
          "write",
          write([document(String(index), "alpha")]),
        )
      ).status,
    ).toBe(200);
  await fetch(new URL("/fixture/slow", base));
  for (const index of Array.from({ length: 17 }, (_, row) => row + 1)) {
    const response = await request(worker, "publication-vector", "query", {
      ...input,
      vector: [1, index / 1000, ...Array.from({ length: 766 }, () => 0)],
    });
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json()).rows).toHaveLength(1);
    if (index === 17)
      expect(response.headers.get("server-timing")).toContain("vector_publish_skipped");
  }
  const full = await fetch(new URL("/fixture/state", base));
  expect(full.headers.get("x-fixture-started")).toBe("17");
  expect(full.headers.get("x-fixture-completed")).toBe("1");
  const text = await request(worker, "publication-text", "query", textQuery("alpha"));
  expect(text.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await text.json()).rows).toHaveLength(8);
  expect(text.headers.get("server-timing")).toContain("text_plan_publish_skipped");
  await Effect.runPromise(Effect.sleep("5100 millis"));
  const settled = await fetch(new URL("/fixture/state", base));
  expect(settled.headers.get("x-fixture-completed")).toBe("17");
  await fetch(new URL("/fixture/healthy", base));
  const late = await request(worker, "publication-vector", "query", {
    ...input,
    vector: [1, 0.001, ...Array.from({ length: 766 }, () => 0)],
  });
  expect(late.status).toBe(200);
  expect(late.headers.get("server-timing")).toContain("vector_cache_rejected");
  expect(late.headers.get("server-timing")).toContain('vector_cache;desc="miss"');
  await fetch(new URL("/fixture/fail", base));
  const failure = await request(worker, "publication-vector", "query", {
    ...input,
    vector: [1, 0.9, ...Array.from({ length: 766 }, () => 0)],
  });
  expect(failure.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await failure.json()).rows.map((row) => row.id),
  ).toEqual(["a"]);
  expect(failure.headers.get("server-timing")).toContain("vector_publish_scheduled");
  const failed = await fetch(new URL("/fixture/state", base));
  expect(failed.headers.get("x-fixture-failed")).toBe("1");
  await fetch(new URL("/fixture/healthy", base));
  const retry = await request(worker, "publication-vector", "query", {
    ...input,
    vector: [1, 0.9, ...Array.from({ length: 766 }, () => 0)],
  });
  expect(retry.status).toBe(200);
  expect(retry.headers.get("server-timing")).toContain("vector_publish_scheduled");
}, 20000);
