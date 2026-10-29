import { decodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Match, Schema } from "effect";
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
  ...(kind === "hybrid" && { text: "lexical" }),
  topK: 10,
  filters: [],
});
const vectorQuery = () => ({ kind: "vector", vector: vector(1), topK: 10, filters: [] });

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

test("wrong query dimensions return 400 in empty and populated namespaces", async () => {
  const namespace = "query-dimensions";
  for (const populated of [false, true]) {
    if (populated)
      expect(
        (
          await request(worker, namespace, "write", {
            requestId: "seed",
            upserts: [{ id: "a", text: "lexical", attributes: {}, vector: vector(1) }],
            deletes: [],
          })
        ).status,
      ).toBe(200);
    for (const values of [
      [1, 0],
      [1, ...Array.from({ length: 768 }, () => 0)],
    ])
      for (const kind of ["vector", "hybrid"] as const)
        expect(
          (await request(worker, namespace, "query", { ...query(kind), vector: values })).status,
        ).toBe(400);
  }
  const response = await request(worker, namespace, "query", vectorQuery());
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.rows.map((row) => row.id)).toEqual(["a"]);
  expect(result.sequence).toBe(1);
  expect(
    (
      await request(worker, namespace, "write", {
        requestId: "legacy-dimension-change",
        schema: { ...schema, vectorDimensions: 2 },
        upserts: [],
        deletes: [],
      })
    ).status,
  ).toBe(409);
});

test("configured vector dimensions survive canonical maintenance and reset without changing old receipts", async () => {
  for (const dimensions of [1, 2, 4096, 10_752]) {
    const namespace = `custom-dimension-${dimensions}`;
    const values = [1, ...Array.from({ length: dimensions - 1 }, () => 0)];
    const initial = {
      schema: { ...schema, vectorDimensions: dimensions },
      requestId: "first",
      upserts: [{ id: "a", text: "lexical", attributes: {}, vector: values }],
      deletes: [],
    };
    expect((await request(worker, namespace, "write", initial)).status).toBe(200);
    expect(
      (
        await request(worker, namespace, "write", {
          requestId: "mixed-dimensions",
          upserts: [
            { id: "valid", text: "lexical", attributes: {}, vector: values },
            { id: "invalid", text: "lexical", attributes: {}, vector: [...values, 0] },
          ],
          deletes: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(worker, namespace, "write", {
          requestId: "second",
          upserts: [{ id: "b", text: "lexical", attributes: {}, vector: values.map((v) => -v) }],
          deletes: [],
        })
      ).status,
    ).toBe(200);
    for (const operation of ["compact", "vector-sync", "vector-rebuild"])
      expect((await request(worker, namespace, operation, {})).status).toBe(200);
    const bucket = await worker.getR2Bucket("STORAGE");
    const stored = await bucket.get(`namespaces/${namespace}/root.json`);
    if (stored === null) throw new Error("Missing configured root");
    expect(decodeRoot(await stored.text()).schema?.vectorDimensions).toBe(dimensions);
    for (const kind of ["vector", "hybrid"] as const) {
      const response = await request(worker, namespace, "query", {
        ...query(kind),
        vector: values,
      });
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
      expect(result.consistency).toBe("strong");
      expect(result.sequence).toBe(2);
    }
    const changed = Match.value(dimensions).pipe(
      Match.when(1, () => 2),
      Match.orElse(() => 1),
    );
    const replacement = [1, ...Array.from({ length: changed - 1 }, () => 0)];
    const reset = {
      schema: { ...schema, vectorDimensions: changed },
      requestId: "changed",
      upserts: [
        {
          id: "new",
          text: "lexical",
          attributes: {},
          vector: replacement,
        },
      ],
      deletes: [],
    };
    expect((await request(worker, namespace, "write", reset)).status).toBe(409);
    expect((await request(worker, namespace, "write", { ...reset, reset: true })).status).toBe(200);
    expect(
      (await request(worker, namespace, "query", { ...vectorQuery(), vector: values })).status,
    ).toBe(400);
    const replay = await request(worker, namespace, "write", initial);
    expect(replay.status).toBe(200);
    const current = Schema.decodeUnknownSync(Metadata)(
      await (await request(worker, namespace, "metadata")).json(),
    );
    expect(current.sequence).toBe(3);
    expect(current.schema?.vectorDimensions).toBe(changed);
    const selected = await request(worker, namespace, "query", {
      ...vectorQuery(),
      vector: replacement,
    });
    expect(selected.status).toBe(200);
    const live = Schema.decodeUnknownSync(QueryResult)(await selected.json());
    expect(live.rows.map((row) => row.id)).toEqual(["new"]);
    expect(live.sequence).toBe(3);
  }
});

test("invalid dimension declarations cannot create a canonical namespace", async () => {
  const namespace = "invalid-dimension-schema";
  for (const vectorDimensions of [0, 10_753, 1.5])
    expect(
      (
        await request(worker, namespace, "write", {
          requestId: String(vectorDimensions),
          schema: { ...schema, vectorDimensions },
          upserts: [],
          deletes: [],
        })
      ).status,
    ).toBe(400);
  const bucket = await worker.getR2Bucket("STORAGE");
  expect(await bucket.head(`namespaces/${namespace}/root.json`)).toBeNull();
});

test("canonical vector outbox survives corrupt log reads and retries", async () => {
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
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootObject = await bucket.get("namespaces/retry/root.json");
  if (rootObject === null) throw new Error("Missing canonical root");
  const logKey = decodeRoot(await rootObject.text()).vectorJobs[0]?.log;
  if (logKey === undefined) throw new Error("Missing vector job");
  const log = await bucket.get(logKey);
  if (log === null) throw new Error("Missing committed log");
  const bytes = await log.arrayBuffer();
  await bucket.put(logKey, new Uint8Array(8));
  expect((await request(worker, "retry", "vector-sync", {})).status).toBe(503);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "retry", "metadata")).json())
      .vectorOutbox,
  ).toBe(1);
  await bucket.put(logKey, bytes);
  expect((await request(worker, "retry", "vector-sync", {})).status).toBe(200);
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "retry", "query", vectorQuery())).json(),
  );
  expect(found.rows.map((row) => row.id)).toEqual(["a"]);
  expect(found.consistency).toBe("strong");
});

