import { expect, test } from "bun:test";
import { Schema } from "effect";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  initSync,
  pack,
  unpack,
  tokenize,
  segment_bloom,
  segment_bloom_filter_many,
  segment_term_bounds,
  segment_overview_project,
  segment_correlated_overview,
  segment_document,
  Segment,
  Directory,
  directory_compress,
  BloomBatch,
  PreparedQuery,
  FrequencyPage,
  EligibilityQuery,
} from "../dist/wasm/raio_engine";
import {
  StoredDocument,
  PostingSpans,
  SegmentHeader,
  Filter,
  TermCatalog,
  ProjectedTermCatalog,
  EligibilityProjection,
  TermSummaries,
  TermSummary,
  EligibleMinimum,
  RankingInput,
  SegmentHits,
} from "../src/protocol";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("real WASM log codec survives Unicode and rejects corrupted compressed data", () => {
  const input = JSON.stringify({ text: "ação 日本語".repeat(10000) });
  const bytes = pack(input);
  expect(bytes.length).toBeLessThan(input.length / 5);
  expect(unpack(bytes)).toBe(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(12, view.getUint8(12) ^ 1);
  expect(() => unpack(bytes)).toThrow("InvalidChecksum");
});

test("WASM zlib checksums agree with the native decoder across vector and block boundaries", () => {
  for (const length of [
    0, 15, 16, 31, 32, 63, 64, 127, 128, 255, 4095, 4096, 5551, 5552, 5553, 65535, 65536,
  ]) {
    const input = "x".repeat(length);
    const encoded = pack(input);
    expect(inflateSync(encoded.subarray(16)).toString()).toBe(input);
    expect(unpack(encoded)).toBe(input);
    const corrupted = encoded.slice();
    const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
    const last = corrupted.byteLength - 1;
    view.setUint8(last, view.getUint8(last) ^ 1);
    expect(() => unpack(corrupted)).toThrow("InvalidCompression");
  }
});

test("WASM text tokenization agrees across normalization forms", () => {
  expect(tokenize("CAFÉ São ﬂores")).toBe("cafe sao flores");
  expect(tokenize("cafe\u0301")).toBe(tokenize("café"));
});

test("directory parsing rejects invalid UTF-8 even with a valid header checksum", () => {
  const segment = new Segment(
    JSON.stringify([{ id: "café", text: "alpha", attributes: { city: "São Paulo" } }]),
  );
  const encoded = new TextEncoder().encode(segment.header_json());
  const position = encoded.findIndex((byte) => byte === 0xc3);
  expect(position).toBeGreaterThanOrEqual(0);
  for (const invalid of [0xff, 0xc0]) {
    const json = encoded.slice();
    json[position] = invalid;
    const frame = new Uint8Array(16 + json.byteLength);
    frame.set(new TextEncoder().encode("RAIOSEG1"));
    const view = new DataView(frame.buffer);
    view.setUint32(8, json.byteLength, true);
    view.setUint32(12, crc32(json), true);
    frame.set(json, 16);
    expect(() => new Directory(frame)).toThrow();
  }
  const directory = new Directory(segment.bytes());
  expect(
    Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(
      directory.minimum('[{"field":"city","op":"eq","value":"São Paulo"}]'),
    ),
  ).toEqual([0, 1]);
  directory.free();
  segment.free();
});

test("WASM codec enforces the log-size budget", () => {
  expect(() => pack("x".repeat(2 * 1024 * 1024 + 1))).toThrow("TooLarge");
  expect(() => unpack(new Uint8Array(15))).toThrow("InvalidHeader");
});

test("compressed overviews preserve term bounds and exact filter minima across selectors", () => {
  const segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))([
      { id: "a", revision: 1, title: "", text: "cafe rust", attributes: { group: 1 } },
      {
        id: "b",
        revision: 1,
        title: "title",
        text: "rust rust cloudflare",
        attributes: { group: 2 },
      },
    ]),
  );
  const directory = new Directory(segment.bytes());
  for (const filters of [
    [],
    [{ field: "group", op: "eq", value: 2 }],
    [{ field: "group", op: "eq", value: 3 }],
  ]) {
    const encodedFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(
      Schema.decodeUnknownSync(Schema.Array(Filter))(filters),
    );
    const overview = directory.overview();
    for (const terms of [["rust"], ["cafe", "absent"], ["cloudflare", "rust"]]) {
      const encodedTerms = JSON.stringify(terms);
      expect(
        Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
          segment_overview_project(overview, encodedTerms, encodedFilters),
        ),
      ).toEqual({
        partitions: null,
        dictionary: Schema.decodeSync(Schema.fromJsonString(TermSummaries))(
          directory.summary(encodedTerms),
        ),
        minimum: Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(
          directory.minimum(encodedFilters),
        ),
      });
    }
    const corrupted = overview.slice();
    corrupted[4] = (corrupted[4] ?? 0) ^ 1;
    expect(() => segment_overview_project(corrupted, '["rust"]', encodedFilters)).toThrow();
    expect(() =>
      segment_overview_project(
        overview,
        JSON.stringify(Array.from({ length: 65 }, () => "rust")),
        encodedFilters,
      ),
    ).toThrow("64 terms");
  }
  directory.free();
  segment.free();
});

test("shared attribute groups preserve minima across operators and different document lengths", () => {
  const segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))([
      {
        id: "a",
        revision: 1,
        title: "one two three",
        text: "same",
        attributes: { group: 1, year: 2020, flag: true, nullable: null },
      },
      {
        id: "b",
        revision: 1,
        title: "one",
        text: "same same same same",
        attributes: { nullable: null, flag: true, year: 2020, group: 1 },
      },
      {
        id: "c",
        revision: 1,
        title: "",
        text: "same same",
        attributes: { group: 1, year: 2021, flag: false },
      },
      {
        id: "d",
        revision: 1,
        title: "one",
        text: "same",
        attributes: { group: 2, year: 2020, flag: true },
      },
      { id: "e", revision: 1, title: "one", text: "same", attributes: {} },
    ]),
  );
  const directory = new Directory(segment.bytes());
  const overview = directory.overview();
  for (const predicate of [
    [],
    [
      { field: "group", op: "eq", value: 1 },
      { field: "year", op: "eq", value: 2020 },
    ],
    [
      { field: "year", op: "gte", value: 2020 },
      { field: "year", op: "lte", value: 2020 },
    ],
    [{ field: "group", op: "ne", value: 1 }],
    [{ field: "nullable", op: "eq", value: null }],
    [{ field: "nullable", op: "exists", value: false }],
    [{ field: "flag", op: "eq", value: true }],
    [{ field: "group", op: "in", value: [1, 2] }],
    [{ field: "year", op: "gt", value: 2020 }],
    [{ field: "year", op: "gte", value: 2021 }],
    [{ field: "year", op: "lt", value: 2021 }],
    [{ field: "year", op: "lte", value: 2019 }],
  ]) {
    const filters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(
      Schema.decodeUnknownSync(Schema.Array(Filter))(predicate),
    );
    const catalog = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
      segment_overview_project(overview, '["same","absent"]', filters),
    );
    expect(catalog.minimum).toEqual(
      Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(directory.minimum(filters)),
    );
  }
  directory.free();
  segment.free();
});

