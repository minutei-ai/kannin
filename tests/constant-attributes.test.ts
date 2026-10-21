import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { initSync, Segment, Directory, PreparedQuery } from "../dist/wasm/raio_engine";
import {
  ConstantAttributes,
  RankingInput,
  Root,
  StoredDocument,
  SegmentHeader,
  SegmentHits,
  PostingSpans,
  QueryResult,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});
const worker = await startWorker();
afterAll(() => worker.dispose());

test("constant proofs retain only present equal scalars within their byte budget", () => {
  const documents = Array.from({ length: 200 }, (_, index) => ({
    id: String(index).padStart(3, "0"),
    revision: 1,
    title: "",
    text: "rust cloudflare",
    attributes: {
      year: 2024,
      active: true,
      empty: null,
      note: 'ação\n"\\',
      value: index,
      padding: "x".repeat(4096),
      occasional: index % 2,
      lastChange: index === 199,
    },
  }));
  using segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents),
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = Directory.canonical(bytes.subarray(0, base), base);
  const constants = Schema.decodeSync(Schema.fromJsonString(ConstantAttributes))(
    segment.constant_attributes(),
  );
  expect(constants).toEqual({ year: 2024, active: true, empty: null, note: 'ação\n"\\' });
  expect(directory.constant_attributes()).toBe(segment.constant_attributes());
  expect(segment.bytes()).toEqual(bytes);
  expect(new TextEncoder().encode(segment.constant_attributes()).byteLength).toBeLessThanOrEqual(
    512,
  );
  const absent = documents.map((value, index) => {
    if (index === 0) return value;
    return { ...value, attributes: {} };
  });
  using missing = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(absent),
  );
  expect(missing.constant_attributes()).toBe("{}");
  expect(Schema.is(ConstantAttributes)({ padding: "x".repeat(513) })).toBe(false);
  expect(Schema.is(ConstantAttributes)({ fraction: 1.5 })).toBe(false);
  expect(Schema.is(ConstantAttributes)({ large: 2 ** 53 })).toBe(false);
  for (const x of ["a".repeat(504), "é".repeat(252), "🦀".repeat(126)]) {
    using boundary = new Segment(
      Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(
        documents.slice(0, 2).map((value) => Object.assign({}, value, { attributes: { x } })),
      ),
    );
    expect(new TextEncoder().encode(boundary.constant_attributes()).byteLength).toBe(512);
    expect(
      Schema.decodeSync(Schema.fromJsonString(ConstantAttributes))(boundary.constant_attributes()),
    ).toEqual({ x });
  }
});

test("native numeric representations cannot certify converted filter values", () => {
  const attributes =
    '{"year":2024,"integral":2.0,"fraction":1.5,"large":9007199254740993,"negativeZero":-0.0,"safeMin":-9007199254740991,"safeMax":9007199254740991}';
  using segment = new Segment(
    `[${["a", "b"].map((id) => `{"id":"${id}","revision":1,"text":"rust","attributes":${attributes}}`).join(",")}]`,
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = Directory.canonical(bytes.subarray(0, base), base);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  using prepared = new PreparedQuery(
    Schema.encodeSync(Schema.fromJsonString(RankingInput))({
      text: "rust",
      mode: "any",
      top_k: 10,
      dead: [],
      filters: [{ field: "integral", op: "eq", value: 2 }],
      statistics: {
        documents: 2,
        title_length: header.total_title_length,
        body_length: header.total_body_length,
        frequencies: Object.fromEntries(
          Object.entries(header.terms).map(([key, term]) => [key, term.df]),
        ),
      },
    }),
  );
  using ranker = directory.ranker_prepared(prepared, "[]");
  for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(ranker.posting_spans()))
    for (const block of span.blocks)
      ranker.add(
        span.term,
        bytes.subarray(base + block.data.offset, base + block.data.offset + block.data.length),
      );
  expect(Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish())).toEqual([]);
  const proof = Schema.encodeSync(Schema.fromJsonString(ConstantAttributes))(
    Schema.decodeSync(Schema.fromJsonString(ConstantAttributes))(segment.constant_attributes()),
  );
  expect(
    prepared.common_hits(segment.common_terms(), segment.common_leaders(), 2, "[]", proof),
  ).toBeUndefined();
  expect(Schema.decodeSync(Schema.fromJsonString(ConstantAttributes))(proof)).toEqual({
    year: 2024,
    safeMin: -(2 ** 53 - 1),
    safeMax: 2 ** 53 - 1,
  });
  expect(() =>
    prepared.common_hits(
      segment.common_terms(),
      segment.common_leaders(),
      2,
      "[]",
      '{"integral":2.0}',
    ),
  ).toThrow();
  expect(() =>
    prepared.common_hits(
      segment.common_terms(),
      segment.common_leaders(),
      2,
      "[]",
      '{"year":2024,"fraction":1.5}',
    ),
  ).toThrow();
});

