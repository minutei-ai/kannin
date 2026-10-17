import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CollectionResult,
  QueryResult,
  Retirement,
  Root,
  VectorRebuildResult,
} from "../src/protocol";
import { document, request, textQuery, write } from "./harness";
import { ageRetirementUploads, retentionFixture } from "./retention-fixture";

const fixture = await retentionFixture();
const worker = fixture.worker;
afterAll(() => fixture[Symbol.asyncDispose]());

async function collect(namespace: string) {
  const response = await request(worker, namespace, "collect", {});
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(CollectionResult)(await response.json());
}

async function mature(namespace: string) {
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const markers = await bucket.list({ prefix: `namespaces/${namespace}/retired/` });
  await ageRetirementUploads(worker, namespace);
  for (const marker of markers.objects) {
    const object = await bucket.get(marker.key);
    if (object === null) throw new Error("Missing retirement marker");
    const saved = Schema.decodeSync(Schema.fromJsonString(Retirement))(await object.text());
    await bucket.put(
      marker.key,
      Schema.encodeSync(Schema.fromJsonString(Retirement))({
        ...saved,
        observedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
  }
}

test("collection starts grace after retirement and preserves scores after physical deletion", async () => {
  for (const index of [0, 1, 2])
    await request(worker, "retire", "write", write([document(String(index), "rust search")]));
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "retire", "query", textQuery("rust"))).json(),
  );
  await request(worker, "retire", "compact", {});
  expect(await collect("retire")).toMatchObject({ scanned: 4, pinned: 1, marked: 3, deleted: 0 });
  expect(await collect("retire")).toMatchObject({ marked: 0, deleted: 0 });
  await mature("retire");
  expect(await collect("retire")).toMatchObject({ deleted: 3, pinned: 1 });
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: "retire" });
  expect(
    Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "retire", "query", textQuery("rust"))).json(),
    ),
  ).toEqual(before);
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  expect((await bucket.list({ prefix: "namespaces/retire/receipts/" })).objects.length).toBe(3);
  expect((await bucket.list({ prefix: "namespaces/retire/log/" })).objects.length).toBe(3);
});

test("in-progress vector checkpoints pin retired segments across compaction", async () => {
  const vector = [1, ...Array.from({ length: 767 }, () => 0)];
  await request(
    worker,
    "checkpoint-pin",
    "write",
    write(
      Array.from({ length: 101 }, (_, index) => ({
        ...document(String(index), "rust"),
        vector,
      })),
    ),
  );
  await request(worker, "checkpoint-pin", "write", write([document("other", "rust")]));
  const cursor = Schema.decodeUnknownSync(VectorRebuildResult)(
    await (await request(worker, "checkpoint-pin", "vector-rebuild", {})).json(),
  );
  expect(cursor.complete).toBe(false);
  await request(worker, "checkpoint-pin", "compact", {});
  expect(await collect("checkpoint-pin")).toMatchObject({ scanned: 3, pinned: 3, marked: 0 });
  expect(
    (
      await request(worker, "checkpoint-pin", "vector-rebuild", {
        snapshot: cursor.snapshot,
        segment: cursor.segment,
        row: cursor.row,
      })
    ).status,
  ).toBe(200);
});

test("a current segment cancels even an already mature retirement marker", async () => {
  await request(worker, "repin", "write", write([document("a", "safe")]));
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const rootObject = await bucket.get("namespaces/repin/root.json");
  if (rootObject === null) throw new Error("Missing manifest");
  const root = Schema.decodeSync(Schema.fromJsonString(Root))(await rootObject.text());
  const segment = root.segments[0];
  if (segment === undefined) throw new Error("Missing segment");
  const object = await bucket.head(segment.key);
  if (object === null) throw new Error("Missing segment object");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(segment.key));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await bucket.put(
    `namespaces/repin/retired/${hash}.json`,
    Schema.encodeSync(Schema.fromJsonString(Retirement))({
      key: segment.key,
      etag: object.etag,
      observedAt: 0,
    }),
  );
  expect(await collect("repin")).toMatchObject({ pinned: 1, deleted: 0 });
  expect(await bucket.head(segment.key)).not.toBeNull();
  expect((await bucket.list({ prefix: "namespaces/repin/retired/" })).objects).toEqual([]);
});

test("replacement of an orphan resets its grace instead of deleting a new object", async () => {
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const key = "namespaces/replaced/segments/orphan.rsix";
  await bucket.put(key, "old");
  expect(await collect("replaced")).toMatchObject({ marked: 1 });
  await mature("replaced");
  await bucket.put(key, "new");
  expect(await collect("replaced")).toMatchObject({ deleted: 0, marked: 1 });
  expect(await (await bucket.get(key))?.text()).toBe("new");
});

test("identical orphan replacement restarts retirement even when its ETag is unchanged", async () => {
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const key = "namespaces/same-etag/segments/orphan.rsix";
  const original = await bucket.put(key, "identical");
  expect(await collect("same-etag")).toMatchObject({ marked: 1 });
  await mature("same-etag");
  const replacement = await bucket.put(key, "identical");
  if (original === null || replacement === null) throw new Error("Missing uploaded orphan");
  expect(replacement.etag).toBe(original.etag);
  expect(replacement.version).not.toBe(original.version);
  expect(replacement.uploaded.getTime()).toBeGreaterThan(original.uploaded.getTime());
  expect(await collect("same-etag")).toMatchObject({ deleted: 0, marked: 1 });
  expect(await (await bucket.get(key))?.text()).toBe("identical");
});

test("collection rejects ignored inputs and missing committed roots", async () => {
  expect((await request(worker, "invalid-gc", "collect", { force: true })).status).toBe(400);
  await request(worker, "missing-gc", "write", write([document("a", "committed")]));
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  await bucket.delete("namespaces/missing-gc/root.json");
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: "missing-gc" });
  expect((await request(worker, "missing-gc", "collect", {})).status).toBe(503);
  expect((await bucket.list({ prefix: "namespaces/missing-gc/retired/" })).objects).toEqual([]);
});

test("collection pages the native R2 listing without skipping candidates", async () => {
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  await Promise.all(
    Array.from({ length: 107 }, (_, index) =>
      bucket.put(`namespaces/paged-gc/segments/${String(index).padStart(3, "0")}.rsix`, "orphan"),
    ),
  );
  const first = await collect("paged-gc");
  expect(first.scanned).toBe(100);
  expect(first.marked).toBe(100);
  expect(first.cursor).not.toBeNull();
  const second = Schema.decodeUnknownSync(CollectionResult)(
    await (await request(worker, "paged-gc", "collect", { cursor: first.cursor })).json(),
  );
  expect(second).toMatchObject({ scanned: 7, marked: 7, cursor: null });
  await mature("paged-gc");
  const deleted = await collect("paged-gc");
  expect(deleted.deleted).toBe(100);
  const last = Schema.decodeUnknownSync(CollectionResult)(
    await (await request(worker, "paged-gc", "collect", { cursor: deleted.cursor })).json(),
  );
  expect(last).toMatchObject({ deleted: 7, cursor: null });
  expect((await bucket.list({ prefix: "namespaces/paged-gc/segments/" })).objects).toEqual([]);
});