test("overview projection validates every pool entry and reference before selecting terms", () => {
  for (const json of [
    '[{"unused":0},[[{},0,0]],null,[{"df":"bad","bounds":[]}]]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0,-1]]}]]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0]]}]]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0,1,0]]}]]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0,4294967296]]}]]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1}]]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[],"bounds":[]}]]',
    '[{"unused":1},[[{},0,0]],null,[{"df":1,"bounds":[]}]]',
    '[{"unused":-1},[[{},0,0]],null,[]]',
    '[{"unused":0.5},[[{},0,0]],null,[]]',
    '[{"unused":4294967296},[[{},0,0]],null,[]]',
    '[{},[["invalid",0,0]],null,[]]',
    "[{},[[[],0,0]],null,[]]",
    '[{},[[{"unused":1e400},0,0]],null,[]]',
    '[{},[[{"unused":"\\ud800"},0,0]],null,[]]',
    "[{},[[{},0,-1]],null,[]]",
    "[{},[[{},0,0,0]],null,[]]",
    "[{},[],null,[]]",
    "[{},[[{},0,0]],null]",
    "[{},[[{},0,0]],null,[],0]",
    "[{},[[{},0,0]],null,[]] trailing",
    '{"dictionary":{},"eligibility":[[{},0,0]],"partitions":null}',
    '[{},[[{},0,0]],null,[{"df":"bad","bounds":[]}]]',
    '[{},[[{},0,0]],[{"unused":1}],[{"df":1,"bounds":[]}]]',
    '[{"unused":1,"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[]}]]',
    '[{"unused":{"df":"bad","bounds":[]}},[[{},0,0]],null,[]]',
    '[{"unused":{"df":1,"bounds":[[0,1,0,-1]]}},[[{},0,0]],null,[]]',
    '[{"unused":{"df":1,"bounds":[],"bounds":[]}},[[{},0,0]],null,[]]',
  ]) {
    const data = new TextEncoder().encode(json);
    const compressed = deflateSync(data);
    const bytes = new Uint8Array(8 + compressed.byteLength);
    const frame = new DataView(bytes.buffer);
    frame.setUint32(0, data.byteLength, true);
    frame.setUint32(4, crc32(data), true);
    bytes.set(compressed, 8);
    expect(() => segment_overview_project(bytes, '["wanted"]', "[]")).toThrow();
  }
});

test("overview projection rejects invalid UTF-8 inside unrequested dictionary keys", () => {
  const json = '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[]}]]';
  for (const invalid of [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const data = new TextEncoder().encode(json);
    data.set(invalid, json.indexOf("unused"));
    const compressed = deflateSync(data);
    const bytes = new Uint8Array(8 + compressed.byteLength);
    const frame = new DataView(bytes.buffer);
    frame.setUint32(0, data.byteLength, true);
    frame.setUint32(4, crc32(data), true);
    bytes.set(compressed, 8);
    expect(() => segment_overview_project(bytes, '["wanted"]', "[]")).toThrow();
  }
});

test("overview pool aliases and inline summaries preserve escaped duplicate keys", () => {
  const json =
    '[{"alias":0,"wanted":{"df":1,"bounds":[[0,1,0,1]]},"w\\u0061nted":0},[[{},0,0]],[{"alias":{"df":2,"bounds":[[0,1,0,1]]},"unused":0}],[{"df":2,"bounds":[[0,1,0,1]]}]]';
  const data = new TextEncoder().encode(json);
  const compressed = deflateSync(data);
  const bytes = new Uint8Array(8 + compressed.byteLength);
  const frame = new DataView(bytes.buffer);
  frame.setUint32(0, data.byteLength, true);
  frame.setUint32(4, crc32(data), true);
  bytes.set(compressed, 8);
  const projected = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
    segment_overview_project(bytes, '["alias","wanted"]', "[]"),
  );
  const summary = { df: 2, bounds: [[0, 1, 0, 1]] } as const;
  expect(projected.dictionary).toEqual({ alias: summary, wanted: summary });
  expect(projected.partitions).toEqual([{ alias: summary }]);
});

test("bounded overview interning preserves inline summaries after the pool fills", () => {
  const documents = Array.from({ length: 5000 }, (_, index) => ({
    id: String(index).padStart(5, "0"),
    title: "title ".repeat(index % 71),
    text: `unique${index} ${"body ".repeat(Math.floor(index / 71))}`,
    attributes: {},
  }));
  using segment = new Segment(JSON.stringify(documents));
  using directory = new Directory(segment.bytes());
  const overview = directory.overview();
  const fields = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
    JSON.parse(new TextDecoder().decode(inflateSync(overview.subarray(8)))),
  );
  const dictionary = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    fields[0],
  );
  const pool = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(fields[3]);
  expect(pool.length).toBeGreaterThan(0);
  expect(pool.length).toBeLessThan(documents.length);
  expect(Object.values(dictionary).some(Schema.is(Schema.Finite))).toBe(true);
  expect(Object.values(dictionary).some(Schema.is(TermSummary))).toBe(true);
  const correlated = segment_correlated_overview(segment.bytes());
  if (correlated === undefined) throw new Error("Missing bounded correlated overview");
  for (const source of [overview, correlated]) {
    for (const terms of ['["unique0","unique4999"]', '["title","body","unique4500"]']) {
      const projected = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
        segment_overview_project(source, terms, "[]"),
      );
      expect(projected.dictionary).toEqual(
        Schema.decodeSync(Schema.fromJsonString(TermSummaries))(directory.summary(terms)),
      );
    }
  }
});

test("overview partitions validate every summary while projecting in one pass", () => {
  const summary = { df: 2, bounds: [[1, 1, 2, 4]] } as const;
  const terms = JSON.stringify(["wanted"]);
  const project = (partitions: string) => {
    const data = new TextEncoder().encode(
      `[{},[[{},0,0]],${partitions},[{"df":2,"bounds":[[1,1,2,4]]}]]`,
    );
    const compressed = deflateSync(data);
    const bytes = new Uint8Array(8 + compressed.byteLength);
    const frame = new DataView(bytes.buffer);
    frame.setUint32(0, data.byteLength, true);
    frame.setUint32(4, crc32(data), true);
    bytes.set(compressed, 8);
    return Schema.decodeUnknownSync(TermCatalog)(
      JSON.parse(segment_overview_project(bytes, terms, "[]")),
    );
  };
  expect(project("null").partitions).toBeNull();
  for (const length of [1, 32]) {
    const partitions = Array.from({ length }, () => ({ wanted: 0, unused: 0 }));
    expect(project(JSON.stringify(partitions)).partitions).toEqual(
      Array.from({ length }, () => ({ wanted: summary })),
    );
  }
  for (const partitions of [
    "[]",
    "{}",
    "[null]",
    JSON.stringify(Array.from({ length: 33 }, () => ({}))),
    '[{"unused":1}]',
    '[{"unused":-1}]',
    '[{"unused":0.5}]',
    '[{}, {"wanted":0}] trailing',
  ]) {
    expect(() => project(partitions)).toThrow();
  }
});

