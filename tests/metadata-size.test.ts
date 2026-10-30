import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { decodeRoot, encodeRoot } from "../src/manifest";
import { Metadata, StoredRoot, namespaceColumnsFromNative } from "../src/protocol";
import { document, request, startWorker, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());
const rootKey = (namespace: string) => `namespaces/${namespace}/root.json`;
const vector = [1, ...Array.from({ length: 767 }, () => 0)];

async function metadataAndRoot(namespace: string) {
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const stored = await bucket.get(rootKey(namespace));
  if (stored === null) throw new Error("Missing canonical Root");
  const rootText = await stored.text();
  const expectedBytes = new TextEncoder().encode(encodeRoot(decodeRoot(rootText))).byteLength;
  const firstResponse = await request(worker, namespace, "metadata");
  expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
  const first = Schema.decodeUnknownSync(Metadata)(await firstResponse.json());
  expect(first.manifestEncodedBytes).toBe(expectedBytes);
  const repeatedResponse = await request(worker, namespace, "metadata");
  expect(repeatedResponse.status, await repeatedResponse.clone().text()).toBe(200);
  const repeated = Schema.decodeUnknownSync(Metadata)(await repeatedResponse.json());
  expect(repeated.manifestEncodedBytes).toBe(expectedBytes);
  expect(repeated.sequence).toBe(first.sequence);
  return { metadata: repeated, rootText, objectSize: stored.size };
}

test("metadata reports the canonical encoded Root size across committed mutations", async () => {
  const namespace = "metadata-size-lifecycle";
  const initialWrite = await request(worker, namespace, "write", {
    ...write([]),
    upserts: [{ id: "vector", text: "seed", attributes: {}, vector }],
  });
  expect(initialWrite.status, await initialWrite.clone().text()).toBe(200);
  const seeded = await metadataAndRoot(namespace);

  const secondWrite = await request(
    worker,
    namespace,
    "write",
    write([document("second", "compact me")]),
  );
  expect(secondWrite.status, await secondWrite.clone().text()).toBe(200);
  const afterWrite = await metadataAndRoot(namespace);
  expect(afterWrite.rootText).not.toBe(seeded.rootText);

  expect(afterWrite.metadata.vectorOutbox).toBeGreaterThan(0);
  const synced = await request(worker, namespace, "vector-sync", {});
  expect(synced.status, await synced.clone().text()).toBe(200);
  const afterSync = await metadataAndRoot(namespace);
  expect(afterSync.metadata.sequence).toBe(afterWrite.metadata.sequence);
  expect(afterSync.metadata.vectorOutbox).toBe(0);
  expect(afterSync.rootText).not.toBe(afterWrite.rootText);

  const deleted = await request(worker, namespace, "write", write([], ["second"]));
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  const afterDelete = await metadataAndRoot(namespace);
  expect(afterDelete.rootText).not.toBe(afterSync.rootText);

  const compacted = await request(worker, namespace, "compact", {});
  expect(compacted.status, await compacted.clone().text()).toBe(200);
  const afterCompact = await metadataAndRoot(namespace);
  expect(afterCompact.rootText).not.toBe(afterDelete.rootText);
  expect(afterCompact.metadata.segments).toBe(1);

  const reset = await request(worker, namespace, "write", { ...write([]), reset: true });
  expect(reset.status, await reset.clone().text()).toBe(200);
  const afterReset = await metadataAndRoot(namespace);
  expect(afterReset.rootText).not.toBe(afterCompact.rootText);
  expect(afterReset.metadata.documents).toBe(0);
  expect(afterReset.metadata.segments).toBe(0);
  expect(seeded.metadata.documents).toBe(1);
});

test("metadata recomputes canonical UTF-8 size after Root formatting and Durable Object reboot", async () => {
  const namespace = "metadata-size-unicode-reboot";
  const identifier = "文書-🦊-é";
  const created = await request(worker, namespace, "write", {
    ...write([]),
    requestId: "metadata-unicode-🦊",
    upserts: [document(identifier, "unicode root size")],
  });
  expect(created.status, await created.clone().text()).toBe(200);
  await metadataAndRoot(namespace);

  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const key = rootKey(namespace);
  const stored = await bucket.get(key);
  if (stored === null) throw new Error("Missing canonical Root");
  const decoded = decodeRoot(await stored.text());
  const encoded = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(encodeRoot(decoded));
  const prettyRoot = JSON.stringify(encoded, null, 2);
  const replacement = await bucket.put(key, prettyRoot, { onlyIf: { etagMatches: stored.etag } });
  expect(replacement).not.toBeNull();
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });

  const restored = await metadataAndRoot(namespace);
  const canonicalRoot = encodeRoot(decodeRoot(restored.rootText));
  const canonicalBytes = new TextEncoder().encode(canonicalRoot).byteLength;
  expect(canonicalRoot).toContain(identifier);
  expect(canonicalRoot).toContain("🦊");
  expect(canonicalBytes).toBeGreaterThan(canonicalRoot.length);
  expect(restored.objectSize).not.toBe(canonicalBytes);
  expect(restored.metadata.manifestEncodedBytes).toBe(canonicalBytes);
  const rebuilt = await request(worker, namespace, "rebuild", {});
  expect(rebuilt.status, await rebuilt.clone().text()).toBe(200);
  const afterRebuild = await metadataAndRoot(namespace);
  expect(afterRebuild.metadata.manifestEncodedBytes).toBe(canonicalBytes);
});

test("metadata reloads canonical size after a stale Root ETag rejects a write", async () => {
  const namespace = "metadata-size-cas";
  const created = await request(worker, namespace, "write", write([document("before", "seed")]));
  expect(created.status, await created.clone().text()).toBe(200);
  const before = await metadataAndRoot(namespace);
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const key = rootKey(namespace);
  const stored = await bucket.get(key);
  if (stored === null) throw new Error("Missing canonical Root");
  const oldRoot = decodeRoot(await stored.text());
  const changedRoot = decodeRoot(
    encodeRoot({
      ...oldRoot,
      schema: namespaceColumnsFromNative({ filterable: ["group"], vectorFilterFields: [] }),
    }),
  );
  const replaced = await bucket.put(key, encodeRoot(changedRoot), {
    onlyIf: { etagMatches: stored.etag },
  });
  expect(replaced).not.toBeNull();

  const staleWrite = await request(
    worker,
    namespace,
    "write",
    write([document("after", "rejected by CAS")]),
  );
  expect(staleWrite.status, await staleWrite.clone().text()).toBe(409);

  const after = await metadataAndRoot(namespace);
  const canonicalBytes = new TextEncoder().encode(encodeRoot(changedRoot)).byteLength;
  expect(after.metadata.sequence).toBe(before.metadata.sequence);
  expect(after.metadata.manifestEncodedBytes).toBe(canonicalBytes);
  expect(after.metadata.manifestEncodedBytes).not.toBe(before.metadata.manifestEncodedBytes);
  expect(decodeRoot(after.rootText)).toEqual(changedRoot);
});
