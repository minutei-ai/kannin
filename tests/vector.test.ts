import { decodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  QueryResult,
  Metadata,
  VectorRebuildResult,
  VectorMessage,
  VectorSyncResult,
  Health,
} from "../src/protocol";
import { request, startWorker } from "./harness";

const worker = await startWorker();
const schema = {
  filterable: ["group", "year", "category", "__proto__", "flag", "eligible"],
  vectorFilterFields: ["group", "year", "category", "__proto__", "flag"],
};
afterAll(() => worker.dispose());
const vector = (x: number, y = 0) => [x, y, ...Array.from({ length: 766 }, () => 0)];
const query = (kind: "vector" | "hybrid" = "vector") => ({
  kind,
  vector: vector(1),
  text: "lexical",
  topK: 10,
  filters: [],
});
const vectorQuery = () => ({ kind: "vector", vector: vector(1), topK: 10, filters: [] });
async function mode(path: string) {
  const service = await worker.getWorker("vectors");
  await service.fetch(`http://fixture${path}`);
}

test("vector dimensions and zero magnitude fail before persistence", async () => {
  for (const values of [[1, 0], Array.from({ length: 768 }, () => 0)]) {
    expect(
      (
        await request(worker, "dimension", "write", {
          schema,
          requestId: crypto.randomUUID(),
          upserts: [{ id: "a", text: "lexical", attributes: {}, vector: values }],
          deletes: [],
        })
      ).status,
    ).toBe(400);
  }
  expect(
    Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, "dimension", "metadata")).json(),
    ).sequence,
  ).toBe(0);
});

test("vector outbox survives provider failure and retries", async () => {
  await mode("/fail");
  expect(
    (
      await request(worker, "retry", "write", {
        schema,
        requestId: "one",
        upserts: [{ id: "a", text: "lexical", attributes: {}, vector: vector(1) }],
        deletes: [],
      })
    ).status,
  ).toBe(200);
  expect((await request(worker, "retry", "vector-sync", {})).status).toBe(503);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "retry", "metadata")).json())
      .vectorOutbox,
  ).toBe(1);
  await mode("/healthy");
  expect((await request(worker, "retry", "vector-sync", {})).status).toBe(200);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "retry", "query", vectorQuery())).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["a"]);
  expect(found.consistency).toBe("vectorize-eventual");
});

test("delayed obsolete vectors cannot impersonate newer document revisions", async () => {
  await mode("/defer");
  await request(worker, "revision", "write", {
    schema,
    requestId: "old",
    upserts: [{ id: "a", text: "old", attributes: {}, vector: vector(1) }],
    deletes: [],
  });
  await request(worker, "revision", "vector-sync", {});
  await request(worker, "revision", "write", {
    schema,
    requestId: "new",
    upserts: [{ id: "a", text: "new", attributes: {}, vector: vector(0.6, 0.8) }],
    deletes: [],
  });
  await request(worker, "revision", "vector-sync", {});
  await mode("/commit-reversed");
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "revision", "query", vectorQuery())).json(),
  );
  expect(found.rows.map((row) => row.text)).toEqual(["new"]);
  expect(found.rows[0]?.score).toBeCloseTo(0.6);
});

test("deletion hides stale Vectorize results immediately", async () => {
  await request(worker, "delete", "write", {
    schema,
    requestId: "create",
    upserts: [{ id: "a", text: "lexical", attributes: {}, vector: vector(1) }],
    deletes: [],
  });
  await request(worker, "delete", "vector-sync", {});
  await request(worker, "delete", "write", {
    schema,
    requestId: "delete",
    upserts: [],
    deletes: ["a"],
  });
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "delete", "query", vectorQuery())).json(),
  );
  expect(found.rows).toEqual([]);
});

test("vectors are namespace isolated", async () => {
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "empty-vector-namespace", "query", vectorQuery())).json(),
  );
  expect(found.rows).toEqual([]);
});

test("hybrid combines lexical and vector ranking using RRF", async () => {
  await request(worker, "hybrid", "write", {
    schema,
    requestId: "hybrid",
    upserts: [
      { id: "both", text: "lexical lexical", attributes: { group: "a" }, vector: vector(1) },
      { id: "text", text: "lexical", attributes: { group: "b" } },
      { id: "vector", text: "unrelated", attributes: { group: "b" }, vector: vector(0.8, 0.6) },
    ],
    deletes: [],
  });
  await request(worker, "hybrid", "vector-sync", {});
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "hybrid", "query", query("hybrid"))).json(),
  );
  expect(result.rows[0]?.id).toBe("both");
  expect(result.rows[0]?.score).toBeCloseTo(2 / 61);
  const filtered = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "hybrid", "query", {
        ...vectorQuery(),
        filters: [{ field: "group", op: "eq", value: "b" }],
      })
    ).json(),
  );
  expect(filtered.rows.map((row) => row.id)).toEqual(["vector"]);
});