test("WASM ranked hits retain exact document ranges after their directory is released", () => {
  const documents = Schema.decodeSync(Schema.Array(StoredDocument))([
    {
      id: "z",
      revision: 9,
      title: "alpha beta",
      text: "alpha alpha beta",
      attributes: { group: 1 },
    },
    {
      id: "a",
      revision: 2,
      title: "alpha beta alpha beta",
      text: "alpha beta alpha beta",
      attributes: { group: 2, large: "value".repeat(1000) },
    },
    { id: "m", revision: 7, title: "", text: "alpha beta", attributes: { group: 1 } },
    { id: "b", revision: 4, title: "", text: "beta alpha", attributes: { group: 1 } },
    { id: "c", revision: 5, title: "", text: "alpha gamma", attributes: { group: 1 } },
  ]);
  using segment = new Segment(JSON.stringify(documents));
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  for (const sample of [
    { mode: "any", dead: [3], expected: ["z", "b", "c"] },
    { mode: "all", dead: [3], expected: ["z", "b"] },
    { mode: "phrase", dead: [], expected: ["z", "m"] },
  ] as const) {
    const directory = new Directory(bytes);
    using ranker = directory.ranker(
      Schema.encodeSync(Schema.fromJsonString(RankingInput))({
        text: "alpha beta",
        mode: sample.mode,
        top_k: 10,
        dead: sample.dead,
        filters: [{ field: "group", op: "eq", value: 1 }],
        statistics: {
          documents: documents.length,
          title_length: header.total_title_length,
          body_length: header.total_body_length,
          frequencies: Object.fromEntries(
            Object.entries(header.terms).map(([term, meta]) => [term, meta.df]),
          ),
        },
      }),
    );
    const spans = Schema.decodeSync(Schema.fromJsonString(PostingSpans))(ranker.posting_spans());
    for (const span of spans)
      for (const block of span.blocks)
        ranker.add(
          span.term,
          bytes.subarray(base + block.data.offset, base + block.data.offset + block.data.length),
        );
    directory.free();
    const hits = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish());
    expect(hits.map((hit) => hit.id)).toEqual([...sample.expected]);
    for (const hit of hits) {
      const expected = documents.find((document) => document.id === hit.id);
      if (expected === undefined) throw new Error("Unexpected ranked document");
      expect(header.documents[hit.row]?.data).toEqual(hit.data);
      const decoded = Schema.decodeSync(Schema.fromJsonString(StoredDocument))(
        segment_document(
          bytes.subarray(base + hit.data.offset, base + hit.data.offset + hit.data.length),
        ),
      );
      expect(decoded).toEqual(expected);
    }
  }
});

test("WASM batched blooms preserve Unicode membership and reject broken offsets", () => {
  const first = segment_bloom(JSON.stringify(["ação", "日本語"]));
  const second = segment_bloom(JSON.stringify(["rust", "café"]));
  const packed = new Uint8Array(first.length + second.length);
  packed.set(first);
  packed.set(second, first.length);
  const offsets = new Uint32Array([0, first.length, packed.length]);
  const selected = Schema.decodeSync(
    Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
  )(segment_bloom_filter_many(packed, offsets, JSON.stringify(["ação", "日本語", "rust", "café"])));
  expect(selected).toEqual([
    ["ação", "日本語"],
    ["rust", "café"],
  ]);
  expect(() =>
    segment_bloom_filter_many(packed, new Uint32Array([0, packed.length + 1]), "[]"),
  ).toThrow("Invalid bloom offsets");
});

test("WASM Bloom batches read persisted filters across repeated sizes and empty spans", () => {
  const filters = [
    [134, 2, 0, 193, 80, 32, 48, 8],
    [64, 46, 0, 130, 129, 0, 56, 4],
    [24, 9, 228, 16, 209, 71, 195, 11, 102, 152],
    [],
    [134, 2, 0, 193, 80, 32, 48, 8],
    [64, 46, 0, 130, 129, 0, 56, 4],
    [24, 9, 228, 16, 209, 71, 195, 11, 102, 152],
  ];
  const packed = new Uint8Array(filters.flat());
  const offsets = new Uint32Array([0, 8, 16, 26, 26, 34, 42, 52]);
  const selected = Schema.decodeSync(
    Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
  )(
    segment_bloom_filter_many(
      packed,
      offsets,
      JSON.stringify(["ação", "日本語", "rust", "café", "a", "b", "c", "d", "e", "missing"]),
    ),
  );
  expect(selected).toEqual([
    ["ação", "日本語"],
    ["rust", "café"],
    ["a", "b", "c", "d", "e"],
    [],
    ["ação", "日本語"],
    ["rust", "café"],
    ["a", "b", "c", "d", "e"],
  ]);
  expect(Array.from(segment_bloom(JSON.stringify(["ação", "日本語"])))).toEqual([
    134, 2, 0, 193, 80, 32, 48, 8,
  ]);
});

test("WASM term bounds preserve order, empty eligibility and batch limits", () => {
  const statistics = JSON.stringify({
    documents: 100,
    title_length: 100,
    body_length: 1000,
    frequencies: { alpha: 10 },
  });
  const dictionary = { alpha: { df: 10, bounds: [[1, 2, 1, 10]] } };
  const actual = Array.from(
    segment_term_bounds(
      statistics,
      JSON.stringify([
        { dictionary, partitions: null, minimum: [0, 0] },
        { dictionary, partitions: null, minimum: null },
        { dictionary, partitions: null, minimum: [1, 10] },
      ]),
    ),
  );
  expect(actual[0]).toBeGreaterThan(0);
  expect(actual[1]).toBe(0);
  expect(actual[2]).toBe(actual[0]);
  expect(() =>
    segment_term_bounds(
      statistics,
      JSON.stringify(
        Array.from({ length: 65 }, () => ({ dictionary, partitions: null, minimum: null })),
      ),
    ),
  ).toThrow("Term bound batch exceeds segment budget");
});

test("WASM catalog bounds retain global frequencies and filtered length clamps", () => {
  const statistics = {
    documents: 100,
    title_length: 100,
    body_length: 1000,
    frequencies: { alpha: 10, beta: 0, gamma: 101 },
  };
  const bounds = [
    [1, 2, 1, 10],
    [2, 3, 0, 5],
  ];
  const dictionary = Object.fromEntries(
    ["alpha", "beta", "gamma", "missing"].map((term) => [term, { df: 10, bounds }]),
  );
  const catalogs = JSON.stringify([
    { dictionary, partitions: null, minimum: [0, 0] },
    { dictionary, partitions: null, minimum: [10, 100] },
    { dictionary, partitions: null, minimum: null },
    { dictionary: { missing: { df: 10, bounds } }, partitions: null, minimum: [0, 0] },
  ]);
  expect(Array.from(segment_term_bounds(JSON.stringify(statistics), catalogs))).toEqual([
    4.708590140129787, 2.138753190125021, 0, 0,
  ]);
  expect(
    Array.from(segment_term_bounds(JSON.stringify({ ...statistics, documents: 0 }), catalogs)),
  ).toEqual([0, 0, 0, 0]);
});

test("retained Bloom batches own their bytes and preserve direct-reader validation", () => {
  const first = segment_bloom('["ação","日本語"]');
  const second = segment_bloom('["rust","café"]');
  const bytes = new Uint8Array([...first, ...second]);
  const offsets = new Uint32Array([0, first.length, bytes.length, bytes.length]);
  const batch = new BloomBatch(bytes, offsets);
  expect(batch.heap_bytes()).toBeGreaterThanOrEqual(bytes.length + offsets.byteLength);
  for (const values of ['["ação","日本語","rust","café"]', '["absent"]', "[]"])
    expect(batch.filter(values)).toBe(segment_bloom_filter_many(bytes, offsets, values));
  bytes.fill(0);
  offsets.fill(0);
  expect(JSON.parse(batch.filter('["ação","rust"]'))).toEqual([["ação"], ["rust"], []]);
  expect(() => batch.filter("[1]")).toThrow();
  expect(JSON.parse(batch.filter('["café"]'))).toEqual([[], ["café"], []]);
  batch.free();
  for (const invalid of [
    new Uint32Array([]),
    new Uint32Array([1, 0]),
    new Uint32Array([0, 1]),
    new Uint32Array(66),
  ])
    expect(() => new BloomBatch(new Uint8Array(0), invalid)).toThrow();
});

