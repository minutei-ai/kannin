import { decodeRoot, decodeRootForMigration, decodeVectorRebuildSnapshot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Metadata,
  QueryResult,
  Root,
  RootMigrationResult,
  VectorRebuildResult,
  VectorRebuildSnapshot,
  VectorRebuildCheckpointMetadata,
} from "../src/protocol";
import { request, startWorker, write, document } from "./harness";
import { legacyRootText, legacySnapshotText, migrationRootFacts } from "./legacy-root";
import { ageRetirementUploads, retentionFixture } from "./retention-fixture";

const worker = await startWorker();
afterAll(() => worker.dispose());
const bucketFor = () => worker.getR2Bucket("STORAGE", "raio");
const rootKey = (namespace: string) => `namespaces/${namespace}/root.json`;
const checkpointKey = (namespace: string, snapshot: string) =>
  `namespaces/${namespace}/vector-rebuild/${snapshot}.json`;
const vector = [1, ...Array.from({ length: 767 }, () => 0)];
const vectorQuery = { kind: "vector", vector, topK: 10, filters: [] };
test("migration never infers a v5 checkpoint expiry from its upload age", async () => {
  await using fixture = await retentionFixture();
  const scopedWorker = fixture.worker;
  const namespace = "root-migration-required-expiry";
  expect(
    (await request(scopedWorker, namespace, "write", write([document("a", "retained")]))).status,
  ).toBe(200);
  const bucket = await scopedWorker.getR2Bucket("STORAGE", "raio");
  const current = await bucket.get(rootKey(namespace));
  if (current === null) throw new Error("Missing fixture Root");
  const logical = decodeRoot(await current.text());
  const key = checkpointKey(namespace, "00000000-0000-4000-8000-0000000000e5");
  const checkpoint = await bucket.put(
    key,
    await legacySnapshotText(bucket, { root: logical, fields: [] }, 5),
  );
  if (checkpoint === null) throw new Error("Missing fixture checkpoint");
  await ageRetirementUploads(scopedWorker, namespace);
  const response = await request(scopedWorker, namespace, "migrate-root", {});
  expect(response.status).toBe(503);
  expect((await bucket.head(key))?.etag).toBe(checkpoint.etag);
  expect((await bucket.head(rootKey(namespace)))?.etag).toBe(current.etag);
});

test("collection rejects a live legacy checkpoint before retiring any objects", async () => {
  const namespace = "collection-legacy-checkpoint";
  expect(
    (await request(worker, namespace, "write", write([document("a", "retained")]))).status,
  ).toBe(200);
  const bucket = await bucketFor();
  const current = await bucket.get(rootKey(namespace));
  if (current === null) throw new Error("Missing current Root");
  const root = decodeRoot(await current.text());
  const key = checkpointKey(namespace, "00000000-0000-4000-8000-0000000000c1");
  const checkpoint = await bucket.put(
    key,
    await legacySnapshotText(bucket, { root, fields: [] }, 1),
    {
      customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }),
    },
  );
  if (checkpoint === null) throw new Error("Missing legacy checkpoint");
  const before = await bucket.list({ prefix: `namespaces/${namespace}/segments/`, limit: 1000 });
  expect((await request(worker, namespace, "collect", {})).status).toBe(503);
  const after = await bucket.list({ prefix: `namespaces/${namespace}/segments/`, limit: 1000 });
  expect(after.objects.map((object) => [object.key, object.etag])).toEqual(
    before.objects.map((object) => [object.key, object.etag]),
  );
  expect((await bucket.list({ prefix: `namespaces/${namespace}/retired/` })).objects).toEqual([]);
  expect((await bucket.head(key))?.etag).toBe(checkpoint.etag);
});