test("native metadata equality finds eligible vectors outside the unfiltered top fifty", async () => {
  const upserts = Array.from({ length: 120 }, (_, index) => {
    const attributes = { group: "distractor", year: 2020 };
    const values = vector(1);
    if (index >= 100) {
      attributes.group = "eligible";
      values[0] = 0.6;
      values[1] = 0.8;
    }
    return { id: String(index), text: "lexical", attributes, vector: values };
  });
  await request(worker, "prefilter", "write", { schema, requestId: "seed", upserts, deletes: [] });
  await request(worker, "prefilter", "vector-sync", {});
  for (const filters of [
    [{ field: "group", op: "eq", value: "eligible" }],
    [{ field: "group", op: "in", value: ["eligible", "absent"] }],
  ]) {
    const response = await request(worker, "prefilter", "query", { ...vectorQuery(), filters });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.rows.length).toBe(10);
    expect(result.rows.every((row) => row.attributes.group === "eligible")).toBe(true);
  }
});

test("typed scalar hashes preserve null, booleans and strings beyond sixty-four UTF8 bytes", async () => {
  const long = "ação".repeat(40);
  await request(worker, "scalar-index", "write", {
    schema,
    requestId: "seed",
    deletes: [],
    upserts: [
      {
        id: "string",
        text: "lexical",
        attributes: { category: long, flag: "true" },
        vector: vector(1),
      },
      {
        id: "boolean",
        text: "lexical",
        attributes: { category: null, flag: true },
        vector: vector(1),
      },
      { id: "missing", text: "lexical", attributes: {}, vector: vector(1) },
    ],
  });
  await request(worker, "scalar-index", "vector-sync", {});
  for (const [field, value, id] of [
    ["category", long, "string"],
    ["category", null, "boolean"],
    ["flag", true, "boolean"],
    ["flag", "true", "string"],
  ] as const) {
    const result = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(worker, "scalar-index", "query", {
          ...vectorQuery(),
          filters: [{ field, op: "eq", value }],
        })
      ).json(),
    );
    expect(result.rows.map((row) => row.id)).toEqual([id]);
  }
});

test("numeric metadata ranges apply before candidate limits and retain exact residual predicates", async () => {
  const upserts = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    text: "lexical",
    attributes: { year: index },
    vector: vector(1),
  }));
  await request(worker, "range-index", "write", {
    schema,
    requestId: "seed",
    upserts,
    deletes: [],
  });
  await request(worker, "range-index", "vector-sync", {});
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "range-index", "query", {
        ...vectorQuery(),
        filters: [
          { field: "year", op: "gte", value: 80 },
          { field: "year", op: "lt", value: 90 },
        ],
      })
    ).json(),
  );
  expect(result.rows.length).toBe(10);
  expect(
    result.rows.every(
      (row) => Number(row.attributes.year) >= 80 && Number(row.attributes.year) < 90,
    ),
  ).toBe(true);
});

test("R2-backed rebuild cursors resume after provider failure and reconcile intervening mutations", async () => {
  const upserts = Array.from({ length: 205 }, (_, index) => ({
    id: String(index).padStart(3, "0"),
    text: "lexical",
    attributes: { group: "old" },
    vector: vector(1),
  }));
  await request(worker, "rebuild-index", "write", {
    schema,
    requestId: "seed",
    upserts,
    deletes: [],
  });
  const first = Schema.decodeUnknownSync(VectorRebuildResult)(
    await (await request(worker, "rebuild-index", "vector-rebuild", {})).json(),
  );
  expect(first.complete).toBe(false);
  expect(first.submitted).toBe(100);
  if (first.snapshot === null) throw new Error("Missing rebuild snapshot");
  const cursor = { snapshot: first.snapshot, segment: first.segment, row: first.row };
  await request(worker, "rebuild-index", "write", {
    schema,
    requestId: "changed",
    upserts: [{ id: "150", text: "updated", attributes: { group: "new" }, vector: vector(1) }],
    deletes: ["151"],
  });
  await mode("/fail");
  expect((await request(worker, "rebuild-index", "vector-rebuild", cursor)).status).toBe(503);
  await mode("/healthy");
  const second = Schema.decodeUnknownSync(VectorRebuildResult)(
    await (await request(worker, "rebuild-index", "vector-rebuild", cursor)).json(),
  );
  expect(second.submitted).toBe(98);
  expect(second.complete).toBe(false);
  const last = Schema.decodeUnknownSync(VectorRebuildResult)(
    await (
      await request(worker, "rebuild-index", "vector-rebuild", {
        snapshot: first.snapshot,
        segment: second.segment,
        row: second.row,
      })
    ).json(),
  );
  expect(last.complete).toBe(true);
  expect(last.submitted).toBe(5);
  await request(worker, "rebuild-index", "vector-sync", {});
  const changed = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(worker, "rebuild-index", "query", {
        ...vectorQuery(),
        filters: [{ field: "group", op: "eq", value: "new" }],
      })
    ).json(),
  );
  expect(changed.rows.map((row) => row.id)).toEqual(["150"]);
  expect(changed.rows[0]?.text).toBe("updated");
}, 15000);

