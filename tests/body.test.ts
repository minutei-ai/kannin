import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { Query, QueryResult } from "../src/protocol";
import { document, request, startWorker, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());

test("streamed UTF-8 queries preserve bytes across edge and coordinator reads", async () => {
  const namespace = "streamed-query-body";
  await request(worker, namespace, "write", write([document("a", "café 日本語")]));
  const rows = [];
  for (const consistency of ["strong", "edge-eventual"] as const) {
    const bytes = new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(Query))({
        kind: "text",
        text: "café 日本語",
        topK: 10,
        filters: [],
        consistency,
        minimumSequence: 1,
      }),
    );
    const response = await fetch(new URL(`/v1/namespaces/${namespace}/query`, await worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.sequence).toBe(1);
    expect(result.consistency).toBe(consistency);
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
    rows.push(result.rows);
  }
  expect(rows[0]).toEqual(rows[1]);
});

test("query bodies enforce the byte limit before both consistency paths", async () => {
  const namespace = "query-body-limit";
  await request(worker, namespace, "write", write([document("a", "body boundary")]));
  for (const consistency of ["strong", "edge-eventual"] as const) {
    const query = Schema.encodeSync(Schema.fromJsonString(Query))({
      kind: "text",
      text: "body café 日本語",
      topK: 10,
      filters: [],
      consistency,
      minimumSequence: 1,
    });
    const headers = {
      authorization: "Bearer local-test-token",
      "content-type": "application/json; charset=utf-8",
    };
    const url = new URL(`/v1/namespaces/${namespace}/query`, await worker.ready);
    const boundary = query.padEnd(
      1_900_000 - (new TextEncoder().encode(query).byteLength - query.length),
    );
    const accepted = await fetch(url, { method: "POST", headers, body: boundary });
    expect(accepted.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await accepted.json());
    expect(result.sequence).toBe(1);
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
    const rejected = await fetch(url, { method: "POST", headers, body: `${boundary} ` });
    expect(rejected.status).toBe(413);
    await rejected.arrayBuffer();
  }
});
