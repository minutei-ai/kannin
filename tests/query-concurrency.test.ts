import { decodeRoot } from "../src/manifest";
import { expect, test } from "bun:test";
import { Clock, Effect, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import { CollectionResult, Metadata, QueryResult, Retirement, WriteResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";
import { ageRetirementUploads, retentionFixture } from "./retention-fixture";

test("a blocked query preserves its captured root while writes and reads progress and collection pins its segments", async () => {
  await using fixture = await retentionFixture();
  const worker = fixture.worker;
  const backend = await worker.getWorker("vectors");
  await using cleanup = new AsyncDisposableStack();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  const gate = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      entered.resolve();
      return release.promise;
    },
  });
  cleanup.defer(() => gate.stop(true));
  cleanup.defer(() => release.resolve(new Response("released")));
  const namespace = "query-overlap";
  const vector = [1, ...Array.from({ length: 767 }, () => 0)];
  for (const index of [0, 1, 2])
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([{ ...document(String(index), "alpha old"), vector }]),
        )
      ).status,
    ).toBe(200);
  expect((await request(worker, namespace, "vector-sync", {})).status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing fixture root");
  const root = decodeRoot(await object.text());
  const capturedKeys = [
    ...root.segments.map((segment) => segment.key),
    ...root.bloomPacks.map((descriptor) => descriptor.key),
  ];
  await backend.fetch("http://fixture/pause-query", { method: "POST", body: gate.url.href });
  const blocked = request(worker, namespace, "query", {
    kind: "hybrid",
    text: "alpha",
    vector,
    topK: 10,
    filters: [],
    minimumSequence: 3,
  });
  await entered.promise;
  const mutation = request(worker, namespace, "write", {
    ...write([document("new", "beta new")]),
    reset: true,
  });
  const progress = await Effect.runPromise(
    Effect.tryPromise(() => mutation).pipe(Effect.timeoutOption("2 seconds")),
  );
  if (Option.isNone(progress)) {
    release.resolve(new Response("released"));
    await blocked;
    await mutation;
  }
  expect(Option.isSome(progress)).toBe(true);
  const written = Schema.decodeUnknownSync(WriteResult)(await (await mutation).json());
  expect(written.sequence).toBe(4);
  const current = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, namespace, "query", { ...textQuery("beta"), minimumSequence: 4 })
    ).json(),
  );
  expect(current.sequence).toBe(4);
  expect(current.rows.map((row) => row.id)).toEqual(["new"]);
  await ageRetirementUploads(worker, namespace);
  const timestamp = Effect.runSync(Clock.currentTimeMillis) - 25 * 60 * 60 * 1000;
  for (const key of capturedKeys) {
    const source = await bucket.get(key);
    if (source === null) throw new Error("Missing fixture segment");
    await bucket.put(
      `namespaces/${namespace}/retired/${createHash("sha256").update(key).digest("hex")}.json`,
      Schema.encodeSync(Schema.fromJsonString(Retirement))({
        key,
        etag: source.etag,
        observedAt: timestamp,
      }),
    );
  }
  const collection = Schema.decodeUnknownSync(CollectionResult)(
    await (await request(worker, namespace, "collect", {})).json(),
  );
  expect(collection.deleted).toBe(0);
  expect(collection.pinned).toBe(6);
  for (const key of capturedKeys) expect(await bucket.head(key)).not.toBeNull();
  release.resolve(new Response("released"));
  const captured = Schema.decodeUnknownSync(QueryResult)(await (await blocked).json());
  expect(captured.sequence).toBe(3);
  expect(captured.rows.map((row) => row.id)).toEqual(["0", "1", "2"]);
  expect(captured.rows.every((row) => row.text === "alpha old")).toBe(true);
  const retired = Schema.decodeUnknownSync(CollectionResult)(
    await (await request(worker, namespace, "collect", {})).json(),
  );
  expect(retired.marked).toBe(4);
  for (const key of capturedKeys) {
    const source = await bucket.head(key);
    if (source === null) throw new Error("Missing released segment");
    await bucket.put(
      `namespaces/${namespace}/retired/${createHash("sha256").update(key).digest("hex")}.json`,
      Schema.encodeSync(Schema.fromJsonString(Retirement))({
        key,
        etag: source.etag,
        observedAt: timestamp,
      }),
    );
  }
  const collected = Schema.decodeUnknownSync(CollectionResult)(
    await (await request(worker, namespace, "collect", {})).json(),
  );
  expect(collected.deleted).toBe(4);
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, namespace, "metadata")).json(),
  );
  expect(metadata.sequence).toBe(4);
  expect(metadata.documents).toBe(1);
}, 15000);

test("query admission stays bounded and backend failures release all reader slots", async () => {
  const worker = await startWorker();
  const backend = await worker.getWorker("vectors");
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const state = { active: 0, maximum: 0, calls: 0 };
  const gate = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      state.active += 1;
      state.calls += 1;
      state.maximum = Math.max(state.maximum, state.active);
      if (state.active === 4) entered.resolve();
      await release.promise;
      state.active -= 1;
      return new Response("injected failure", { status: 503 });
    },
  });
  cleanup.defer(() => gate.stop(true));
  cleanup.defer(() => release.resolve());
  const namespace = "query-admission";
  const vector = [1, ...Array.from({ length: 767 }, () => 0)];
  expect(
    (await request(worker, namespace, "write", write([document("old", "alpha")]))).status,
  ).toBe(200);
  await backend.fetch("http://fixture/pause-query", { method: "POST", body: gate.url.href });
  const queries = Array.from({ length: 5 }, () =>
    request(worker, namespace, "query", {
      kind: "vector",
      vector,
      topK: 10,
      filters: [],
    }),
  );
  await entered.promise;
  expect(
    (
      await request(worker, namespace, "write", {
        ...write([document("new", "beta")]),
        reset: true,
      })
    ).status,
  ).toBe(200);
  expect(state.calls).toBe(4);
  release.resolve();
  const responses = await Promise.all(queries);
  expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503, 503]);
  expect(state.calls).toBe(5);
  expect(state.maximum).toBe(4);
  await backend.fetch("http://fixture/release-query");
  expect(
    (
      await request(worker, namespace, "query", {
        kind: "vector",
        vector,
        topK: 10,
        filters: [],
        minimumSequence: 2,
      })
    ).status,
  ).toBe(200);
  const collected = Schema.decodeUnknownSync(CollectionResult)(
    await (await request(worker, namespace, "collect", {})).json(),
  );
  expect(collected.pinned).toBe(2);
  expect(collected.marked).toBe(2);
}, 15000);