test("prepared queries preserve per-segment masks and outlive their query-plan handle", () => {
  const fixtures = [
    [
      { id: "a", text: "alpha beta", attributes: { group: 1 } },
      { id: "b", text: "beta alpha", attributes: { group: 0 } },
      { id: "c", text: "alpha alpha beta", attributes: { group: 1 } },
    ],
    [
      { id: "d", text: "alpha beta", attributes: { group: 1 } },
      { id: "e", text: "beta", attributes: { group: 1 } },
    ],
  ];
  const segments = fixtures.map((docs) => new Segment(JSON.stringify(docs)));
  const buffers = segments.map((segment) => segment.bytes());
  const directories = buffers.map((bytes) => new Directory(bytes));
  for (const [text, mode] of ["ÁLPHA beta", "beta ÁLPHA", "alpha alpha beta"].flatMap(
    (selectedText) =>
      ["any", "all", "phrase"].map((selectedMode) => [selectedText, selectedMode] as const),
  )) {
    const input = {
      text,
      mode,
      top_k: 10,
      dead: [],
      filters: [{ field: "group", op: "eq", value: 1 }],
      statistics: {
        documents: 4,
        title_length: 0,
        body_length: 8,
        frequencies: { alpha: 3, beta: 4 },
      },
    };
    const query = new PreparedQuery(JSON.stringify(input));
    const rankers = directories.map((directory, index) => {
      const dead = [];
      if (index === 0) dead.push(0);
      return {
        legacy: directory.ranker(JSON.stringify({ ...input, dead })),
        compiled: directory.ranker_prepared(query, JSON.stringify(dead)),
      };
    });
    query.free();
    for (const [index, pair] of rankers.entries()) {
      const bytes = buffers[index];
      if (bytes === undefined) throw new Error("Missing segment");
      const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
      expect(pair.compiled.posting_spans()).toBe(pair.legacy.posting_spans());
      const spans = Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
        pair.legacy.posting_spans(),
      );
      for (const span of spans)
        for (const block of span.blocks) {
          const page = bytes.subarray(
            base + block.data.offset,
            base + block.data.offset + block.data.length,
          );
          pair.legacy.add(span.term, page);
          pair.compiled.add(span.term, page);
        }
      expect(pair.compiled.finish()).toBe(pair.legacy.finish());
      pair.legacy.free();
      pair.compiled.free();
    }
  }
  for (const directory of directories) directory.free();
  for (const segment of segments) segment.free();
});

test("prepared queries reject shared tombstones and preserve query-budget failures", () => {
  const input = {
    text: "alpha",
    mode: "any",
    top_k: 10,
    dead: [],
    filters: [],
    statistics: { documents: 1, title_length: 0, body_length: 1, frequencies: { alpha: 1 } },
  };
  expect(() => new PreparedQuery(JSON.stringify({ ...input, dead: [0] }))).toThrow(
    "empty segment tombstones",
  );
  for (const invalid of [
    { ...input, top_k: 0 },
    { ...input, top_k: 101 },
    { ...input, mode: "invalid" },
    { ...input, text: Array.from({ length: 65 }, (_, index) => `term${index}`).join(" ") },
    { ...input, mode: "phrase", text: "alpha ".repeat(65) },
  ])
    expect(() => new PreparedQuery(JSON.stringify(invalid))).toThrow();
});

test("retained frequency pages preserve dynamic masks, block ordering and positional bounds", () => {
  const segment = new Segment(
    JSON.stringify(
      Array.from({ length: 260 }, (_, index) => ({
        id: String(index).padStart(3, "0"),
        text: "alpha beta alpha",
        attributes: { group: index % 2 },
      })),
    ),
  );
  const bytes = segment.bytes();
  const directory = new Directory(bytes);
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const input = {
    text: "alpha beta",
    mode: "any",
    top_k: 10,
    dead: [],
    filters: [],
    statistics: {
      documents: 260,
      title_length: 0,
      body_length: 780,
      frequencies: { alpha: 260, beta: 260 },
    },
  };
  const probe = directory.ranker(JSON.stringify(input));
  const spans = Schema.decodeSync(Schema.fromJsonString(PostingSpans))(probe.posting_spans());
  const pages = spans.flatMap((span) =>
    span.blocks.map((block) => {
      const data = bytes.subarray(
        base + block.data.offset,
        base + block.data.offset + block.data.length,
      );
      return { term: span.term, bytes: data, page: new FrequencyPage(data) };
    }),
  );
  probe.free();
  for (const mode of ["any", "all"])
    for (const dead of [[], [0, 1, 2]])
      for (const filters of [[], [{ field: "group", op: "eq", value: 1 }]]) {
        const query = JSON.stringify({ ...input, mode, dead, filters });
        const legacy = directory.ranker(query);
        const cached = directory.ranker(query);
        for (const entry of pages) {
          legacy.add(entry.term, entry.bytes);
          cached.add_frequency(entry.term, entry.page);
        }
        expect(cached.finish()).toBe(legacy.finish());
        legacy.free();
        cached.free();
      }
  const first = pages[0];
  if (first === undefined) throw new Error("Missing page");
  const ranker = directory.ranker(JSON.stringify(input));
  ranker.add_frequency(first.term, first.page);
  expect(() => ranker.add_frequency(first.term, first.page)).toThrow("out of order");
  ranker.free();
  const positional = directory.ranker(JSON.stringify({ ...input, mode: "phrase" }));
  expect(() => positional.add_frequency(first.term, first.page)).toThrow("any/all mode");
  positional.free();
  const data = new Uint8Array([1, 0, 0, 1, 99]);
  const compressed = deflateSync(data);
  const frame = new Uint8Array(8 + compressed.length);
  new DataView(frame.buffer).setUint32(0, data.length, true);
  new DataView(frame.buffer).setUint32(4, crc32(data), true);
  frame.set(compressed, 8);
  const invalidPosition = new FrequencyPage(frame);
  const hidden = directory.ranker(JSON.stringify({ ...input, dead: [0] }));
  expect(() => hidden.add_frequency("alpha", invalidPosition)).toThrow("Invalid token position");
  hidden.free();
  invalidPosition.free();
  const broken = first.bytes.slice();
  broken[4] = (broken[4] ?? 0) ^ 1;
  expect(() => new FrequencyPage(broken)).toThrow();
  for (const entry of pages) entry.page.free();
  directory.free();
  segment.free();
});