test("migrates pooled Root and rebuild checkpoint without changing logical reads or expiry", async () => {
  const namespace = "root-migration-complete";
  const upserts = Array.from({ length: 205 }, (_, index) => ({
    id: String(index).padStart(3, "0"),
    text: "lexical",
    attributes: { group: "all" },
    vector,
  }));
  expect((await request(worker, namespace, "write", { ...write([]), upserts })).status).toBe(200);
  expect((await request(worker, namespace, "vector-sync", {})).status).toBe(200);
  const beforeQuery = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", vectorQuery)).json(),
  );
  const first = Schema.decodeUnknownSync(VectorRebuildResult)(
    await (await request(worker, namespace, "vector-rebuild", {})).json(),
  );
  expect(first.complete).toBe(false);
  if (first.snapshot === null) throw new Error("Missing rebuild checkpoint");
  const bucket = await bucketFor();
  const currentRoot = await bucket.get(rootKey(namespace));
  const currentCheckpoint = await bucket.get(checkpointKey(namespace, first.snapshot));
  if (currentRoot === null || currentCheckpoint === null)
    throw new Error("Missing migration input");
  const logicalRoot = decodeRoot(await currentRoot.text());
  const logicalSnapshot = decodeVectorRebuildSnapshot(await currentCheckpoint.text());
  const segmentEtags = await Promise.all(
    logicalRoot.segments.map(async (segment) => ({
      key: segment.key,
      etag: (await bucket.head(segment.key))?.etag,
    })),
  );
  const legacyText = await legacyRootText(bucket, logicalRoot, 1);
  const legacySnapshot = await legacySnapshotText(bucket, logicalSnapshot, 1);
  const legacyInput = decodeRootForMigration(legacyText);
  const legacyEtags = await Promise.all(
    legacyInput.root.segments.map(async (segment) => ({
      key: segment.key,
      etag: (await bucket.head(segment.key))?.etag,
    })),
  );
  await bucket.put(rootKey(namespace), legacyText);
  await bucket.put(checkpointKey(namespace, first.snapshot), legacySnapshot);
  const legacyCheckpoint = await bucket.head(checkpointKey(namespace, first.snapshot));
  if (legacyCheckpoint === null) throw new Error("Missing legacy checkpoint");
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  expect((await request(worker, namespace, "query", vectorQuery)).status).toBe(503);
  expect((await request(worker, namespace, "collect", {})).status).toBe(503);
  expect((await bucket.list({ prefix: `namespaces/${namespace}/retired/` })).objects).toEqual([]);

  const migrated = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, namespace, "migrate-root", {})).json(),
  );
  expect(migrated).toEqual({
    version: 7,
    sequence: logicalRoot.sequence,
    rootRewritten: true,
    migratedSnapshots: 1,
    expiredSnapshots: 0,
  });
  const migratedRoot = await bucket.get(rootKey(namespace));
  const migratedCheckpoint = await bucket.get(checkpointKey(namespace, first.snapshot));
  if (migratedRoot === null || migratedCheckpoint === null)
    throw new Error("Missing migrated data");
  const expandedRoot = decodeRoot(await migratedRoot.text());
  expect(migrationRootFacts(expandedRoot)).toEqual(migrationRootFacts(logicalRoot));
  expect(
    await Promise.all(
      logicalRoot.segments.map(async (segment) => ({
        key: segment.key,
        etag: (await bucket.head(segment.key))?.etag,
      })),
    ),
  ).toEqual(segmentEtags);
  expect(expandedRoot.segments.map((segment) => segment.key)).not.toEqual(
    legacyInput.root.segments.map((segment) => segment.key),
  );
  expect(
    await Promise.all(
      legacyInput.root.segments.map(async (segment) => ({
        key: segment.key,
        etag: (await bucket.head(segment.key))?.etag,
      })),
    ),
  ).toEqual(legacyEtags);
  expect(
    expandedRoot.segments.every(
      (segment) =>
        segment.metadataEnd >= segment.headerBytes && segment.metadataEnd <= segment.bytes,
    ),
  ).toBe(true);
  const expandedSnapshot = decodeVectorRebuildSnapshot(await migratedCheckpoint.text());
  expect(expandedSnapshot.fields).toEqual(logicalSnapshot.fields);
  expect(migrationRootFacts(expandedSnapshot.root)).toEqual(
    migrationRootFacts(logicalSnapshot.root),
  );
  expect(
    Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(migratedCheckpoint.customMetadata)
      .expiresAt,
  ).toBe(legacyCheckpoint.uploaded.getTime() + 7 * 24 * 60 * 60 * 1000);
  const afterQuery = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", vectorQuery)).json(),
  );
  expect(afterQuery).toEqual(beforeQuery);
  const resumed = Schema.decodeUnknownSync(VectorRebuildResult)(
    await (
      await request(worker, namespace, "vector-rebuild", {
        snapshot: first.snapshot,
        segment: first.segment,
        row: first.row,
      })
    ).json(),
  );
  expect(resumed.submitted).toBe(100);
  const rootEtag = migratedRoot.etag;
  expect(
    Schema.decodeUnknownSync(RootMigrationResult)(
      await (await request(worker, namespace, "migrate-root", {})).json(),
    ).rootRewritten,
  ).toBe(false);
  expect((await bucket.head(rootKey(namespace)))?.etag).toBe(rootEtag);
});