test("uniform filtered leaders equal complete posting rankings and refuse incomplete proofs", () => {
  const documents = Array.from({ length: 200 }, (_, index) => ({
    id: String(index).padStart(3, "0"),
    revision: 1,
    title: "",
    text: `rust cloudflare ${"padding ".repeat(index % 3)}`,
    attributes: { year: 2024, active: true, empty: null },
  }));
  using segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents),
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = Directory.canonical(bytes.subarray(0, base), base);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const statistics = {
    documents: documents.length,
    title_length: header.total_title_length,
    body_length: header.total_body_length,
    frequencies: Object.fromEntries(
      Object.entries(header.terms).map(([key, term]) => [key, term.df]),
    ),
  };
  for (const filters of [
    [{ field: "year", op: "eq", value: 2024 }],
    [{ field: "year", op: "ne", value: 2025 }],
    [{ field: "year", op: "gt", value: 2023 }],
    [{ field: "year", op: "gte", value: 2024 }],
    [{ field: "year", op: "lt", value: 2025 }],
    [{ field: "year", op: "lte", value: 2024 }],
    [{ field: "year", op: "in", value: [2024, 2025] }],
    [{ field: "empty", op: "exists", value: true }],
    [
      { field: "active", op: "eq", value: true },
      { field: "empty", op: "eq", value: null },
    ],
  ] as const) {
    for (const mode of ["any", "all"] as const) {
      for (const dead of [[], [0, 3, 6]]) {
        using prepared = new PreparedQuery(
          Schema.encodeSync(Schema.fromJsonString(RankingInput))({
            text: "rust cloudflare rust",
            mode,
            top_k: 10,
            dead: [],
            filters,
            statistics,
          }),
        );
        const encodedDead = JSON.stringify(dead);
        expect(
          prepared.common_hits(segment.common_terms(), segment.common_leaders(), 200, encodedDead),
        ).toBeUndefined();
        const fast = prepared.common_hits(
          segment.common_terms(),
          segment.common_leaders(),
          200,
          encodedDead,
          segment.constant_attributes(),
        );
        using ranker = directory.ranker_prepared(prepared, encodedDead);
        for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
          ranker.posting_spans(),
        ))
          for (const block of span.blocks)
            ranker.add(
              span.term,
              bytes.subarray(
                base + block.data.offset,
                base + block.data.offset + block.data.length,
              ),
            );
        expect(fast).toBeDefined();
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(SegmentHits))(fast)).toEqual(
          Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish()),
        );
        expect(
          prepared.common_hits(
            segment.common_terms(),
            segment.common_leaders(),
            200,
            encodedDead,
            "{}",
          ),
        ).toBeUndefined();
        expect(() =>
          prepared.common_hits(
            segment.common_terms(),
            segment.common_leaders(),
            200,
            encodedDead,
            '{"year":[]}',
          ),
        ).toThrow();
        expect(() =>
          prepared.common_hits(
            segment.common_terms(),
            segment.common_leaders(),
            200,
            encodedDead,
            JSON.stringify({ padding: "x".repeat(512) }),
          ),
        ).toThrow();
      }
    }
  }
  for (const filters of [
    [{ field: "year", op: "eq", value: 2025 }],
    [{ field: "missing", op: "exists", value: false }],
    [
      { field: "year", op: "eq", value: 2024 },
      { field: "value", op: "eq", value: 0 },
    ],
  ] as const) {
    using prepared = new PreparedQuery(
      Schema.encodeSync(Schema.fromJsonString(RankingInput))({
        text: "rust",
        mode: "any",
        top_k: 10,
        dead: [],
        filters,
        statistics,
      }),
    );
    expect(
      prepared.common_hits(
        segment.common_terms(),
        segment.common_leaders(),
        200,
        "[]",
        segment.constant_attributes(),
      ),
    ).toBeUndefined();
  }
});