test("rebuild cursor validation and namespace reset cannot silently change the selected snapshot", async () => {
  for (const cursor of [
    { row: 1 },
    { snapshot: crypto.randomUUID() },
    { segment: 2 },
    { snapshot: "../unsafe", segment: 0, row: 0 },
  ])
    expect((await request(worker, "invalid-rebuild", "vector-rebuild", cursor)).status).toBe(400);
  await request(worker, "reset-rebuild", "write", {
    schema,
    requestId: "seed",
    deletes: [],
    upserts: Array.from({ length: 101 }, (_, index) => ({
      id: String(index),
      text: "lexical",
      attributes: {},
      vector: vector(1),
    })),
  });
  const first = Schema.decodeUnknownSync(VectorRebuildResult)(
    await (await request(worker, "reset-rebuild", "vector-rebuild", {})).json(),
  );
  if (first.snapshot === null) throw new Error("Missing rebuild snapshot");
  await request(worker, "reset-rebuild", "write", {
    schema,
    requestId: "reset",
    reset: true,
    upserts: [],
    deletes: [],
  });
  expect(
    (
      await request(worker, "reset-rebuild", "vector-rebuild", {
        snapshot: first.snapshot,
        segment: first.segment,
        row: first.row,
      })
    ).status,
  ).toBe(409);
});

test("obsolete queued revisions do not allocate extra provider vectors", async () => {
  await mode("/healthy");
  const service = await worker.getWorker("vectors");
  const count = Schema.Struct({ vectors: Schema.Int, pending: Schema.Int });
  const before = Schema.decodeUnknownSync(count)(
    await (await service.fetch("http://fixture/healthy")).json(),
  );
  for (const revision of [1, 2, 3])
    await request(worker, "skip-obsolete", "write", {
      schema,
      requestId: `revision-${revision}`,
      upserts: [{ id: "a", text: `lexical ${revision}`, attributes: {}, vector: vector(1) }],
      deletes: [],
    });
  expect((await request(worker, "skip-obsolete", "vector-sync", {})).status).toBe(200);
  const after = Schema.decodeUnknownSync(count)(
    await (await service.fetch("http://fixture/healthy")).json(),
  );
  expect(after.vectors - before.vectors).toBe(1);
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "skip-obsolete", "query", vectorQuery())).json(),
  );
  expect(result.rows.map((row) => row.text)).toEqual(["lexical 3"]);
  expect(
    Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, "skip-obsolete", "metadata")).json(),
    ).vectorOutbox,
  ).toBe(0);
});

test("reset before vector synchronization drops allocations for the retired epoch", async () => {
  const service = await worker.getWorker("vectors");
  const count = Schema.Struct({ vectors: Schema.Int, pending: Schema.Int });
  const before = Schema.decodeUnknownSync(count)(
    await (await service.fetch("http://fixture/healthy")).json(),
  );
  await request(worker, "skip-old-epoch", "write", {
    schema,
    requestId: "old",
    upserts: [{ id: "a", text: "old epoch", attributes: {}, vector: vector(1) }],
    deletes: [],
  });
  await request(worker, "skip-old-epoch", "write", {
    schema,
    requestId: "reset",
    reset: true,
    upserts: [{ id: "b", text: "new epoch", attributes: {}, vector: vector(1) }],
    deletes: [],
  });
  expect((await request(worker, "skip-old-epoch", "vector-sync", {})).status).toBe(200);
  const after = Schema.decodeUnknownSync(count)(
    await (await service.fetch("http://fixture/healthy")).json(),
  );
  expect(after.vectors - before.vectors).toBe(1);
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "skip-old-epoch", "query", vectorQuery())).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["b"]);
});