test("partial migration keeps the legacy Root and preserves already converted checkpoints on retry", async () => {
  const namespace = "root-migration-partial";
  expect((await request(worker, namespace, "write", write([document("a", "legacy")]))).status).toBe(
    200,
  );
  const bucket = await bucketFor();
  const rootObject = await bucket.get(rootKey(namespace));
  if (rootObject === null) throw new Error("Missing Root");
  const root = decodeRoot(await rootObject.text());
  const legacyText = await legacyRootText(bucket, root, 1);
  const saved = Schema.decodeSync(VectorRebuildSnapshot)({ root, fields: ["group"] });
  const validLegacySnapshot = await legacySnapshotText(bucket, saved, 1);
  const alphaKey = checkpointKey(namespace, "00000000-0000-4000-8000-000000000001");
  const betaKey = checkpointKey(namespace, "00000000-0000-4000-8000-000000000002");
  await bucket.put(rootKey(namespace), legacyText);
  await bucket.put(alphaKey, validLegacySnapshot);
  await bucket.put(betaKey, "{}");
  const alphaBefore = await bucket.head(alphaKey);
  if (alphaBefore === null) throw new Error("Missing first checkpoint");
  const failed = await request(worker, namespace, "migrate-root", {});
  expect(failed.status).toBe(503);
  expect(await (await bucket.get(rootKey(namespace)))?.text()).toBe(legacyText);
  const alphaConverted = await bucket.get(alphaKey);
  if (alphaConverted === null) throw new Error("Missing converted checkpoint");
  const alphaSnapshot = decodeVectorRebuildSnapshot(await alphaConverted.text());
  expect(alphaSnapshot.fields).toEqual(saved.fields);
  expect(migrationRootFacts(alphaSnapshot.root)).toEqual(migrationRootFacts(saved.root));
  const alphaExpiry = Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(
    alphaConverted.customMetadata,
  ).expiresAt;
  expect(alphaExpiry).toBe(alphaBefore.uploaded.getTime() + 7 * 24 * 60 * 60 * 1000);

  await bucket.put(betaKey, validLegacySnapshot);
  const completed = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, namespace, "migrate-root", {})).json(),
  );
  expect(completed.rootRewritten).toBe(true);
  expect(completed.migratedSnapshots).toBe(1);
  const completedRoot = await bucket.get(rootKey(namespace));
  if (completedRoot === null) throw new Error("Missing completed Root");
  expect(migrationRootFacts(decodeRoot(await completedRoot.text()))).toEqual(
    migrationRootFacts(root),
  );
  expect((await bucket.head(alphaKey))?.etag).toBe(alphaConverted.etag);
  const retainedAlpha = await bucket.get(alphaKey);
  if (retainedAlpha === null) throw new Error("Missing retained checkpoint");
  expect(
    Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(retainedAlpha.customMetadata)
      .expiresAt,
  ).toBe(alphaExpiry);
});