test("manifest proofs preserve filtered reads through fallback, tombstones, rebuild and compaction", async () => {
  const namespace = "uniform-proof";
  for (const batch of [0, 1, 2, 3]) {
    const documents = Array.from({ length: 50 }, (_, index) =>
      document(String(batch * 50 + index).padStart(3, "0"), "rust cloudflare", {
        year: 2024,
        group: batch % 2,
        value: index,
      }),
    );
    expect((await request(worker, namespace, "write", write(documents))).status).toBe(200);
  }
  const query = textQuery("rust cloudflare", 10, [{ field: "year", op: "gte", value: 2020 }]);
  const fast = await request(worker, namespace, "query", query);
  expect(fast.status).toBe(200);
  expect(fast.headers.get("server-timing")).toContain('catalog_root_prefix;desc="hit"');
  expect(fast.headers.get("server-timing")).toMatch(/text_common_leaders;desc="segments=[1-9]/);
  const original = Schema.decodeUnknownSync(QueryResult)(await fast.json());
  expect(original.rows.map((row) => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => String(index).padStart(3, "0")),
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  const key = `namespaces/${namespace}/root.json`;
  const stored = await bucket.get(key);
  if (stored === null) throw new Error("Missing fixture root");
  const root = Schema.decodeUnknownSync(Root)(await stored.json());
  expect(root.segments.map((segment) => segment.constantAttributes)).toEqual(
    [0, 1, 0, 1].map((group) => ({ year: 2024, group })),
  );
  const probes = [
    [query, original.rows.map((row) => row.id)],
    [
      textQuery("rust cloudflare", 10, [{ field: "group", op: "eq", value: 1 }]),
      Array.from({ length: 10 }, (_, index) => String(index + 50).padStart(3, "0")),
    ],
    [
      textQuery("rust cloudflare", 10, [{ field: "value", op: "eq", value: 3 }]),
      ["003", "053", "103", "153"],
    ],
    [textQuery("rust cloudflare", 10, [{ field: "year", op: "eq", value: 2025 }]), []],
    [
      textQuery("rust cloudflare", 10, [{ field: "missing", op: "exists", value: false }]),
      original.rows.map((row) => row.id),
    ],
    [{ ...query, match: "phrase" }, original.rows.map((row) => row.id)],
  ] as const;
  const oracle = new Map<number, typeof original.rows>();
  for (const accelerated of [true, false]) {
    if (!accelerated) {
      await bucket.put(
        key,
        Schema.encodeSync(Schema.fromJsonString(Root))({
          ...root,
          segments: root.segments.map((segment) => ({ ...segment, constantAttributes: {} })),
        }),
      );
      expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
    }
    for (const [index, [input, ids]] of probes.entries()) {
      const response = await request(worker, namespace, "query", input);
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.rows.map((row) => row.id)).toEqual([...ids]);
      if (accelerated) oracle.set(index, result.rows);
      else {
        const expected = oracle.get(index);
        if (expected === undefined) throw new Error("Missing baseline query result");
        expect(result.rows).toEqual(expected);
      }
    }
  }
  await bucket.put(
    key,
    Schema.encodeSync(Schema.fromJsonString(Root))({
      ...root,
      segments: root.segments.map((segment) => ({ ...segment, constantAttributes: undefined })),
    }),
  );
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const refreshed = await bucket.get(key);
  if (refreshed === null) throw new Error("Missing rebuilt fixture root");
  expect(
    Schema.decodeUnknownSync(Root)(await refreshed.json()).segments.map(
      (segment) => segment.constantAttributes,
    ),
  ).toEqual(root.segments.map((segment) => segment.constantAttributes));
  expect(
    (
      await request(
        worker,
        namespace,
        "write",
        write(
          [],
          original.rows.map((row) => row.id),
        ),
      )
    ).status,
  ).toBe(200);
  expect((await request(worker, namespace, "compact", {})).status).toBe(200);
  const compacted = await bucket.get(key);
  if (compacted === null) throw new Error("Missing compacted fixture root");
  expect(
    Schema.decodeUnknownSync(Root)(await compacted.json()).segments.map(
      (segment) => segment.constantAttributes,
    ),
  ).toEqual([{ year: 2024 }]);
  for (const consistency of ["strong", "edge-eventual"] as const) {
    const response = await request(worker, namespace, "query", {
      ...query,
      consistency,
      minimumSequence: 5,
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(result.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 10).padStart(3, "0")),
    );
  }
});
