import { decodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TermProjectionProps,
  type CommonTerms,
  TermCatalogBatch,
  TermFilterHeader,
  TermFilters,
  CatalogTelemetry,
  QueryResult,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

const artifacts = await mkdtemp(join(tmpdir(), "kannin-term-cache-"));
const cleanup = new AsyncDisposableStack();
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
  prefixes?: ReadonlyArray<typeof CommonTerms.Type>,
  target: typeof worker = worker,
  targetBucket: typeof bucket = bucket,
  terms: typeof TermProjectionProps.Type.terms = ["alpha"],
  rangeCount = 1,
) => {
  const root = await targetBucket.get(`namespaces/${namespace}/root.json`);
  if (root === null) throw new Error("Missing manifest");
  const manifest = decodeRoot(await root.text());
  const segment = manifest.segments[0];
  if (segment === undefined) throw new Error("Missing source");
  return fetch(new URL("/__catalog", await target.ready), {
    method: "POST",
    headers: { "x-kannin-filters": Schema.encodeSync(TermFilterHeader)(filters) },
    body: Schema.encodeSync(Schema.fromJsonString(TermProjectionProps))({
      bucket: "raio-test",
      terms,
      prefixes,
      selection,
      ranges: Array.from({ length: rangeCount }, () => ({
        key: segment.key,
        headerBytes: segment.headerBytes,
      })),
    }),
  });
};

afterAll(() => cleanup.disposeAsync());