test("migration expires already-expired v2 checkpoints and distinguishes absent acknowledged Roots", async () => {
  const emptyNamespace = "root-migration-empty";
  const empty = await request(worker, emptyNamespace, "migrate-root", {});
  expect(empty.status).toBe(200);
  expect(await (await bucketFor()).head(rootKey(emptyNamespace))).toBeNull();
  const emptyRoot = Schema.decodeSync(Root)({
    version: 1,
    sequence: 0,
    head: null,
    documents: 0,
    titleLength: 0,
    bodyLength: 0,
    vectorEpoch: "empty-checkpoint-epoch",
    vectorJobs: [],
    lastReceipt: null,
    bloomPacks: [],
    segments: [],
  });
  const emptySnapshot = Schema.decodeSync(VectorRebuildSnapshot)({ root: emptyRoot, fields: [] });
  const emptyCheckpointKey = checkpointKey(emptyNamespace, "00000000-0000-4000-8000-000000000004");
  const emptyBucket = await bucketFor();
  await emptyBucket.put(
    emptyCheckpointKey,
    await legacySnapshotText(emptyBucket, emptySnapshot, 1),
  );
  const migratedEmpty = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, emptyNamespace, "migrate-root", {})).json(),
  );
  expect(migratedEmpty).toMatchObject({ rootRewritten: false, migratedSnapshots: 1 });
  expect(await emptyBucket.head(rootKey(emptyNamespace))).toBeNull();
  const migratedEmptyCheckpoint = await emptyBucket.get(emptyCheckpointKey);
  if (migratedEmptyCheckpoint === null) throw new Error("Missing rootless rebuild checkpoint");
  expect(decodeVectorRebuildSnapshot(await migratedEmptyCheckpoint.text())).toEqual(emptySnapshot);

  const acknowledgedNamespace = "root-migration-missing-ack";
  expect(
    (await request(worker, acknowledgedNamespace, "write", write([document("a", "acknowledged")])))
      .status,
  ).toBe(200);
  const bucket = await bucketFor();
  await bucket.delete(rootKey(acknowledgedNamespace));
  expect((await request(worker, acknowledgedNamespace, "migrate-root", {})).status).toBe(503);
  expect(await bucket.head(rootKey(acknowledgedNamespace))).toBeNull();

  const expiredNamespace = "root-migration-expired-checkpoint";
  expect(
    (await request(worker, expiredNamespace, "write", write([document("a", "expired")]))).status,
  ).toBe(200);
  const expiredRootObject = await bucket.get(rootKey(expiredNamespace));
  if (expiredRootObject === null) throw new Error("Missing current Root");
  const expiredRoot = decodeRoot(await expiredRootObject.text());
  const expiredKey = checkpointKey(expiredNamespace, "00000000-0000-4000-8000-000000000003");
  const expiredSnapshot = Schema.decodeSync(VectorRebuildSnapshot)({
    root: expiredRoot,
    fields: ["group"],
  });
  const expiredLegacySnapshot = await legacySnapshotText(bucket, expiredSnapshot, 2);
  await bucket.put(expiredKey, expiredLegacySnapshot, {
    customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({ expiresAt: 0 }),
  });
  const expiredResult = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, expiredNamespace, "migrate-root", {})).json(),
  );
  expect(expiredResult.rootRewritten).toBe(false);
  expect(expiredResult.expiredSnapshots).toBe(1);
  expect(await bucket.head(expiredKey)).toBeNull();
  expect((await bucket.head(rootKey(expiredNamespace)))?.etag).toBe(expiredRootObject.etag);
});

