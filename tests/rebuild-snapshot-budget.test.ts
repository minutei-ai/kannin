import { afterAll, expect, test } from "bun:test";
import { Clock, Effect, Schema } from "effect";
import { decodeRoot, encodeRoot } from "../src/manifest";
import {
  ErrorBody,
  VECTOR_REBUILD_CHECKPOINT_BYTES,
  VectorRebuildCheckpointMetadata,
} from "../src/protocol";
import { document, request, startWorker, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("oversized current checkpoint creation fails before publishing its identity", async () => {
  const namespace = "checkpoint-create-budget";
  expect((await request(worker, namespace, "write", write([document("a", "stored")]))).status).toBe(
    200,
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootKey = `namespaces/${namespace}/root.json`;
  const original = await bucket.get(rootKey);
  if (original === null) throw new Error("Missing current Root");
  const root = decodeRoot(await original.text());
  await bucket.put(
    rootKey,
    encodeRoot(
      Object.assign({}, root, {
        head: "x".repeat(VECTOR_REBUILD_CHECKPOINT_BYTES),
      }),
    ),
  );
  const padded = await bucket.head(rootKey);
  if (padded === null) throw new Error("Missing oversized Root fixture");
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  const response = await request(worker, namespace, "vector-rebuild", {});
  expect(response.status).toBe(503);
  expect(Schema.decodeUnknownSync(ErrorBody)(await response.json()).error).toBe(
    "Rebuild checkpoint exceeds byte budget",
  );
  expect(
    (await bucket.list({ prefix: `namespaces/${namespace}/vector-rebuild/` })).objects,
  ).toHaveLength(0);
  expect((await bucket.head(rootKey))?.etag).toBe(padded.etag);
}, 15000);

test("resuming an oversized checkpoint rejects its native object size before decoding", async () => {
  const namespace = "checkpoint-resume-budget";
  expect((await request(worker, namespace, "write", write([document("a", "stored")]))).status).toBe(
    200,
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootKey = `namespaces/${namespace}/root.json`;
  const root = await bucket.head(rootKey);
  if (root === null) throw new Error("Missing current Root");
  const snapshot = crypto.randomUUID();
  const key = `namespaces/${namespace}/vector-rebuild/${snapshot}.json`;
  const body = "x".repeat(VECTOR_REBUILD_CHECKPOINT_BYTES + 1);
  await bucket.put(key, body, {
    customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({
      expiresAt: Effect.runSync(Clock.currentTimeMillis) + 60_000,
    }),
  });
  const captured = await bucket.head(key);
  if (captured === null) throw new Error("Missing oversized checkpoint fixture");
  const response = await request(worker, namespace, "vector-rebuild", {
    snapshot,
    segment: 0,
    row: 0,
  });
  expect(response.status).toBe(503);
  expect(Schema.decodeUnknownSync(ErrorBody)(await response.json()).error).toBe(
    "Rebuild checkpoint exceeds byte budget",
  );
  expect((await bucket.head(key))?.etag).toBe(captured.etag);
  expect((await bucket.head(rootKey))?.etag).toBe(root.etag);
}, 15000);
