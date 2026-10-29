import { afterAll, expect, test } from "bun:test";
import { Clock, Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { decodeRoot, decodeVectorRebuildSnapshot } from "../src/manifest";
import {
  compareCanonicalIds,
  Metadata,
  QueryResult,
  RootMigrationResult,
  VectorRebuildCheckpointMetadata,
  VectorRebuildSnapshot,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";
import { legacyRootText, legacySnapshotText, migrationRootFacts } from "./legacy-root";

const BloomPackRead = Schema.Struct({
  key: Schema.String,
  offset: Schema.NullOr(Schema.Int),
  length: Schema.NullOr(Schema.Int),
});
const FixtureStats = Schema.Struct({
  segmentGets: Schema.Int,
  bloomPackGets: Schema.Int,
  bloomPackReads: Schema.Array(BloomPackRead),
});

async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-bloom-packs-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "bloom-pack-worker.ts")],
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
  const lifetime = cleanup.move();
  return { worker, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

async function fixtureHttp(worker: Miniflare, operation: "reset" | "stats", namespace: string) {
  const url = new URL(`/fixture/${operation}`, await worker.ready);
  url.searchParams.set("namespace", namespace);
  const response = await (async () => {
    if (operation === "reset") return fetch(url, { method: "POST" });
    return fetch(url, { method: "GET" });
  })();
  if (operation === "reset") expect(response.status).toBe(204);
  else expect(response.status).toBe(200);
  if (operation === "reset") return undefined;
  return Schema.decodeUnknownSync(FixtureStats)(await response.json());
}

const worker = await fixture();
afterAll(() => worker[Symbol.asyncDispose]());

for (const version of [3, 4] as const)
  test(`v${version} migration converts columns without rebuilding eligibility or reading Bloom columns`, async () => {
    const namespace = `bloom-migration-v${version}`;
    const checkpointId = "00000000-0000-4000-8000-000000000011";
    const rootKey = `namespaces/${namespace}/root.json`;
    const checkpointKey = `namespaces/${namespace}/vector-rebuild/${checkpointId}.json`;
    expect(
      (
        await request(
          worker.worker,
          namespace,
          "write",
          write([
            document("a", "anchor needlealpha", { group: "a" }),
            document("b", "anchor needlebeta", { group: "b" }),
          ]),
        )
      ).status,
    ).toBe(200);
    const bucket = await worker.worker.getR2Bucket("STORAGE");
    const currentObject = await bucket.get(rootKey);
    if (currentObject === null) throw new Error("Missing current Root");
    const currentRoot = decodeRoot(await currentObject.text());
    expect(currentRoot.segments).toHaveLength(1);
    expect(currentRoot.segments[0]?.eligibility).not.toBeNull();
    const checkpoint = Schema.decodeSync(VectorRebuildSnapshot)({
      root: currentRoot,
      fields: ["group"],
    });
    const expiresAt = Effect.runSync(Clock.currentTimeMillis) + 60 * 60 * 1000;
    await bucket.put(rootKey, await legacyRootText(bucket, currentRoot, version));
    await bucket.put(checkpointKey, await legacySnapshotText(bucket, checkpoint, version), {
      customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({ expiresAt }),
    });
    await worker.worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
    await fixtureHttp(worker.worker, "reset", namespace);
    const migrated = Schema.decodeUnknownSync(RootMigrationResult)(
      await (await request(worker.worker, namespace, "migrate-root", {})).json(),
    );
    expect(migrated).toMatchObject({
      version: 7,
      rootRewritten: true,
      migratedSnapshots: 1,
      expiredSnapshots: 0,
    });
    const reads = await fixtureHttp(worker.worker, "stats", namespace);
    expect(reads?.segmentGets).toBe(3);
    expect(reads?.bloomPackGets).toBe(0);
    const migratedRootObject = await bucket.get(rootKey);
    const migratedCheckpointObject = await bucket.get(checkpointKey);
    if (migratedRootObject === null || migratedCheckpointObject === null)
      throw new Error("Missing migrated Root or checkpoint");
    const migratedRoot = decodeRoot(await migratedRootObject.text());
    const migratedCheckpoint = decodeVectorRebuildSnapshot(await migratedCheckpointObject.text());
    expect(migrationRootFacts(migratedRoot)).toEqual(migrationRootFacts(currentRoot));
    expect(migratedRoot.segments.map((segment) => segment.key)).not.toEqual(
      currentRoot.segments.map((segment) => segment.key),
    );
    expect(migratedRoot.bloomPacks.map(({ segmentKeys: _segmentKeys, ...pack }) => pack)).toEqual(
      currentRoot.bloomPacks.map(({ segmentKeys: _segmentKeys, ...pack }) => pack),
    );
    expect(migratedRoot.segments.map((segment) => segment.eligibility)).toEqual(
      currentRoot.segments.map((segment) => segment.eligibility),
    );
    expect(migratedCheckpoint.fields).toEqual(checkpoint.fields);
    expect(migrationRootFacts(migratedCheckpoint.root)).toEqual(
      migrationRootFacts(checkpoint.root),
    );
    expect(migratedCheckpoint.root.segments.map((segment) => segment.eligibility)).toEqual(
      checkpoint.root.segments.map((segment) => segment.eligibility),
    );
    expect(
      Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(
        migratedCheckpointObject.customMetadata,
      ).expiresAt,
    ).toBe(expiresAt);
  });

test("covered common text skips Bloom R2 and rare terms reuse the cached term column", async () => {
  const namespace = "bloom-column-reuse";
  expect(
    (
      await request(
        worker.worker,
        namespace,
        "write",
        write([document("a", "anchor needlealpha"), document("b", "anchor needlebeta")]),
      )
    ).status,
  ).toBe(200);
  const bucket = await worker.worker.getR2Bucket("STORAGE");
  const rootObject = await bucket.get(`namespaces/${namespace}/root.json`);
  if (rootObject === null) throw new Error("Missing Root");
  const root = decodeRoot(await rootObject.text());
  expect(root.segments).toHaveLength(1);
  const segment = root.segments[0];
  if (segment === undefined) throw new Error("Missing segment");
  const pack = root.bloomPacks[segment.bloom.packIndex];
  if (pack === undefined) throw new Error("Missing Bloom pack");
  expect(Object.hasOwn(segment.commonTerms ?? {}, "anchor")).toBe(true);
  await fixtureHttp(worker.worker, "reset", namespace);

  const commonResponse = await request(worker.worker, namespace, "query", textQuery("anchor"));
  expect(commonResponse.status).toBe(200);
  expect(commonResponse.headers.get("server-timing")).toContain('text_membership;desc="manifest"');
  expect(
    Schema.decodeUnknownSync(QueryResult)(await commonResponse.json())
      .rows.map((row) => row.id)
      .toSorted(compareCanonicalIds),
  ).toEqual(["a", "b"]);
  expect((await fixtureHttp(worker.worker, "stats", namespace))?.bloomPackGets).toBe(0);

  const firstRare = await request(worker.worker, namespace, "query", textQuery("needlealpha"));
  expect(firstRare.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await firstRare.json()).rows.map((row) => row.id),
  ).toEqual(["a"]);
  const firstReads = await fixtureHttp(worker.worker, "stats", namespace);
  expect(firstReads?.bloomPackGets).toBe(1);
  expect(firstReads?.bloomPackReads).toEqual([
    {
      key: pack.key,
      offset: pack.term.offset,
      length: pack.term.length,
    },
  ]);

  const secondRare = await request(worker.worker, namespace, "query", textQuery("needlebeta"));
  expect(secondRare.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await secondRare.json()).rows.map((row) => row.id),
  ).toEqual(["b"]);
  const secondReads = await fixtureHttp(worker.worker, "stats", namespace);
  expect(secondReads?.bloomPackGets).toBe(1);
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker.worker, namespace, "metadata")).json(),
  );
  expect(metadata.cache.bloomCacheBytes).toBeGreaterThan(0);
  expect(metadata.cache.bloomCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

test("missing, truncated, and hash-mismatched Bloom packs fail any/all/phrase queries", async () => {
  for (const failure of ["missing", "truncated", "hash-mismatch"] as const)
    for (const match of ["any", "all", "phrase"] as const) {
      const namespace = `bloom-${failure}-${match}`;
      expect(
        (
          await request(
            worker.worker,
            namespace,
            "write",
            write([document("a", "anchor needlealpha"), document("b", "anchor needlebeta")]),
          )
        ).status,
      ).toBe(200);
      const bucket = await worker.worker.getR2Bucket("STORAGE");
      const rootObject = await bucket.get(`namespaces/${namespace}/root.json`);
      if (rootObject === null) throw new Error("Missing Root");
      const root = decodeRoot(await rootObject.text());
      const segment = root.segments[0];
      if (segment === undefined) throw new Error("Missing segment");
      const pack = root.bloomPacks[segment.bloom.packIndex];
      if (pack === undefined) throw new Error("Missing Bloom pack");
      if (failure === "missing") await bucket.delete(pack.key);
      if (failure === "truncated" || failure === "hash-mismatch") {
        const object = await bucket.get(pack.key);
        if (object === null) throw new Error("Missing Bloom pack bytes");
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (failure === "truncated")
          await bucket.put(pack.key, bytes.subarray(0, bytes.length - 1));
        else {
          bytes[pack.term.offset] = (bytes[pack.term.offset] ?? 0) ^ 0xff;
          await bucket.put(pack.key, bytes);
        }
      }
      await worker.worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
      await fixtureHttp(worker.worker, "reset", namespace);
      const response = await request(worker.worker, namespace, "query", {
        ...textQuery("needlealpha"),
        match,
      });
      expect(response.status).toBe(503);
      const reads = await fixtureHttp(worker.worker, "stats", namespace);
      expect(reads?.bloomPackGets).toBe(1);
      expect(reads?.bloomPackReads).toEqual([
        {
          key: pack.key,
          offset: pack.term.offset,
          length: pack.term.length,
        },
      ]);
      expect(reads?.segmentGets).toBe(0);
    }
});