test("native vector search immediately exposes the newest committed revision", async () => {
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
  const found = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "revision", "query", vectorQuery())).json(),
  );
  expect(found.rows.map((row) => row.text)).toEqual(["new"]);
  expect(found.rows[0]?.score).toBeCloseTo(0.6);
});

test("deletion immediately removes canonical vectors from native ranking", async () => {
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

test("native vector and hybrid ties preserve the existing document ordering through HTTP materialization", async () => {
  const ids = ["😀", "\uE000", "a"];
  expect(
    (
      await request(worker, "unicode-vector-ties", "write", {
        requestId: "unicode-ties",
        upserts: ids.map((id) => ({ id, text: "tied", attributes: {}, vector: vector(1) })),
        deletes: [],
      })
    ).status,
  ).toBe(200);
  for (const kind of ["vector", "hybrid"] as const) {
    for (const topK of [1, 2, 3]) {
      const response = await request(worker, "unicode-vector-ties", "query", {
        kind,
        vector: vector(1),
        topK,
        filters: [],
        ...(kind === "hybrid" && { text: "tied" }),
      });
      expect(response.status).toBe(200);
      const found = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(found.rows.map((row) => row.id)).toEqual(["a", "😀", "\uE000"].slice(0, topK));
    }
  }
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

test("native scalar and array filters find eligible vectors outside the unfiltered top fifty", async () => {
  const upserts = Array.from({ length: 160 }, (_, index) => {
    const attributes = { group: "distractor", year: 2020, eligible: ["distractor"] };
    const values = vector(1);
    if (index >= 100) {
      attributes.group = "eligible";
      attributes.eligible = ["eligible"];
      values[0] = 0.6;
      values[1] = 0.8;
    }
    return { id: String(index), text: "lexical", attributes, vector: values };
  });
  expect(
    (
      await request(worker, "prefilter", "write", {
        schema,
        requestId: "seed",
        upserts,
        deletes: [],
      })
    ).status,
  ).toBe(200);
  const unfiltered = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "prefilter", "query", { ...vectorQuery(), topK: 50 })).json(),
  );
  expect(unfiltered.rows).toHaveLength(50);
  expect(unfiltered.rows.every((row) => row.attributes.group === "distractor")).toBe(true);
  for (const filters of [
    [{ field: "group", op: "eq", value: "eligible" }],
    [{ field: "group", op: "in", value: ["eligible", "absent"] }],
    [{ field: "group", op: "ne", value: "distractor" }],
    [{ field: "group", op: "notIn", value: ["distractor", "absent"] }],
    [{ field: "group", op: "gte", value: "eligible" }],
    [{ field: "group", op: "gt", value: "distractor" }],
    [{ field: "eligible", op: "contains", value: "eligible" }],
    [{ field: "eligible", op: "notContains", value: "distractor" }],
    [{ field: "eligible", op: "containsAny", value: ["absent", "eligible"] }],
    [{ field: "eligible", op: "notContainsAny", value: ["distractor"] }],
  ])
    for (const topK of [10, 50]) {
      const response = await request(worker, "prefilter", "query", {
        ...vectorQuery(),
        filters,
        topK,
      });
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.consistency).toBe("strong");
      expect(result.rows.map((row) => row.id)).toEqual(
        Array.from({ length: topK }, (_, index) => String(100 + index)),
      );
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

test("R2-backed rebuild cursors resume after checkpoint corruption and reconcile intervening mutations", async () => {
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
  const bucket = await worker.getR2Bucket("STORAGE");
  const checkpointKey = `namespaces/rebuild-index/vector-rebuild/${first.snapshot}.json`;
  const checkpoint = await bucket.get(checkpointKey);
  if (checkpoint === null) throw new Error("Missing canonical checkpoint");
  const checkpointBytes = await checkpoint.arrayBuffer();
  await bucket.put(checkpointKey, "{}", { customMetadata: checkpoint.customMetadata ?? {} });
  expect((await request(worker, "rebuild-index", "vector-rebuild", cursor)).status).toBe(503);
  await bucket.put(checkpointKey, checkpointBytes, {
    customMetadata: checkpoint.customMetadata ?? {},
  });
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

test("obsolete queued revisions are acknowledged without replacing live canonical vectors", async () => {
  for (const revision of [1, 2, 3])
    await request(worker, "skip-obsolete", "write", {
      schema,
      requestId: `revision-${revision}`,
      upserts: [{ id: "a", text: `lexical ${revision}`, attributes: {}, vector: vector(1) }],
      deletes: [],
    });
  expect((await request(worker, "skip-obsolete", "vector-sync", {})).status).toBe(200);
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

test("reset before vector synchronization retires the old canonical epoch", async () => {
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
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "skip-old-epoch", "query", vectorQuery())).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["b"]);
});

test("one queue delivery validates at most sixteen committed canonical jobs", async () => {
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
  expect(response.headers.get("server-timing")).toContain("vector_documents;dur=");
  expect(result.rows.map((row) => row.id)).toEqual(["0000"]);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.rangeReads - before.rangeReads).toBeLessThanOrEqual(21);
});

test("vector materialization preserves native cosine score order", async () => {
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
  expect(after.rangeReads - before.rangeReads).toBeLessThanOrEqual(21);
});

test("exact vector top-k remains stable across scattered segments", async () => {
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
  expect(after.rangeReads - before.rangeReads).toBeLessThanOrEqual(41);
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

test("native vector queries use canonical revisions without external candidates or snapshot caches", async () => {
  const namespace = "native-no-ann";
  expect(
    (
      await request(worker, namespace, "write", {
        schema,
        requestId: "seed",
        deletes: [],
        upserts: [{ id: "a", text: "old", attributes: { eligible: true }, vector: vector(1) }],
      })
    ).status,
  ).toBe(200);
  const input = { ...vectorQuery(), filters: [{ field: "eligible", op: "eq", value: true }] };
  const first = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(first.consistency).toBe("strong");
  expect(first.rows.map((row) => row.id)).toEqual(["a"]);
  expect(
    (
      await request(worker, namespace, "write", {
        schema,
        requestId: "replace",
        deletes: [],
        upserts: [
          { id: "a", text: "new", attributes: { eligible: true }, vector: vector(0.6, 0.8) },
        ],
      })
    ).status,
  ).toBe(200);
  const updated = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", { ...input, minimumSequence: 2 })).json(),
  );
  expect(updated.rows[0]?.text).toBe("new");
  expect(updated.rows[0]?.score).toBeCloseTo(0.6);
});

test("paged native vector selection finds late winners and applies canonical tombstones", async () => {
  const namespace = "vector-page-boundary";
  expect(
    (
      await request(worker, namespace, "write", {
        requestId: "paged-vectors",
        deletes: [],
        upserts: Array.from({ length: 130 }, (_, index) => ({
          id: String(index).padStart(3, "0"),
          text: "paged vectors",
          attributes: { padding: "x".repeat(4096) },
          vector: vector(index + 1, 130 - index),
        })),
      })
    ).status,
  ).toBe(200);
  const input = { ...vectorQuery(), topK: 3 };
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(before.rows.map((row) => row.id)).toEqual(["129", "128", "127"]);
  expect(before.rows.every((row) => row.attributes.padding === "x".repeat(4096))).toBe(true);
  expect(
    (
      await request(worker, namespace, "write", {
        requestId: "retire-paged",
        deletes: ["129"],
        upserts: [{ id: "128", text: "no vector", attributes: {} }],
      })
    ).status,
  ).toBe(200);
  const after = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", input)).json(),
  );
  expect(after.rows.map((row) => row.id)).toEqual(["127", "126", "125"]);
});