test("frequency page validation follows exact directory lifetime and never memoizes failure", () => {
  using longSegment = new Segment(
    JSON.stringify(["a", "b"].map((id) => ({ id, text: "alpha ".repeat(101), attributes: {} }))),
  );
  using shortSegment = new Segment(
    JSON.stringify(["a", "b"].map((id) => ({ id, text: "alpha", attributes: {} }))),
  );
  const data = new Uint8Array([2, 0, 0, 1, 99, 1, 0, 1, 99]);
  const compressed = deflateSync(data);
  const frame = new Uint8Array(8 + compressed.length);
  new DataView(frame.buffer).setUint32(0, data.length, true);
  new DataView(frame.buffer).setUint32(4, crc32(data), true);
  frame.set(compressed, 8);
  using page = new FrequencyPage(frame);
  const input = Schema.decodeSync(RankingInput)({
    text: "alpha",
    mode: "any",
    top_k: 10,
    dead: [],
    filters: [],
    statistics: { documents: 2, title_length: 0, body_length: 202, frequencies: { alpha: 2 } },
  });
  const query = Schema.encodeSync(Schema.fromJsonString(RankingInput))(input);
  const first = new Directory(longSegment.bytes());
  const charge = first.heap_bytes();
  const warm = first.ranker(query);
  warm.add_frequency("alpha", page);
  const reference = warm.finish();
  const retained = first.retain();
  warm.free();
  first.free();
  expect(retained.heap_bytes()).toBe(charge);
  const shared = retained.ranker(query);
  shared.add_frequency("alpha", page);
  expect(shared.finish()).toBe(reference);
  expect(retained.heap_bytes()).toBe(charge);
  expect(() => shared.add_frequency("alpha", page)).toThrow("out of order");
  const unrequested = retained.ranker(query);
  expect(() => unrequested.add_frequency("beta", page)).toThrow("Unrequested");
  shared.free();
  unrequested.free();
  retained.free();
  using shortDirectory = new Directory(shortSegment.bytes());
  const hidden = Schema.encodeSync(Schema.fromJsonString(RankingInput))({ ...input, dead: [0, 1] });
  for (const ranker of Array.from({ length: 2 }, () => shortDirectory.ranker(hidden))) {
    using invalid = ranker;
    expect(() => invalid.add_frequency("alpha", page)).toThrow("Invalid token position");
  }
  using reparsed = new Directory(longSegment.bytes());
  expect(reparsed.heap_bytes()).toBe(charge);
  using fresh = reparsed.ranker(query);
  fresh.add_frequency("alpha", page);
  expect(fresh.finish()).toBe(reference);
});

test("cutoff posting pages preserve every competitive hit across modes, masks and Unicode ties", () => {
  const documents = ["😀 alpha beta", "\uE000 beta gamma", "a alpha alpha padding beta"].flatMap(
    (text, group) =>
      Array.from({ length: 512 }, (_, index) => ({
        id: `${text}-${String(index).padStart(4, "0")}`,
        revision: 1,
        title: "alpha ".repeat(index % 2),
        text: `${text} ${"padding ".repeat(index % 17)}`,
        attributes: { group },
      })),
  );
  using segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents),
  );
  const bytes = segment.bytes();
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = new Directory(bytes);
  for (const mode of ["any", "all", "phrase"] as const)
    for (const text of ["alpha beta", "alpha alpha"])
      for (const dead of [[], [0, 128, 512, 1024]])
        for (const filters of [[], [{ field: "group", op: "eq", value: 1 }]] as const) {
          const input = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
            text,
            mode,
            top_k: 100,
            dead,
            filters,
            statistics: {
              documents: documents.length,
              title_length: header.total_title_length,
              body_length: header.total_body_length,
              frequencies: Object.fromEntries(
                Object.entries(header.terms).map(([term, metadata]) => [term, metadata.df]),
              ),
            },
          });
          using full = directory.ranker(input);
          for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
            full.posting_spans(),
          ))
            for (const block of span.blocks)
              full.add(
                span.term,
                bytes.subarray(
                  base + block.data.offset,
                  base + block.data.offset + block.data.length,
                ),
              );
          const expected = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(full.finish());
          for (const score of [
            0.00001,
            ...expected.slice(0, 2).flatMap((hit) => [hit.score, hit.score * 2]),
          ])
            for (const id of ["", "a", "😀", "\uE000", "\uFFFF"]) {
              using pruned = directory.ranker(input);
              for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
                pruned.posting_spans_after(score, id),
              ))
                for (const block of span.blocks)
                  pruned.add(
                    span.term,
                    bytes.subarray(
                      base + block.data.offset,
                      base + block.data.offset + block.data.length,
                    ),
                  );
              const actual = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(pruned.finish());
              expect(
                actual.filter((hit) => hit.score > score || (hit.score === score && hit.id < id)),
              ).toEqual(
                expected.filter((hit) => hit.score > score || (hit.score === score && hit.id < id)),
              );
            }
          for (const score of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
            expect(() => full.posting_spans_after(score, "a")).toThrow("Invalid ranking cutoff");
        }
});

test("cutoff equality uses UTF-16 identifiers before discarding tied pages", () => {
  using segment = new Segment(
    JSON.stringify(
      ["a", "😀", "\uE000"].flatMap((prefix) =>
        Array.from({ length: 128 }, (_, index) => ({
          id: `${prefix}-${String(index).padStart(4, "0")}`,
          text: "alpha beta",
          attributes: {},
        })),
      ),
    ),
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = new Directory(bytes);
  using ranker = directory.ranker(
    Schema.encodeSync(Schema.fromJsonString(RankingInput))({
      text: "alpha beta",
      mode: "any",
      top_k: 100,
      dead: [],
      filters: [],
      statistics: {
        documents: 384,
        title_length: 0,
        body_length: 768,
        frequencies: { alpha: 384, beta: 384 },
      },
    }),
  );
  const complete = ranker.posting_spans();
  for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(complete))
    for (const block of span.blocks)
      ranker.add(
        span.term,
        bytes.subarray(base + block.data.offset, base + block.data.offset + block.data.length),
      );
  const cutoff = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish())[0];
  if (cutoff === undefined) throw new Error("Missing cutoff");
  expect(ranker.posting_spans_after(cutoff.score, "")).toBe("[]");
  expect(ranker.posting_spans_after(cutoff.score + 1e-13, "")).toBe(complete);
  expect(ranker.posting_spans_after(cutoff.score + 1e-11, "")).toBe("[]");
  expect(ranker.posting_spans_after(cutoff.score, "\uFFFF")).toBe(complete);
  const spans = Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
    ranker.posting_spans_after(cutoff.score, "😀"),
  );
  expect(spans).toHaveLength(2);
  for (const span of spans) {
    expect(span.blocks).toHaveLength(1);
    expect(span.blocks[0].first).toBe(0);
    expect(span.blocks[0].last).toBe(127);
  }
});

