import { MigrationRaceArm, MigrationRaceStats } from "./root-migration-race-contract";
import { expect, test } from "bun:test";
import { Clock, Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRoot, decodeVectorRebuildSnapshot } from "../src/manifest";
import {
  Root,
  RootMigrationResult,
  LegacyStoredRootV4,
  VectorRebuildCheckpointMetadata,
  VectorRebuildSnapshot,
} from "../src/protocol";
import { document, request, startWorker, write } from "./harness";
import { legacyRootText, legacySnapshotText, migrationRootFacts } from "./legacy-root";

async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-root-migration-race-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "root-migration-race-worker.ts")],
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

const rootKey = (namespace: string) => `namespaces/${namespace}/root.json`;
const checkpointKey = (namespace: string) =>
  `namespaces/${namespace}/vector-rebuild/00000000-0000-4000-8000-000000000005.json`;
const snapshotRetentionMs = 7 * 24 * 60 * 60 * 1000;
async function armRace(
  worker: Awaited<ReturnType<typeof startWorker>>,
  namespace: string,
  key: string,
  replacement: string,
  captureAfterList = false,
) {
  const target = new URL("/fixture/arm-race", await worker.ready);
  target.searchParams.set("namespace", namespace);
  return fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(MigrationRaceArm))({
      key,
      replacement,
      phase: (() => {
        if (captureAfterList) return "capture-after-list";
        return "cas-put";
      })(),
    }),
  });
}

test("checkpoint CAS conflict preserves the external replacement and retry migrates it", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const namespace = "migration-checkpoint-race";
  expect((await request(worker, namespace, "write", write([document("a", "race")]))).status).toBe(
    200,
  );
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const currentRoot = await bucket.get(rootKey(namespace));
  if (currentRoot === null) throw new Error("Missing root");
  const root = decodeRoot(await currentRoot.text());
  const saved = Schema.decodeSync(VectorRebuildSnapshot)({ root, fields: ["group"] });
  const legacyText = await legacyRootText(bucket, root, 1);
  await bucket.put(rootKey(namespace), legacyText);
  await bucket.put(checkpointKey(namespace), await legacySnapshotText(bucket, saved, 1));
  const replacement = Schema.decodeSync(VectorRebuildSnapshot)({ root, fields: [] });
  const replacementText = await legacySnapshotText(bucket, replacement, 1);
  expect((await armRace(worker, namespace, checkpointKey(namespace), replacementText)).status).toBe(
    204,
  );

  const failed = await request(worker, namespace, "migrate-root", {});
  expect(failed.status).toBe(409);
  expect(await (await bucket.get(checkpointKey(namespace)))?.text()).toBe(replacementText);
  expect(await (await bucket.get(rootKey(namespace)))?.text()).toBe(legacyText);
  const replacementBeforeRetry = await bucket.head(checkpointKey(namespace));
  if (replacementBeforeRetry === null) throw new Error("Missing external checkpoint replacement");

  const retried = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, namespace, "migrate-root", {})).json(),
  );
  expect(retried).toMatchObject({ rootRewritten: true, migratedSnapshots: 1 });
  const migratedCheckpoint = await bucket.get(checkpointKey(namespace));
  if (migratedCheckpoint === null) throw new Error("Missing retried checkpoint");
  const migratedSnapshot = decodeVectorRebuildSnapshot(await migratedCheckpoint.text());
  expect(migratedSnapshot.fields).toEqual(replacement.fields);
  expect(migrationRootFacts(migratedSnapshot.root)).toEqual(migrationRootFacts(replacement.root));
  expect(
    Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(migratedCheckpoint.customMetadata)
      .expiresAt,
  ).toBe(replacementBeforeRetry.uploaded.getTime() + snapshotRetentionMs);
});

test("root CAS conflict keeps its external replacement and retry reuses the migrated checkpoint", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const namespace = "migration-root-race";
  expect((await request(worker, namespace, "write", write([document("a", "race")]))).status).toBe(
    200,
  );
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const currentRoot = await bucket.get(rootKey(namespace));
  if (currentRoot === null) throw new Error("Missing root");
  const root = decodeRoot(await currentRoot.text());
  const saved = Schema.decodeSync(VectorRebuildSnapshot)({ root, fields: ["group"] });
  const legacyText = await legacyRootText(bucket, root, 1);
  await bucket.put(rootKey(namespace), legacyText);
  await bucket.put(checkpointKey(namespace), await legacySnapshotText(bucket, saved, 1));
  const replacementRoot = Schema.decodeSync(Root)({ ...root, vectorEpoch: "external-root-epoch" });
  const replacementRootText = await legacyRootText(bucket, replacementRoot, 1);
  const checkpointBefore = await bucket.head(checkpointKey(namespace));
  if (checkpointBefore === null) throw new Error("Missing legacy checkpoint");
  expect((await armRace(worker, namespace, rootKey(namespace), replacementRootText)).status).toBe(
    204,
  );

  const failed = await request(worker, namespace, "migrate-root", {});
  expect(failed.status).toBe(409);
  expect(await (await bucket.get(rootKey(namespace)))?.text()).toBe(replacementRootText);
  const migratedCheckpoint = await bucket.get(checkpointKey(namespace));
  if (migratedCheckpoint === null) throw new Error("Missing converted checkpoint");
  const migratedSnapshot = decodeVectorRebuildSnapshot(await migratedCheckpoint.text());
  expect(migratedSnapshot.fields).toEqual(saved.fields);
  expect(migrationRootFacts(migratedSnapshot.root)).toEqual(migrationRootFacts(saved.root));
  const expiry = Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(
    migratedCheckpoint.customMetadata,
  ).expiresAt;
  expect(expiry).toBe(checkpointBefore.uploaded.getTime() + snapshotRetentionMs);
  const replacementObject = await bucket.head(rootKey(namespace));
  if (replacementObject === null) throw new Error("Missing external root replacement");

  const retried = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, namespace, "migrate-root", {})).json(),
  );
  expect(retried).toMatchObject({ rootRewritten: true, migratedSnapshots: 0 });
  const rewrittenRoot = await bucket.get(rootKey(namespace));
  if (rewrittenRoot === null) throw new Error("Missing rewritten root");
  expect(migrationRootFacts(decodeRoot(await rewrittenRoot.text()))).toEqual(
    migrationRootFacts(replacementRoot),
  );
  expect((await bucket.head(rootKey(namespace)))?.etag).not.toBe(replacementObject.etag);
  const retainedCheckpoint = await bucket.get(checkpointKey(namespace));
  if (retainedCheckpoint === null) throw new Error("Missing retained checkpoint");
  expect(retainedCheckpoint.etag).toBe(migratedCheckpoint.etag);
  expect(
    Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(retainedCheckpoint.customMetadata)
      .expiresAt,
  ).toBe(expiry);
});