test("v5 roots become column declarations without rewriting segments, logs, or receipts", async () => {
  const namespace = "root-schema-v5";
  const native = {
    filterable: ["vector", "title", "text"],
    vectorFilterFields: ["text", "vector"],
  };
  const input = {
    requestId: "seed",
    schema: native,
    upserts: [
      {
        id: "one",
        title: "native heading",
        text: "native body",
        attributes: {
          vector: "metadata-vector",
          title: "metadata-title",
          text: "metadata-text",
        },
        vector,
      },
    ],
    deletes: [],
  };
  expect((await request(worker, namespace, "write", input)).status).toBe(200);
  const bucket = await bucketFor();
  const current = await bucket.get(rootKey(namespace));
  if (current === null) throw new Error("Missing current Root");
  const logical = decodeRoot(await current.text());
  const etags = await Promise.all(
    logical.segments.map(async (segment) => ({
      key: segment.key,
      etag: (await bucket.head(segment.key))?.etag,
    })),
  );
  const logKey = logical.head;
  if (logKey === null) throw new Error("Missing write log");
  const log = await bucket.get(logKey);
  const receiptKey = `namespaces/${namespace}/receipts/`;
  const receiptsBefore = await bucket.list({ prefix: receiptKey });
  if (log === null) throw new Error("Missing immutable log");
  const logBytes = new Uint8Array(await log.arrayBuffer());
  const expiresAt = 9_000_000_000_000;
  const snapshotId = "00000000-0000-4000-8000-0000000000a5";
  await bucket.put(rootKey(namespace), await legacyRootText(bucket, logical, 5));
  await bucket.put(
    checkpointKey(namespace, snapshotId),
    await legacySnapshotText(bucket, { root: logical, fields: ["text", "vector"] }, 5),
    { customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({ expiresAt }) },
  );
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  expect((await request(worker, namespace, "query", vectorQuery)).status).toBe(503);
  const migrated = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, namespace, "migrate-root", {})).json(),
  );
  expect(migrated).toMatchObject({
    version: 7,
    sequence: logical.sequence,
    rootRewritten: true,
    migratedSnapshots: 1,
    expiredSnapshots: 0,
  });
  const stored = await bucket.get(rootKey(namespace));
  const checkpoint = await bucket.get(checkpointKey(namespace, snapshotId));
  const retainedLog = await bucket.get(logKey);
  if (stored === null || checkpoint === null || retainedLog === null)
    throw new Error("Missing migrated schema");
  expect(decodeRoot(await stored.text()).schema).toEqual(logical.schema);
  expect(new Uint8Array(await retainedLog.arrayBuffer())).toEqual(logBytes);
  expect(await bucket.list({ prefix: receiptKey })).toEqual(receiptsBefore);
  expect(
    await Promise.all(
      logical.segments.map(async (segment) => ({
        key: segment.key,
        etag: (await bucket.head(segment.key))?.etag,
      })),
    ),
  ).toEqual(etags);
  const decodedCheckpoint = decodeVectorRebuildSnapshot(await checkpoint.text());
  expect(decodedCheckpoint.fields).toEqual(["text", "vector"]);
  expect(decodedCheckpoint.root.schema).toEqual(logical.schema);
  expect(
    Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(checkpoint.customMetadata).expiresAt,
  ).toBe(expiresAt);
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(metadata.schema).toEqual(native);
  expect(JSON.stringify(metadata.schema)).not.toContain("vectorDimensions");
  expect((await request(worker, namespace, "write", input)).status).toBe(200);
  const replayed = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(replayed.sequence).toBe(logical.sequence);
  expect(replayed.schema).toEqual(native);
  const repeated = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await request(worker, namespace, "migrate-root", {})).json(),
  );
  expect(repeated).toMatchObject({ version: 7, rootRewritten: false, migratedSnapshots: 0 });
  expect((await bucket.head(logKey))?.etag).toBe(log.etag);
});