test("dense term seed cutoffs preserve complete top-k including their own cutoff row", () => {
  const fixtures = [
    ["alpha beta", "beta alpha", "alpha gamma beta"].flatMap((text, group) =>
      Array.from({ length: 256 }, (_, index) => ({
        id: `${group}-${String(index).padStart(4, "0")}`,
        title: "alpha ".repeat(index % 3),
        text: `${text} ${"padding ".repeat(index % 17)}`,
        attributes: { group },
      })),
    ),
    [
      { title: "alpha", text: "beta" },
      { title: "beta", text: "alpha" },
    ].flatMap((seed, group) =>
      Array.from({ length: 256 }, (_, index) => ({
        id: `${group}-${String(index).padStart(4, "0")}`,
        title: `${seed.title} `.repeat(1 + (index % 3)),
        text: `${seed.text} ${"gamma ".repeat(index % 17)}`,
        attributes: { group },
      })),
    ),
  ];
  for (const docs of fixtures) {
    using segment = new Segment(JSON.stringify(docs));
    const bytes = segment.bytes();
    const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
    const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
    using directory = new Directory(bytes);
    for (const mode of ["any", "all", "phrase"] as const)
      for (const text of ["alpha beta", "alpha gamma", "alpha alpha", "missing"])
        for (const top_k of [1, 10, 100])
          for (const dead of [[], [0, 1, 128, 256]])
            for (const filters of [[], [{ field: "group", op: "eq", value: 1 }]] as const) {
              const input = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
                text,
                mode,
                top_k,
                dead,
                filters,
                statistics: {
                  documents: docs.length,
                  title_length: header.total_title_length,
                  body_length: header.total_body_length,
                  frequencies: Object.fromEntries(
                    Object.entries(header.terms).map(([term, meta]) => [term, meta.df]),
                  ),
                },
              });
              using full = directory.ranker(input);
              using seeded = directory.ranker(input);
              for (const [ranker, spans] of [
                [full, full.posting_spans()],
                [seeded, seeded.posting_spans_seeded()],
              ] as const)
                for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(spans))
                  for (const block of span.blocks)
                    ranker.add(
                      span.term,
                      bytes.subarray(
                        base + block.data.offset,
                        base + block.data.offset + block.data.length,
                      ),
                    );
              expect(seeded.finish()).toBe(full.finish());
            }
  }
});

test("seed ties retain top-k one and a kth row at the first eligible row of a page", () => {
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 2048 }, (_, index) => ({
        id: String(index).padStart(5, "0"),
        text: "alpha beta",
        attributes: { selected: index % 128 === 0 },
      })),
    ),
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = new Directory(bytes);
  for (const mode of ["any", "all", "phrase"] as const)
    for (const top_k of [1, 10, 100])
      for (const dead of [[], [0, 128, 256]]) {
        const input = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
          text: "alpha beta",
          mode,
          top_k,
          dead,
          filters: [{ field: "selected", op: "eq", value: true }],
          statistics: {
            documents: 2048,
            title_length: 0,
            body_length: 4096,
            frequencies: { alpha: 2048, beta: 2048 },
          },
        });
        using full = directory.ranker(input);
        using seeded = directory.ranker(input);
        for (const [ranker, spans] of [
          [full, full.posting_spans()],
          [seeded, seeded.posting_spans_seeded()],
        ] as const)
          for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(spans))
            for (const block of span.blocks)
              ranker.add(
                span.term,
                bytes.subarray(
                  base + block.data.offset,
                  base + block.data.offset + block.data.length,
                ),
              );
        expect(seeded.finish()).toBe(full.finish());
      }
});

test("eligible document lengths prune filtered pages while preserving sparse top-k", () => {
  const docs = Array.from({ length: 16 }, (_, page) => [
    {
      id: String(page * 128).padStart(5, "0"),
      text: `alpha beta ${"padding ".repeat(10 + 20 * (page % 2))}`,
      attributes: { selected: true },
    },
    ...Array.from({ length: 127 }, (_document, row) => ({
      id: String(page * 128 + row + 1).padStart(5, "0"),
      text: "alpha beta",
      attributes: { selected: false },
    })),
  ]).flat();
  using segment = new Segment(JSON.stringify(docs));
  const bytes = segment.bytes();
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = new Directory(bytes);
  for (const [top_k, expected] of [
    [1, 2],
    [4, 8],
    [10, 20],
    [100, 32],
  ] as const) {
    const input = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
      text: "alpha beta",
      mode: "all",
      top_k,
      dead: [],
      filters: [{ field: "selected", op: "eq", value: true }],
      statistics: {
        documents: 2048,
        title_length: 0,
        body_length: header.total_body_length,
        frequencies: { alpha: 2048, beta: 2048 },
      },
    });
    using full = directory.ranker(input);
    using pruned = directory.ranker(input);
    const complete = Schema.decodeSync(Schema.fromJsonString(PostingSpans))(full.posting_spans());
    const selected = Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
      pruned.posting_spans_seeded(),
    );
    expect(complete.reduce((count, span) => count + span.blocks.length, 0)).toBe(32);
    expect(selected.reduce((count, span) => count + span.blocks.length, 0)).toBe(expected);
    for (const [ranker, spans] of [
      [full, complete],
      [pruned, selected],
    ] as const)
      for (const span of spans)
        for (const block of span.blocks)
          ranker.add(
            span.term,
            bytes.subarray(base + block.data.offset, base + block.data.offset + block.data.length),
          );
    expect(pruned.finish()).toBe(full.finish());
  }
});

test("compact directories validate framing, checksums and header semantics", () => {
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 128 }, (_, index) => ({
        id: String(index).padStart(4, "0"),
        text: "alpha beta",
        attributes: { state: "initial" },
      })),
    ),
  );
  const bytes = segment.bytes();
  const length = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const encoded = directory_compress(bytes.subarray(0, length));
  const compact = inflateSync(encoded.subarray(20));
  const covered = new Uint8Array(16 + compact.length);
  covered.set(encoded.subarray(0, 16));
  covered.set(compact, 16);
  expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(16, true)).toBe(crc32(covered));
  expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(12, true)).toBe(compact.length);
  expect(compact[0]).toBe(1);
  const invalid = new Uint8Array(compact);
  invalid[0] = 2;
  const compressed = deflateSync(invalid);
  const forged = new Uint8Array(20 + compressed.byteLength);
  forged.set(encoded.subarray(0, 20));
  forged.set(compressed, 20);
  expect(() => Directory.compressed(forged, length, 40 * 1024 * 1024)).toThrow();
  covered.set(forged.subarray(0, 16));
  covered.set(invalid, 16);
  new DataView(forged.buffer).setUint32(16, crc32(covered), true);
  expect(() => Directory.compressed(forged, length, 40 * 1024 * 1024)).toThrow("version");
  const damaged = encoded.slice();
  const checksum = damaged[16];
  if (checksum === undefined) throw new Error("Missing directory checksum");
  damaged[16] = checksum ^ 1;
  expect(() => Directory.compressed(damaged, length, 40 * 1024 * 1024)).toThrow();
  const legacy = encoded.slice();
  legacy.set(new TextEncoder().encode("RAIODIR2"));
  expect(() => Directory.compressed(legacy, length, 40 * 1024 * 1024)).toThrow();
});

test("compressed directories reject both output length mismatches and incomplete zlib streams", () => {
  using segment = new Segment(
    JSON.stringify([
      { id: "compressed", text: "alpha", attributes: { padding: "x".repeat(65536) } },
    ]),
  );
  const bytes = segment.bytes();
  const length = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const encoded = directory_compress(bytes.subarray(0, length));
  using directory = Directory.compressed(encoded, length, 40 * 1024 * 1024);
  using canonical = new Directory(bytes.subarray(0, length));
  expect(directory.terms('["alpha"]')).toBe(canonical.terms('["alpha"]'));
  for (const delta of [-1, 1]) {
    const invalid = encoded.slice();
    new DataView(invalid.buffer, invalid.byteOffset).setUint32(8, length + delta, true);
    expect(() => Directory.compressed(invalid, length + delta, 40 * 1024 * 1024)).toThrow();
  }
  for (const missing of [1, 4, 8])
    expect(() =>
      Directory.compressed(encoded.subarray(0, encoded.length - missing), length, 40 * 1024 * 1024),
    ).toThrow();
  const damaged = encoded.slice();
  const end = damaged.length - 1;
  const checksum = damaged[end];
  if (checksum === undefined) throw new Error("Missing zlib checksum");
  damaged[end] = checksum ^ 1;
  expect(() => Directory.compressed(damaged, length, 40 * 1024 * 1024)).toThrow();
});

