import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheMetrics, Metadata, QueryResult, Root } from "../src/protocol";
import { QueryRankerProbe } from "./query-ranker-contract";
import { document, request, startWorker, textQuery, write } from "./harness";

test("scoped rankers preserve hot admission, promote after aging and release on rebuild", async () => {
  await using cleanup = new AsyncDisposableStack();
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-query-ranker-"));
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "query-ranker-fixture.ts")],
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
  const namespace = "scoped-ranker-admission";
  for (const [id, word] of [
    ["a", "alpha"],
    ["b", "beta"],
  ] as const)
    expect(
      (await request(worker, namespace, "write", write([document(id, word, { retained: word })])))
        .status,
    ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing root");
  const root = Schema.decodeSync(Schema.fromJsonString(Root))(await object.text());
  const alpha = root.segments[0];
  const beta = root.segments[1];
  if (alpha === undefined || beta === undefined) throw new Error("Missing sources");
  const query = {
    text: "alpha",
    mode: "any" as const,
    top_k: 10,
    dead: [],
    filters: [],
    statistics: {
      documents: 2,
      title_length: 0,
      body_length: 2,
      frequencies: { alpha: 1, beta: 1 },
    },
  };
  const warm = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, await worker.ready), {
    headers: {
      authorization: "Bearer local-test-token",
      "x-kannin-ranker-probe": Schema.encodeSync(Schema.fromJsonString(QueryRankerProbe))({
        source: alpha,
        query,
        count: 300,
      }),
    },
  });
  expect(warm.status).toBe(200);
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("beta"))).json(),
  );
  expect(original.rows.map((row) => row.id)).toEqual(["b"]);
  const scoped = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, await worker.ready), {
    headers: {
      authorization: "Bearer local-test-token",
      "x-kannin-ranker-probe": Schema.encodeSync(Schema.fromJsonString(QueryRankerProbe))({
        source: beta,
        query: { ...query, text: "beta" },
        count: 512,
      }),
    },
  });
  expect(scoped.status).toBe(200);
  const projected = Schema.decodeUnknownSync(CacheMetrics)(await scoped.json());
  expect(projected.directoryQueryProjections).toBeGreaterThanOrEqual(512);
  expect(projected.directoryCacheChargedBytes).toBe(12 * 1024 * 1024);
  const aged = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, await worker.ready), {
    headers: {
      authorization: "Bearer local-test-token",
      "x-kannin-ranker-probe": Schema.encodeSync(Schema.fromJsonString(QueryRankerProbe))({
        source: beta,
        query: { ...query, text: "beta" },
        count: 4096,
      }),
    },
  });
  expect(aged.status).toBe(200);
  const promoted = Schema.decodeUnknownSync(CacheMetrics)(await aged.json());
  expect(promoted.directoryCacheHits).toBeGreaterThan(projected.directoryCacheHits);
  expect(promoted.directoryCacheChargedBytes).toBe(12 * 1024 * 1024);
  expect(promoted.encodedDirectoryAdmissionChargedBytes).toBeLessThanOrEqual(1024 * 1024);
  const current = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("beta"))).json(),
  );
  expect(current).toEqual(original);
  const hot = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(hot.cache.directoryQueryProjections).toBe(promoted.directoryQueryProjections);
  expect(hot.cache.directoryCacheHits).toBeGreaterThan(promoted.directoryCacheHits);
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const empty = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(empty.cache.directoryCacheChargedBytes).toBe(0);
  expect(empty.cache.encodedDirectoryAdmissionChargedBytes).toBe(0);
  expect(
    Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, namespace, "query", textQuery("beta"))).json(),
    ),
  ).toEqual(original);
}, 30000);
