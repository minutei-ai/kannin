import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("sparse ranking overlaps reads before top-k fills within the existing four-reader limit", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-ranking-window-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "ranking-window-fixture.ts")],
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
  const documents = Array.from({ length: 8 }, (_, index) => document(String(index), "alpha beta"));
  expect((await request(worker, "window-reference", "write", write(documents))).status).toBe(200);
  const reference = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "window-reference", "query", textQuery("alpha beta", 10))).json(),
  );
  for (const value of documents)
    expect((await request(worker, "window-sparse", "write", write([value]))).status).toBe(200);
  const response = await request(worker, "window-sparse", "query", textQuery("alpha beta", 10));
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.sequence).toBe(8);
  expect(result.rows).toEqual(
    reference.rows.map((row, index) => Object.assign({}, row, { revision: index + 1 })),
  );
  const starts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(
    response.headers.get("x-fixture-starts"),
  );
  expect(starts).toHaveLength(16);
  expect(starts.slice(0, 4)).toEqual([0, 0, 0, 0]);
  expect(starts.slice(4, 8)).toEqual([4, 4, 4, 4]);
  expect(response.headers.get("x-fixture-peak")).toBe("8");
  expect(starts.slice(8)).toEqual(Array.from({ length: 8 }, () => 8));
  for (const segment of [0, 1, 2, 3, 4]) {
    const count = Math.min(10, 9 + segment);
    const values = Array.from({ length: count }, (_, row) =>
      document(`${String(segment).padStart(2, "0")}-${String(row).padStart(2, "0")}`, "alpha beta"),
    );
    expect((await request(worker, "window-nearly-full", "write", write(values))).status).toBe(200);
  }
  const nearlyFull = await request(
    worker,
    "window-nearly-full",
    "query",
    textQuery("alpha beta", 10),
  );
  expect(nearlyFull.status).toBe(200);
  const found = Schema.decodeUnknownSync(QueryResult)(await nearlyFull.json());
  expect(found.rows.map((row) => row.id)).toEqual([
    ...Array.from({ length: 9 }, (_, row) => `00-${String(row).padStart(2, "0")}`),
    "01-00",
  ]);
  expect(nearlyFull.headers.get("server-timing")).toContain('desc="segments=2"');
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(
      nearlyFull.headers.get("x-fixture-starts"),
    ),
  ).toHaveLength(6);
  for (const segment of Array.from({ length: 8 }, (_, index) => index))
    expect(
      (
        await request(
          worker,
          "window-empty",
          "write",
          write([document(`${segment}-a`, "alpha"), document(`${segment}-b`, "beta")]),
        )
      ).status,
    ).toBe(200);
  const empty = await request(worker, "window-empty", "query", {
    ...textQuery("alpha beta", 1),
    match: "all",
  });
  expect(empty.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await empty.json()).rows).toEqual([]);
  const emptyStarts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(
    empty.headers.get("x-fixture-starts"),
  );
  expect(emptyStarts).toHaveLength(8);
  expect(emptyStarts.slice(1, 4)).toEqual([1, 1, 1]);
  expect(emptyStarts.slice(4, 8)).toEqual([4, 4, 4, 4]);
  expect(empty.headers.get("x-fixture-peak")).toBe("4");
  for (const index of Array.from({ length: 16 }, (_, row) => row))
    expect(
      (
        await request(
          worker,
          "window-final-slot",
          "write",
          write([document(String(index).padStart(2, "0"), "alpha beta")]),
        )
      ).status,
    ).toBe(200);
  const finalSlot = await request(
    worker,
    "window-final-slot",
    "query",
    textQuery("alpha beta", 10),
  );
  expect(finalSlot.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await finalSlot.json()).rows.map((row) => row.id),
  ).toEqual(Array.from({ length: 10 }, (_, row) => String(row).padStart(2, "0")));
  expect(finalSlot.headers.get("server-timing")).toContain('desc="segments=10"');
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(
      finalSlot.headers.get("x-fixture-starts"),
    ),
  ).toHaveLength(20);
  const deleted = Array.from({ length: 8 }, (_, index) => `deleted-${index}`);
  for (const index of Array.from({ length: 8 }, (_, row) => row))
    expect(
      (
        await request(
          worker,
          "window-deleted",
          "write",
          write([
            document(`deleted-${index}`, "alpha beta"),
            document(`retained-${index}`, "gamma"),
          ]),
        )
      ).status,
    ).toBe(200);
  expect((await request(worker, "window-deleted", "write", write([], deleted))).status).toBe(200);
  const removed = await request(worker, "window-deleted", "query", textQuery("alpha beta", 10));
  expect(removed.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await removed.json()).rows).toEqual([]);
  expect(removed.headers.get("x-fixture-starts")).toBe("[]");
  expect(removed.headers.get("server-timing")).toContain('desc="segments=0"');
  for (const index of [0, 1, 2, 3])
    expect(
      (
        await request(
          worker,
          "window-exact-ceiling",
          "write",
          write([document(String(index), "alpha beta")]),
        )
      ).status,
    ).toBe(200);
  const exact = await request(worker, "window-exact-ceiling", "query", textQuery("alpha beta", 4));
  expect(exact.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await exact.json()).rows.map((row) => row.id),
  ).toEqual(["0", "1", "2", "3"]);
  const exactStarts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(
    exact.headers.get("x-fixture-starts"),
  );
  expect(exactStarts).toHaveLength(8);
  expect(exactStarts.slice(0, 4)).toEqual([0, 0, 0, 0]);
  expect(exact.headers.get("x-fixture-peak")).toBe("4");
}, 15000);
