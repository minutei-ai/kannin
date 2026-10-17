import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write, evictWrittenOverviews } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("catalog intervals stay request-local across concurrent queries and overview cache recovery", async () => {
  const namespace = "catalog-timing";
  for (const index of [0, 1, 2])
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document(String(index), `alpha unique${index}`)]),
        )
      ).status,
    ).toBe(200);
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const cold = await request(worker, namespace, "query", textQuery("alpha"));
  expect(cold.status).toBe(200);
  const expected = Schema.decodeUnknownSync(QueryResult)(await cold.json());
  expect(cold.headers.get("server-timing")).toContain("origins=1");
  expect(cold.headers.get("server-timing")).toContain("reads=3 hits=3");
  const responses = await Promise.all([
    request(worker, namespace, "query", textQuery("alpha unique0 unique2")),
    request(worker, namespace, "query", textQuery("unique1")),
  ]);
  const complete = responses[0];
  const selective = responses[1];
  if (complete === undefined || selective === undefined) throw new Error("Missing timing response");
  expect(complete.status).toBe(200);
  expect(selective.status).toBe(200);
  expect(complete.headers.get("server-timing")).toContain('desc="memory=2 api=0"');
  expect(selective.headers.get("server-timing")).toContain('desc="memory=1 api=0"');
  for (const response of responses) {
    expect(response.headers.get("server-timing")).toContain("reads=0 hits=0 bytes=0");
    expect(response.headers.get("server-timing")).toContain("requests=1");
  }
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const cached = await request(worker, namespace, "query", textQuery("alpha"));
  expect(Schema.decodeUnknownSync(QueryResult)(await cached.json())).toEqual(expected);
  expect(cached.headers.get("server-timing")).toContain("requests=1 native_hits=0 origins=1");
  expect(cached.headers.get("server-timing")).toContain('desc="memory=0 api=3"');
  expect(cached.headers.get("server-timing")).toContain(
    'catalog_source_r2_sum;dur=0;desc="reads=0 hits=0 bytes=0 batch_peak=0"',
  );
});

test("cold catalog summaries overlap at most four R2 bodies and preserve source order", async () => {
  const namespace = "catalog-read-window";
  for (const index of Array.from({ length: 9 }, (_, ordinal) => ordinal))
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document(String(index), `alpha unique${index}`)]),
        )
      ).status,
    ).toBe(200);
  await evictWrittenOverviews(worker, namespace);
  const response = await request(worker, namespace, "query", textQuery("alpha", 10));
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 9 }, (_, index) => String(index)),
  );
  expect(response.headers.get("server-timing")).toContain("reads=9 hits=9");
  expect(response.headers.get("server-timing")).toContain("peak=4");
});
