import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("catalog reads refill available slots while a prior R2 read is pending", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-overview-publication-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "catalog-pipeline-worker.ts")],
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
  const namespace = "catalog-pipeline";
  for (const index of Array.from({ length: 8 }, (_, ordinal) => ordinal))
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document(String(index), `alpha unique${index}`)]),
        )
      ).status,
    ).toBe(200);
  const response = await request(worker, namespace, "query", textQuery("alpha", 10));
  expect(response.status).toBe(200);
  const first = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(first.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 8 }, (_, index) => String(index)),
  );
  expect(response.headers.get("server-timing")).toContain("reads=8 hits=8");
  const state = await fetch(new URL("/fixture/state", await worker.ready));
  expect(state.headers.get("x-fixture-started")).toBe("8");
  expect(state.headers.get("x-fixture-active")).toBe("0");
  expect(state.headers.get("x-fixture-peak")).toBe("4");
  expect(state.headers.get("x-fixture-refilled")).toBe("true");
  expect(state.headers.get("x-fixture-term-matches")).toBe("1");
  const resident = await request(worker, namespace, "query", textQuery("alpha unique2", 1));
  expect(resident.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await resident.json()).rows.map((row) => row.id),
  ).toEqual(["2"]);
  expect(resident.headers.get("server-timing")).toContain('desc="memory=1 api=0"');
  const reused = await fetch(new URL("/fixture/state", await worker.ready));
  expect(reused.headers.get("x-fixture-term-matches")).toBe("1");
  const repeated = await request(worker, namespace, "query", textQuery("alpha", 10));
  expect(Schema.decodeUnknownSync(QueryResult)(await repeated.json())).toEqual(first);
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const rehydrated = await request(worker, namespace, "query", textQuery("alpha unique1", 1));
  expect(rehydrated.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await rehydrated.json()).rows.map((row) => row.id),
  ).toEqual(["1"]);
  expect(rehydrated.headers.get("server-timing")).toContain('desc="memory=0 api=8"');
}, 15000);