test("one queue delivery drains sixteen committed jobs with one vector mutation batch", async () => {
  await mode("/healthy");
  const namespace = "queue-window";
  for (const index of Array.from({ length: 17 }, (_, value) => value))
    expect(
      (
        await request(worker, namespace, "write", {
          schema,
          requestId: `queued-${index}`,
          upserts: [
            { id: `doc-${index}`, text: "queued vectors", attributes: {}, vector: vector(1) },
          ],
          deletes: [],
        })
      ).status,
    ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing queued root");
  const root = decodeRoot(await object.text());
  const first = root.vectorJobs[0];
  const last = root.vectorJobs[16];
  if (first === undefined || last === undefined) throw new Error("Expected seventeen queued jobs");
  const bindings = await worker.getDurableObjectNamespace("NAMESPACES");
  const stub = bindings.get(bindings.idFromName(namespace));
  const controlSchema = Schema.Struct({ upsertCalls: Schema.Int });
  const backend = await worker.getWorker("vectors");
  const before = Schema.decodeUnknownSync(controlSchema)(
    await (await backend.fetch("http://fixture/control")).json(),
  );
  const response = await stub.fetch(
    `http://internal/v1/namespaces/${namespace}/internal-vector-sync`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(VectorMessage))({ namespace, ...first }),
    },
  );
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(VectorSyncResult)(await response.json());
  expect(result.submitted).toBe(16);
  const after = Schema.decodeUnknownSync(controlSchema)(
    await (await backend.fetch("http://fixture/control")).json(),
  );
  expect(after.upsertCalls - before.upsertCalls).toBe(1);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, namespace, "metadata")).json())
      .vectorOutbox,
  ).toBe(1);
  const duplicate = await stub.fetch(
    `http://internal/v1/namespaces/${namespace}/internal-vector-sync`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(VectorMessage))({ namespace, ...first }),
    },
  );
  expect(Schema.decodeUnknownSync(VectorSyncResult)(await duplicate.json()).submitted).toBe(0);
  const final = await stub.fetch(
    `http://internal/v1/namespaces/${namespace}/internal-vector-sync`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(VectorMessage))({ namespace, ...last }),
    },
  );
  expect(Schema.decodeUnknownSync(VectorSyncResult)(await final.json()).submitted).toBe(1);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, namespace, "metadata")).json())
      .vectorOutbox,
  ).toBe(0);
});