test("compact term envelopes preserve full-block maxima and filter minima exactly", () => {
  using segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(
      Array.from({ length: 768 }, (_, index) => ({
        id: String(index).padStart(4, "0"),
        revision: 1,
        title: "alpha ".repeat((index % 4) + (Math.floor(index / 128) % 3)),
        text: `alpha beta ${"gamma ".repeat(1 + (index % 8))}`,
        attributes: { group: index % 3 },
      })),
    ),
  );
  using directory = new Directory(segment.bytes());
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const terms = ["alpha", "beta", "gamma"];
  const encodedTerms = JSON.stringify(terms);
  const compact = Schema.decodeSync(Schema.fromJsonString(TermSummaries))(
    directory.summary(encodedTerms),
  );
  const full = Object.fromEntries(
    terms.map((term) => {
      const metadata = header.terms[term];
      if (metadata === undefined) throw new Error("Missing fixture term");
      return [
        term,
        {
          df: metadata.df,
          bounds: metadata.blocks.map((block) => [
            block.max_title_tf,
            block.max_body_tf,
            block.min_title_length,
            block.min_body_length,
          ]),
        },
      ] as const;
    }),
  );
  for (const [term, metadata] of Object.entries(compact)) {
    const original = full[term];
    if (original === undefined) throw new Error("Missing original term summary");
    expect(metadata.df).toBe(original.df);
    expect(metadata.bounds).toHaveLength(3);
  }
  for (const documents of [768, 1536, 4096])
    for (const minimum of [null, [0, 0], [2, 6]]) {
      const statistics = JSON.stringify({
        documents,
        title_length: header.total_title_length + 1,
        body_length: header.total_body_length * 2 + 1,
        frequencies: Object.fromEntries(terms.map((term) => [term, 768])),
      });
      const bounds = Array.from(
        segment_term_bounds(
          statistics,
          JSON.stringify([
            { dictionary: full, minimum, partitions: null },
            { dictionary: compact, minimum, partitions: null },
          ]),
        ),
      );
      expect(bounds[0]).toBe(bounds[1]);
    }
  for (const filters of [
    [],
    [{ field: "group", op: "eq", value: 1 }],
    [{ field: "group", op: "eq", value: 99 }],
  ]) {
    const encodedFilters = JSON.stringify(filters);
    const projected = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
      segment_overview_project(directory.overview(), encodedTerms, encodedFilters),
    );
    expect(projected.dictionary).toEqual(compact);
    expect(projected.minimum).toEqual(
      Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(directory.minimum(encodedFilters)),
    );
  }
});

test("field eligibility retains numeric wire values, missing cells and query scope", () => {
  using segment = new Segment(
    '[{"id":"a","revision":1,"title":"","text":"alpha","attributes":{"year":2.0}},{"id":"b","revision":1,"title":"","text":"alpha alpha","attributes":{"year":9007199254740993}},{"id":"c","revision":1,"title":"","text":"alpha","attributes":{"year":null}},{"id":"d","revision":1,"title":"","text":"alpha alpha alpha","attributes":{}}]',
  );
  using directory = new Directory(segment.bytes());
  const warm = '[{"field":"year","op":"exists","value":true}]';
  const projected = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(directory.overview(), '["alpha"]', warm),
  );
  if (projected.eligibility === null) throw new Error("Missing eligibility projection");
  if (projected.eligibility.data.kind !== "joint") throw new Error("Expected joint projection");
  const raw = projected.eligibility.data.groups.flatMap(([values]) => values.flat());
  expect(raw).toContain("2.0");
  expect(raw).toContain("9007199254740993");
  const encoded = Schema.encodeSync(Schema.fromJsonString(EligibilityProjection))(
    projected.eligibility,
  );
  for (const filters of [
    '[{"field":"year","op":"eq","value":2}]',
    '[{"field":"year","op":"ne","value":2}]',
    '[{"field":"year","op":"eq","value":9007199254740992}]',
    '[{"field":"year","op":"ne","value":9007199254740992}]',
    '[{"field":"year","op":"eq","value":null}]',
    '[{"field":"year","op":"exists","value":false}]',
  ]) {
    using query = new EligibilityQuery(filters);
    expect(query.minimum(encoded)).toBe(directory.minimum(filters));
  }
  using query = new EligibilityQuery(warm);
  expect(() => query.minimum(" ".repeat(4097))).toThrow();
  expect(() =>
    query.minimum(JSON.stringify({ ...projected.eligibility, fields: ["other"] })),
  ).toThrow();
  expect(() =>
    query.minimum('{"fields":["year"],"data":{"kind":"joint","groups":[[[["[]"]],0,0]]}}'),
  ).toThrow();
});

test("oversized field projections retain the original minimum fallback", () => {
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 1000 }, (_, index) => ({
        id: String(index),
        revision: 1,
        title: "",
        text: "alpha ".repeat(1 + (index % 3)),
        attributes: { year: index },
      })),
    ),
  );
  using directory = new Directory(segment.bytes());
  const filters = '[{"field":"year","op":"gte","value":500}]';
  const projected = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(directory.overview(), '["alpha"]', filters),
  );
  expect(projected.eligibility).toBeNull();
  expect(projected.minimum).toEqual(
    Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(directory.minimum(filters)),
  );
  using large = new Segment(
    JSON.stringify([
      {
        id: "large",
        revision: 1,
        title: "",
        text: "alpha",
        attributes: { note: "x".repeat(8192) },
      },
    ]),
  );
  using largeDirectory = new Directory(large.bytes());
  const largeFilters = '[{"field":"note","op":"exists","value":true}]';
  const largeProjection = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(largeDirectory.overview(), '["alpha"]', largeFilters),
  );
  expect(largeProjection.eligibility).toBeNull();
  expect(largeProjection.minimum).toEqual(
    Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(largeDirectory.minimum(largeFilters)),
  );
});

test("indexed eligibility predicates preserve field order, duplicates and every scalar operator", () => {
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 12 }, (_, index) => ({
        id: String(index),
        revision: 1,
        title: "alpha ".repeat(index % 3),
        text: "alpha ".repeat(1 + (index % 4)),
        attributes: { year: index, group: index % 2, flag: index % 3 === 0 },
      })),
    ),
  );
  using directory = new Directory(segment.bytes());
  const encodeFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)));
  const cases = Schema.decodeSync(Schema.Array(Schema.Array(Filter)))([
    [{ field: "year", op: "eq", value: 4 }],
    [{ field: "year", op: "ne", value: 4 }],
    [{ field: "year", op: "gt", value: 4 }],
    [{ field: "year", op: "gte", value: 4 }],
    [{ field: "year", op: "lt", value: 4 }],
    [{ field: "year", op: "lte", value: 4 }],
    [{ field: "year", op: "in", value: [0, 3, 6] }],
    [{ field: "absent", op: "exists", value: false }],
    [
      { field: "year", op: "gt", value: 2 },
      { field: "group", op: "eq", value: 1 },
      { field: "year", op: "lt", value: 8 },
      { field: "flag", op: "eq", value: true },
    ],
    [
      { field: "year", op: "gt", value: 2 },
      { field: "year", op: "lt", value: 2 },
    ],
  ]);
  for (const filters of cases) {
    const encodedFilters = encodeFilters(filters);
    const projected = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
      segment_overview_project(directory.overview(), '["alpha"]', encodedFilters),
    );
    if (projected.eligibility === null) throw new Error("Missing eligibility projection");
    const encoded = Schema.encodeSync(Schema.fromJsonString(EligibilityProjection))(
      projected.eligibility,
    );
    using query = new EligibilityQuery(encodedFilters);
    using reversed = new EligibilityQuery(encodeFilters(filters.toReversed()));
    expect(query.minimum(encoded)).toBe(directory.minimum(encodedFilters));
    expect(reversed.minimum(encoded)).toBe(query.minimum(encoded));
  }
});

