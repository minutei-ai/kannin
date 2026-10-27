import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Metadata, QueryResult, StoredRoot } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const worker = await startWorker();
afterAll(() => worker.dispose());

async function prefix(namespace: string) {
  return `namespaces/${namespace}`;
}

test("R2 manifest repairs a lost receipt without committing the write twice", async () => {
  const input = write([document("after", "durable")]);
  expect((await request(worker, "lost-receipt", "write", input)).status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const namespacePrefix = await prefix("lost-receipt");
  const receipts = (await bucket.list({ prefix: `${namespacePrefix}/receipts/` })).objects;
  expect(receipts.length).toBe(1);
  const receipt = receipts[0];
  if (receipt === undefined) throw new Error("Missing committed receipt");
  await bucket.delete(receipt.key);
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: "lost-receipt" });
  expect((await request(worker, "lost-receipt", "write", input)).status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "lost-receipt", "query", textQuery("durable"))).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["after"]);
  expect(result.sequence).toBe(1);
});

test("unreferenced R2 objects never become visible", async () => {
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  await bucket.put(`${await prefix("orphan")}/segments/orphan.rsix`, "not a committed segment");
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "orphan", "metadata")).json())
      .documents,
  ).toBe(0);
});

test("a stale manifest ETag rejects the commit and its segment stays invisible", async () => {
  await request(worker, "cas", "write", write([document("a", "before")]));
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const rootKey = `${await prefix("cas")}/root.json`;
  const current = await bucket.get(rootKey);
  if (current === null) throw new Error("Missing R2 root");
  const root = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(await current.text());
  const racingRoot = StoredRoot.mapFields((fields) => ({
    ...fields,
    testRace: Schema.Boolean,
  }));
  await bucket.put(
    rootKey,
    Schema.encodeSync(Schema.fromJsonString(racingRoot))({ ...root, testRace: true }),
  );
  const input = write([document("b", "after")]);
  expect((await request(worker, "cas", "write", input)).status).toBe(409);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "cas", "metadata")).json())
      .sequence,
  ).toBe(1);
  expect((await request(worker, "cas", "write", input)).status).toBe(200);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "cas", "metadata")).json())
      .documents,
  ).toBe(2);
});

test("long histories reload from the R2 manifest without a local database", async () => {
  for (const index of Array.from({ length: 70 }, (_, ordinal) => ordinal))
    expect(
      (await request(worker, "long", "write", write([document(String(index), "history")]))).status,
    ).toBe(200);
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: "long" });
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "long", "metadata")).json(),
  );
  expect(metadata.sequence).toBe(70);
  expect(metadata.documents).toBe(70);
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "long", "query", textQuery("history"))).json(),
  );
  expect(result.rows.length).toBe(10);
});

test("a missing committed segment fails closed on cold read", async () => {
  await request(worker, "missing", "write", write([document("a", "term")]));
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const objects = (await bucket.list({ prefix: `${await prefix("missing")}/segments/` })).objects;
  const segment = objects[0];
  if (segment === undefined) throw new Error("Missing committed segment");
  await bucket.delete(segment.key);
  expect((await request(worker, "missing", "query", textQuery("term"))).status).toBe(503);
});

test("a missing manifest never silently resets an acknowledged namespace", async () => {
  await request(worker, "missing-root", "write", write([document("a", "acknowledged")]));
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  await bucket.delete(`${await prefix("missing-root")}/root.json`);
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: "missing-root" });
  expect((await request(worker, "missing-root", "metadata")).status).toBe(503);
  expect(
    (await request(worker, "missing-root", "write", write([document("b", "replacement")]))).status,
  ).toBe(503);
});

test("a full workerd restart restores records using only R2", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "raio-restart-"));
  const first = await startWorker(persistence);
  await request(
    first,
    "restart",
    "write",
    write([document("a", "persistent rust", { source: "r2" })]),
  );
  await first.dispose();
  const second = await startWorker(persistence);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(second, "restart", "query", textQuery("persistent"))).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["a"]);
  expect(found.rows[0]?.attributes).toEqual({ source: "r2" });
  await second.dispose();
  await rm(persistence, { recursive: true, force: true });
});