test("immutable field models ignore predicate values while exact fallbacks retain their filter identity", async () => {
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
  expect(
    (
      await request(
        worker,
        "catalog-canonical",
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
  const canonicalRoot = await bucket.get("namespaces/catalog-canonical/root.json");
  if (canonicalRoot === null) throw new Error("Missing canonical root");
  const canonical = decodeRoot(await canonicalRoot.text());
  for (const source of canonical.segments) {
    await bucket.delete([
      `cache/correlated-pool-v3/${source.key}`,
      `cache/directory-v6/${source.key}/${source.headerBytes}`,
    ]);
  }
  expect((await request(worker, "catalog-canonical", "rebuild", {})).status).toBe(200);
  const recovered = await call("catalog-canonical", { kind: "fields", fields: ["group", "year"] }, [
    { field: "group", op: "eq", value: 72 },
    { field: "year", op: "gte", value: 2021 },
  ]);
  expect(recovered.status).toBe(200);
  const encodedTelemetry = recovered.headers.get("x-kannin-catalog-telemetry");
  if (encodedTelemetry === null) throw new Error("Missing recovery telemetry");
  const telemetry = Schema.decodeSync(Schema.fromJsonString(CatalogTelemetry))(encodedTelemetry);
  expect(telemetry.fallbackDirectories).toBe(1);
  expect(telemetry.r2Hits).toBe(0);
  expect(recovered.headers.get("cache-control")).toContain("immutable");
  const recoveredBatch = Schema.decodeUnknownSync(TermCatalogBatch)(await recovered.json());
  expect(recoveredBatch.filterDigest).toBeNull();
  expect(recoveredBatch.catalogs[0]?.selection.kind).toBe("model");
  expect(recoveredBatch.catalogs[0]?.dictionary).toEqual(bodies[0]?.catalogs[0]?.dictionary);
  expect(recoveredBatch.catalogs[0]?.selection).toEqual(bodies[0]?.catalogs[0]?.selection);
  expect(recoveredBatch.catalogs[0]?.partitions).toBeNull();
  expect(recoveredBatch.rootFallback).toBe(false);
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

test("Root-prefix catalog fallback preserves complete coverage across process restarts", async () => {
  const rootFallbackName = "catalog-root-fallback";
  const rootPersistence = join(artifacts, "root-fallback-persistence");
  const rootWriter = await startWorker(rootPersistence, false, artifacts);
  const rootWriterDisposed = { value: false };
  cleanup.defer(() => {
    if (rootWriterDisposed.value) return Promise.resolve();
    return rootWriter.dispose();
  });
  const rootBucket = await rootWriter.getR2Bucket("STORAGE", "raio");
  expect(
    (
      await request(
        rootWriter,
        rootFallbackName,
        "write",
        write(Array.from({ length: 20 }, (_, index) => document(String(index), "alpha beta"))),
      )
    ).status,
  ).toBe(200);
  const rootFallbackRootObject = await rootBucket.get(`namespaces/${rootFallbackName}/root.json`);
  if (rootFallbackRootObject === null) throw new Error("Missing root fallback manifest");
  const rootFallbackRoot = decodeRoot(await rootFallbackRootObject.text());
  const rootFallbackSegment = rootFallbackRoot.segments[0];
  const alphaSummary = rootFallbackSegment?.commonTerms?.alpha;
  const betaSummary = rootFallbackSegment?.commonTerms?.beta;
  if (rootFallbackSegment === undefined || alphaSummary === undefined || betaSummary === undefined)
    throw new Error("Missing root fallback term facts");
  await rootBucket.delete([
    `cache/correlated-pool-v3/${rootFallbackSegment.key}`,
    `cache/directory-v6/${rootFallbackSegment.key}/${rootFallbackSegment.headerBytes}`,
  ]);
  await rootWriter.dispose();
  rootWriterDisposed.value = true;
  const rootReader = await startWorker(rootPersistence, false, artifacts);
  cleanup.defer(() => rootReader.dispose());
  const readerBucket = await rootReader.getR2Bucket("STORAGE", "raio");
  const rootFallback = await call(
    rootFallbackName,
    { kind: "fields", fields: [] },
    [],
    [{ alpha: alphaSummary, beta: betaSummary }],
    rootReader,
    readerBucket,
  );
  expect(rootFallback.status).toBe(200);
  expect(rootFallback.headers.get("cache-control")).toBe("no-store");
  expect(rootFallback.headers.get("vary")).toBe("x-kannin-filters");
  const rootFallbackTelemetry = Schema.decodeSync(Schema.fromJsonString(CatalogTelemetry))(
    rootFallback.headers.get("x-kannin-catalog-telemetry") ?? "",
  );
  expect(rootFallbackTelemetry.fallbackDirectories).toBe(0);
  const rootFallbackBatch = Schema.decodeUnknownSync(TermCatalogBatch)(await rootFallback.json());
  expect(rootFallbackBatch.rootFallback).toBe(true);
  expect(rootFallbackBatch.catalogs[0]?.dictionary).toEqual({ alpha: alphaSummary });
  expect(rootFallbackBatch.catalogs[0]?.selection).toEqual({ kind: "minimum", minimum: [0, 0] });
  const splitPartial = await call(
    rootFallbackName,
    { kind: "fields", fields: [] },
    [],
    [{ alpha: alphaSummary }, { beta: betaSummary }],
    rootReader,
    readerBucket,
    ["alpha", "beta"],
    2,
  );
  expect(splitPartial.status).toBe(200);
  const splitPartialTelemetry = Schema.decodeSync(Schema.fromJsonString(CatalogTelemetry))(
    splitPartial.headers.get("x-kannin-catalog-telemetry") ?? "",
  );
  expect(splitPartialTelemetry.fallbackDirectories).toBeGreaterThan(0);
  const splitPartialBatch = Schema.decodeUnknownSync(TermCatalogBatch)(await splitPartial.json());
  expect(splitPartialBatch.rootFallback).toBe(false);
  expect(
    splitPartialBatch.catalogs.every(
      (catalog) => catalog.dictionary.alpha !== undefined && catalog.dictionary.beta !== undefined,
    ),
  ).toBe(true);
  expect(
    (
      await call(
        rootFallbackName,
        { kind: "fields", fields: ["group"] },
        [{ field: "group", op: "eq", value: 1 }],
        [{ alpha: alphaSummary }],
        rootReader,
        readerBucket,
      )
    ).status,
  ).toBe(400);
}, 15000);