test("checkpoint capture rejects a larger replacement after LIST before reading its body", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const namespace = "migration-captured-budget";
  expect(
    (await request(worker, namespace, "write", write([document("a", "capture budget")]))).status,
  ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const originalRoot = await bucket.get(rootKey(namespace));
  if (originalRoot === null) throw new Error("Missing capture budget Root");
  const root = decodeRoot(await originalRoot.text());
  const snapshot = Schema.decodeSync(VectorRebuildSnapshot)({ root, fields: [] });
  const key = checkpointKey(namespace);
  await bucket.put(key, await legacySnapshotText(bucket, snapshot, 4), {
    customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({
      expiresAt: Effect.runSync(Clock.currentTimeMillis) + snapshotRetentionMs,
    }),
  });
  const replacement = "x".repeat(8 * 1024 * 1024 + 1);
  expect((await armRace(worker, namespace, key, replacement, true)).status).toBe(204);
  const failed = await request(worker, namespace, "migrate-root", {});
  expect(failed.status).toBe(503);
  expect(await failed.text()).toContain("Rebuild checkpoint exceeds byte budget");
  expect((await bucket.head(rootKey(namespace)))?.etag).toBe(originalRoot.etag);
  const retained = await bucket.get(key);
  if (retained === null) throw new Error("Missing external oversized replacement");
  expect(retained.size).toBe(replacement.length);
  expect(await retained.text()).toBe(replacement);
  const statsUrl = new URL("/fixture/race-stats", await worker.ready);
  statsUrl.searchParams.set("namespace", namespace);
  const stats = await fetch(statsUrl);
  expect(stats.status).toBe(200);
  expect(Schema.decodeUnknownSync(MigrationRaceStats)(await stats.json())).toEqual({
    fired: true,
    listed: true,
    bodyReads: 0,
  });
}, 15000);

test("checkpoint conversion rejects serialized growth past eight MiB before CAS", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const namespace = "migration-converted-budget";
  expect(
    (await request(worker, namespace, "write", write([document("a", "output budget")]))).status,
  ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const originalRoot = await bucket.get(rootKey(namespace));
  if (originalRoot === null) throw new Error("Missing output budget Root");
  const root = decodeRoot(await originalRoot.text());
  const snapshot = Schema.decodeSync(VectorRebuildSnapshot)({ root, fields: [] });
  const legacyCodec = Schema.fromJsonString(
    VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV4 })),
  );
  const legacy = Schema.decodeSync(legacyCodec)(await legacySnapshotText(bucket, snapshot, 4));
  const emptyHead = { ...legacy, root: { ...legacy.root, head: "" } };
  const baseline = Schema.encodeSync(legacyCodec)(emptyHead);
  const expiresAt = Effect.runSync(Clock.currentTimeMillis) + snapshotRetentionMs;
  const metadata = Schema.encodeSync(VectorRebuildCheckpointMetadata)({ expiresAt });
  const key = checkpointKey(namespace);
  await bucket.put(key, baseline, { customMetadata: metadata });
  const measured = await request(worker, namespace, "migrate-root", {});
  expect(measured.status).toBe(200);
  const converted = await bucket.get(key);
  if (converted === null) throw new Error("Missing measured converted checkpoint");
  const convertedText = await converted.text();
  const encoder = new TextEncoder();
  const baselineBytes = encoder.encode(baseline).byteLength;
  const growth = encoder.encode(convertedText).byteLength - baselineBytes;
  expect(growth).toBeGreaterThan(1);
  const targetBytes = 8 * 1024 * 1024 - 1;
  const padded = Schema.encodeSync(legacyCodec)({
    ...emptyHead,
    root: { ...emptyHead.root, head: "x".repeat(targetBytes - baselineBytes) },
  });
  expect(encoder.encode(padded).byteLength).toBe(targetBytes);
  expect(targetBytes + growth).toBeGreaterThan(8 * 1024 * 1024);
  await bucket.put(key, padded, { customMetadata: metadata });
  const before = await bucket.head(key);
  if (before === null) throw new Error("Missing padded legacy checkpoint");
  const rejected = await request(worker, namespace, "migrate-root", {});
  expect(rejected.status).toBe(503);
  expect(await rejected.text()).toContain("Rebuild checkpoint exceeds byte budget");
  expect((await bucket.head(rootKey(namespace)))?.etag).toBe(originalRoot.etag);
  const retained = await bucket.get(key);
  if (retained === null) throw new Error("Missing rejected legacy checkpoint");
  expect(retained.etag).toBe(before.etag);
  expect(await retained.text()).toBe(padded);
  expect(
    Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(retained.customMetadata).expiresAt,
  ).toBe(expiresAt);
}, 15000);