test("vector top-k materializes only the requested live document pages", async () => {
  const namespace = "vector-pages";
  await request(worker, namespace, "write", {
    schema,
    requestId: "pages",
    upserts: Array.from({ length: 20 }, (_, index) => ({
      id: String(index).padStart(4, "0"),
      text: "lexical",
      attributes: {},
      vector: vector(1),
    })),
    deletes: [],
  });
  await request(worker, namespace, "vector-sync", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const response = await request(worker, namespace, "query", { ...vectorQuery(), topK: 1 });
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(response.headers.get("server-timing")).toContain("vector_index;dur=");
  expect(response.headers.get("server-timing")).toContain("vector_reconcile;dur=");
  expect(response.headers.get("server-timing")).toContain("vector_documents;dur=");
  expect(result.rows.map((row) => row.id)).toEqual(["0000"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(1);
});

test("vector materialization shares byte windows while preserving provider score order", async () => {
  const namespace = "vector-reverse-pages";
  await request(worker, namespace, "write", {
    schema,
    requestId: "pages",
    upserts: Array.from({ length: 20 }, (_, index) => ({
      id: String(index).padStart(4, "0"),
      text: "lexical",
      attributes: {},
      vector: vector(1, 20 - index),
    })),
    deletes: [],
  });
  await request(worker, namespace, "vector-sync", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", vectorQuery())).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(19 - index).padStart(4, "0")),
  );
  expect(
    result.rows.every((row, index) => {
      const previous = result.rows[index - 1];
      return previous === undefined || previous.score > row.score;
    }),
  ).toBe(true);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(1);
});

test("small vector top-k avoids locating every candidate segment", async () => {
  const namespace = "vector-scattered";
  for (const index of Array.from({ length: 20 }, (_, ordinal) => ordinal))
    await request(worker, namespace, "write", {
      schema,
      requestId: `page-${index}`,
      upserts: [
        { id: String(index).padStart(4, "0"), text: "lexical", attributes: {}, vector: vector(1) },
      ],
      deletes: [],
    });
  await request(worker, namespace, "vector-sync", {});
  await request(worker, namespace, "vector-sync", {});
  await request(worker, namespace, "rebuild", {});
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...vectorQuery(), topK: 1 })).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["0000"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBe(1);
  expect(after.directoryR2CacheReads - before.directoryR2CacheReads).toBe(0);
  expect(after.directoryR2CacheHits - before.directoryR2CacheHits).toBe(0);
  expect(after.cacheApiHits - before.cacheApiHits).toBe(1);
});

test("candidate windows continue through stale revisions and residual filters before top-k", async () => {
  const namespace = "vector-window-residual";
  await request(worker, namespace, "write", {
    schema,
    requestId: "seed",
    upserts: Array.from({ length: 20 }, (_, index) => ({
      id: String(index).padStart(4, "0"),
      text: "lexical",
      attributes: { eligible: index >= 12 },
      vector: vector(1),
    })),
    deletes: [],
  });
  await request(worker, namespace, "vector-sync", {});
  await request(worker, namespace, "write", {
    schema,
    requestId: "retire",
    upserts: Array.from({ length: 8 }, (_, index) => ({
      id: String(index).padStart(4, "0"),
      text: "replacement",
      attributes: { eligible: true },
    })),
    deletes: [],
  });
  const input = {
    ...vectorQuery(),
    topK: 3,
    filters: [{ field: "eligible", op: "eq", value: true }],
  };
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["0012", "0013", "0014"]);
  expect(found.rows.every((row) => row.revision === 1)).toBe(true);
  const single = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...input, topK: 1 })).json(),
  );
  expect(single.rows).toEqual(found.rows.slice(0, 1));
  await request(worker, namespace, "compact", {});
  const compacted = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(compacted.rows).toEqual(found.rows);
  const compactedSingle = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...input, topK: 1 })).json(),
  );
  expect(compactedSingle.rows).toEqual(single.rows);
});

test("bounded ANN cache avoids provider calls and expires without caching document authority", async () => {
  const namespace = "ann-cache";
  const filtered = {
    ...vectorQuery(),
    filters: [{ field: "group", op: "in", value: ["a", "b", "c", "d"] }],
  };
  await request(worker, namespace, "write", {
    schema,
    requestId: "seed",
    upserts: [{ id: "a", text: "lexical", attributes: { group: "a" }, vector: vector(1) }],
    deletes: [],
  });
  await request(worker, namespace, "vector-sync", {});
  const service = await worker.getWorker("vectors");
  const controlSchema = Schema.Struct({ queryCalls: Schema.Int });
  const before = Schema.decodeUnknownSync(controlSchema)(
    await (await service.fetch("http://fixture/healthy")).json(),
  );
  const first = await request(worker, namespace, "query", filtered);
  expect(first.headers.get("server-timing")).toContain('vector_cache;desc="miss"');
  const next = await request(worker, namespace, "query", filtered);
  expect(next.headers.get("server-timing")).toContain('vector_cache;desc="hit"');
  expect(Schema.decodeUnknownSync(QueryResult)(await next.json()).rows).toEqual(
    Schema.decodeUnknownSync(QueryResult)(await first.json()).rows,
  );
  const reused = Schema.decodeUnknownSync(controlSchema)(
    await (await service.fetch("http://fixture/healthy")).json(),
  );
  expect(reused.queryCalls).toBe(before.queryCalls + 1);
  await Effect.runPromise(Effect.sleep("1100 millis"));
  const expired = await request(worker, namespace, "query", filtered);
  expect(expired.headers.get("server-timing")).toContain('vector_cache;desc="miss"');
  const renewed = Schema.decodeUnknownSync(controlSchema)(
    await (await service.fetch("http://fixture/healthy")).json(),
  );
  expect(renewed.queryCalls).toBe(before.queryCalls + 2);
  await request(worker, namespace, "write", {
    schema,
    requestId: "replace",
    upserts: [{ id: "a", text: "new", attributes: { group: "b" }, vector: vector(0.6, 0.8) }],
    deletes: [],
  });
  await request(worker, namespace, "vector-sync", {});
  const updated = await request(worker, namespace, "query", filtered);
  expect(updated.headers.get("server-timing")).toContain('vector_cache;desc="miss"');
  expect(Schema.decodeUnknownSync(QueryResult)(await updated.json()).rows[0]?.text).toBe("new");
});