test("marginal eligibility bounds remain conservative across scalar predicates", () => {
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 1400 }, (_, index) => ({
        id: String(index),
        revision: 1,
        title: "alpha ".repeat(index % 5),
        text: "alpha ".repeat(1 + (index % 13)),
        attributes: { group: index % 100, year: 2020 + (index % 7) },
      })),
    ),
  );
  using directory = new Directory(segment.bytes());
  const encodeFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)));
  const warm = encodeFilters([
    { field: "group", op: "exists", value: true },
    { field: "year", op: "exists", value: true },
  ]);
  const projected = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(directory.overview(), '["alpha"]', warm),
  );
  if (projected.eligibility?.data.kind !== "marginal")
    throw new Error("Expected bounded marginal projection");
  expect(projected.eligibility.data.columns.map((column) => column.length)).toEqual([100, 7]);
  const encoded = Schema.encodeSync(Schema.fromJsonString(EligibilityProjection))(
    projected.eligibility,
  );
  expect(encoded.length).toBeLessThanOrEqual(4096);
  const cases = Schema.decodeSync(Schema.Array(Schema.Array(Filter)))([
    [
      { field: "group", op: "eq", value: 72 },
      { field: "year", op: "gte", value: 2021 },
    ],
    [
      { field: "group", op: "ne", value: 72 },
      { field: "year", op: "lt", value: 2024 },
    ],
    [
      { field: "group", op: "in", value: [0, 42, 99] },
      { field: "year", op: "gt", value: 2020 },
    ],
    [
      { field: "group", op: "lte", value: 2 },
      { field: "year", op: "eq", value: 2026 },
    ],
    [
      { field: "group", op: "gte", value: 0 },
      { field: "year", op: "exists", value: false },
    ],
    [
      { field: "group", op: "eq", value: 100 },
      { field: "year", op: "exists", value: true },
    ],
    [
      { field: "group", op: "gt", value: 50 },
      { field: "group", op: "lt", value: 20 },
      { field: "year", op: "ne", value: null },
    ],
  ]);
  for (const filters of cases) {
    const input = encodeFilters(filters);
    using query = new EligibilityQuery(input);
    const lower = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(query.minimum(encoded));
    const exact = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(
      directory.minimum(input),
    );
    if (exact !== null) {
      expect(lower).not.toBeNull();
      if (lower === null) throw new Error("Lost eligible documents");
      expect(lower[0]).toBeLessThanOrEqual(exact[0]);
      expect(lower[1]).toBeLessThanOrEqual(exact[1]);
    }
    if (lower === null) expect(exact).toBeNull();
  }
  using query = new EligibilityQuery(warm);
  expect(() =>
    query.minimum(
      JSON.stringify({ ...projected.eligibility, data: { kind: "marginal", columns: [] } }),
    ),
  ).toThrow();
  expect(() =>
    query.minimum(
      JSON.stringify({
        ...projected.eligibility,
        data: { kind: "marginal", columns: [[["[]", 0, 0]], [["0", 0, 0]]] },
      }),
    ),
  ).toThrow();
});

test("marginal bounds preserve missing and null values without assuming field correlation", () => {
  const attributes = [{}, { flag: null }, { flag: true }, { flag: false }];
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 2800 }, (_, index) => ({
        id: String(index),
        revision: 1,
        title: "alpha ".repeat(index % 5),
        text: "alpha ".repeat(1 + (index % 13)),
        attributes: { group: index % 100, year: 2020 + (index % 7), ...attributes[index % 4] },
      })),
    ),
  );
  using directory = new Directory(segment.bytes());
  const encodeFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)));
  const common = [
    { field: "group", op: "gte", value: 0 },
    { field: "year", op: "gte", value: 2020 },
  ] as const;
  const warm = encodeFilters([...common, { field: "flag", op: "exists", value: true }]);
  const projected = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(directory.overview(), '["alpha"]', warm),
  );
  if (projected.eligibility?.data.kind !== "marginal")
    throw new Error("Expected marginal projection");
  const encoded = Schema.encodeSync(Schema.fromJsonString(EligibilityProjection))(
    projected.eligibility,
  );
  const cases = Schema.decodeSync(Schema.Array(Filter))([
    { field: "flag", op: "eq", value: null },
    { field: "flag", op: "ne", value: null },
    { field: "flag", op: "exists", value: false },
    { field: "flag", op: "exists", value: true },
    { field: "flag", op: "in", value: [true, null] },
  ]);
  for (const predicate of cases) {
    const filters = encodeFilters([...common, predicate]);
    using query = new EligibilityQuery(filters);
    const lower = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(query.minimum(encoded));
    const exact = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(
      directory.minimum(filters),
    );
    expect(lower).not.toBeNull();
    expect(exact).not.toBeNull();
    if (lower === null || exact === null) throw new Error("Lost scalar eligibility");
    expect(lower[0]).toBeLessThanOrEqual(exact[0]);
    expect(lower[1]).toBeLessThanOrEqual(exact[1]);
  }
  const impossible = encodeFilters([
    { field: "group", op: "eq", value: 0 },
    { field: "year", op: "gte", value: 2020 },
    { field: "flag", op: "eq", value: true },
  ]);
  using query = new EligibilityQuery(impossible);
  expect(directory.minimum(impossible)).toBe("null");
  expect(query.minimum(encoded)).not.toBe("null");
});

test("encoded eligibility scalar validation survives bounded reuse and rejects invalid values", () => {
  const decode = Schema.decodeExit(EligibilityProjection);
  for (const index of Array.from({ length: 600 }, (_, value) => value)) {
    expect(
      decode({ fields: ["year"], data: { kind: "marginal", columns: [[[String(index), 0, 0]]] } })
        ._tag,
    ).toBe("Success");
  }
  for (const value of [
    "[]",
    "{}",
    "undefined",
    "NaN",
    "Infinity",
    "1e309",
    '"\\ud800"',
    '"\\udfff"',
    '"unterminated',
  ]) {
    for (const repeat of [0, 1]) {
      expect(
        decode({
          fields: ["year"],
          data: { kind: "marginal", columns: [[[value, repeat, repeat]]] },
        })._tag,
      ).toBe("Failure");
    }
  }
  for (const value of [
    "null",
    "true",
    "false",
    "2.0",
    "9007199254740993",
    "1e308",
    '"\\ud83d\\ude00"',
    JSON.stringify("a".repeat(128)),
  ]) {
    expect(
      decode({ fields: ["year"], data: { kind: "marginal", columns: [[[value, 0, 0]]] } })._tag,
    ).toBe("Success");
  }
});
