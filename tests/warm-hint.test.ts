import { afterAll, expect, test } from "bun:test";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { Cause, Effect, Schedule, Schema } from "effect";
import { CacheWarmHintResult, Metadata } from "../src/protocol";
import { request, startWorker } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("official SDK warm hints populate the decoded immutable cache without changing canonical state", async () => {
  const written = await request(worker, "warm-hint", "write", {
    requestId: "warm-first",
    upserts: [{ id: "one", text: "warm immutable directory", attributes: {} }],
    deletes: [],
  });
  expect(written.status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const beforeRoot = await bucket.head("namespaces/warm-hint/root.json");
  expect(beforeRoot).not.toBeNull();
  const before = Schema.decodeUnknownSync(Metadata)(
    await (await request(worker, "warm-hint", "metadata")).json(),
  );
  expect(before.cache.directoryCacheChargedBytes).toBe(0);
  const client = new Turbopuffer({
    apiKey: "local-test-token",
    baseURL: (await worker.ready).origin,
    maxRetries: 0,
  });
  const hinted = await client.namespace("warm-hint").hintCacheWarm().withResponse();
  expect(hinted.response.status).toBe(202);
  expect(hinted.response.headers.get("cache-control")).toBe("private, no-store");
  expect(Schema.decodeSync(CacheWarmHintResult)(hinted.data).status).toBe("ACCEPTED");
  const after = await Effect.runPromise(
    Effect.tryPromise(
      async () => await (await request(worker, "warm-hint", "metadata")).json(),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
      Effect.flatMap((metadata) => {
        if (metadata.cache.directoryCacheChargedBytes > 0) return Effect.succeed(metadata);
        return new Cause.UnknownError(new Error("Directory warming is not complete"));
      }),
      Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 }),
    ),
  );
  expect(after.sequence).toBe(before.sequence);
  expect(after.documents).toBe(before.documents);
  expect((await bucket.head("namespaces/warm-hint/root.json"))?.etag).toBe(beforeRoot?.etag);
  const rejected = await fetch(
    new URL("/v1/namespaces/warm-hint/hint_cache_warm", await worker.ready),
  );
  expect(rejected.status).toBe(401);
  await rejected.arrayBuffer();
  const wrongMethod = await request(worker, "warm-hint", "hint_cache_warm", {});
  expect(wrongMethod.status).toBe(405);
  await expect(client.namespace("warm-missing").hintCacheWarm()).rejects.toMatchObject({
    status: 404,
  });
  expect(await bucket.head("namespaces/warm-missing/root.json")).toBeNull();
});
