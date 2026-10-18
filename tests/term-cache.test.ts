import { expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Root,
  TermProjectionProps,
  TermCatalogBatch,
  TermFilterHeader,
  TermFilters,
  QueryResult,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("immutable field models ignore predicate values while exact fallbacks retain their filter identity", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-term-cache-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "term-cache-server.ts")],
    outdir: artifacts,
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
  await Bun.write(join(artifacts, "worker.js"), Bun.file(join(artifacts, "term-cache-server.js")));
  await Bun.write(
    join(artifacts, "raio_engine_bg.wasm"),
    Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")),
  );
  const worker = await startWorker(undefined, false, artifacts);
  cleanup.defer(() => worker.dispose());
  const bucket = await worker.getR2Bucket("STORAGE");
  const call = async (
    namespace: string,
    selection: typeof TermProjectionProps.Type.selection,
    filters: typeof TermFilters.Type,
  ) => {
    const root = await bucket.get(`namespaces/${namespace}/root.json`);
    if (root === null) throw new Error("Missing manifest");
    const manifest = Schema.decodeSync(Schema.fromJsonString(Root))(await root.text());
    const segment = manifest.segments[0];
    if (segment === undefined) throw new Error("Missing source");
    return fetch(new URL("/__catalog", await worker.ready), {
      method: "POST",
      headers: { "x-kannin-filters": Schema.encodeSync(TermFilterHeader)(filters) },
      body: Schema.encodeSync(Schema.fromJsonString(TermProjectionProps))({
        bucket: "raio-test",
        terms: ["alpha"],
        selection,
        ranges: [{ key: segment.key, headerBytes: segment.headerBytes }],
      }),
    });
  };
  expect(
    (
      await request(
        worker,
        "catalog-model",
        "write",
        write(
          Array.from({ length: 700 }, (_, index) =>
            document(String(index), "alpha ".repeat(1 + (index % 9)), {
              group: index % 100,
              year: 2020 + (index % 7),
            }),
          ),
        ),
      )
    ).status,
  ).toBe(200);
  const bodies = [];
  for (const group of [72, 43]) {
    const response = await call("catalog-model", { kind: "fields", fields: ["group", "year"] }, [
      { field: "group", op: "eq", value: group },
      { field: "year", op: "gte", value: 2021 },
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    const batch = Schema.decodeUnknownSync(TermCatalogBatch)(await response.json());
    expect(batch.filterDigest).toBeNull();
    expect(batch.catalogs[0]?.selection.kind).toBe("model");
    bodies.push(batch);
  }
  expect(bodies[0]).toEqual(bodies[1]);
  expect(
    (
      await call("catalog-model", { kind: "fields", fields: ["group"] }, [
        { field: "year", op: "eq", value: 2020 },
      ])
    ).status,
  ).toBe(400);
  for (const namespace of ["catalog-exact", "catalog-poison"]) {
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write(
            Array.from({ length: 500 }, (_, index) =>
              document(String(index), "alpha", { group: index }),
            ),
          ),
        )
      ).status,
    ).toBe(200);
  }
  for (const group of [12, 13]) {
    const filters = [{ field: "group", op: "eq", value: group }] as const;
    const response = await call("catalog-exact", { kind: "fields", fields: ["group"] }, filters);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("x-kannin-filters");
    const batch = Schema.decodeUnknownSync(TermCatalogBatch)(await response.json());
    expect(batch.catalogs[0]?.selection.kind).toBe("minimum");
    expect(batch.filterDigest).toBe(
      createHash("sha256").update(Schema.encodeSync(TermFilters)(filters)).digest("hex"),
    );
    const actual = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(worker, "catalog-exact", "query", textQuery("alpha", 10, [...filters]))
      ).json(),
    );
    expect(actual.rows.map((row) => row.id)).toEqual([String(group)]);
  }
  expect(
    (
      await request(
        worker,
        "catalog-poison",
        "query",
        textQuery("alpha", 10, [{ field: "group", op: "eq", value: 12 }]),
      )
    ).status,
  ).toBe(503);
  const note = "😀ação".repeat(1800);
  expect(
    (
      await request(
        worker,
        "catalog-long",
        "write",
        write([
          document("match", "alpha", { note }),
          document("other", "alpha", { note: "other" }),
        ]),
      )
    ).status,
  ).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        "catalog-long",
        "query",
        textQuery("alpha", 10, [{ field: "note", op: "eq", value: note }]),
      )
    ).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["match"]);
  const unicode = [{ field: "note", op: "eq", value: "😀ação" }] as const;
  expect(Schema.decodeSync(TermFilterHeader)(Schema.encodeSync(TermFilterHeader)(unicode))).toEqual(
    unicode,
  );
}, 15000);
