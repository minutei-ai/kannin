import { expect, test } from "bun:test";
import { Schema } from "effect";
import { crc32, deflateSync } from "node:zlib";
import {
  initSync,
  pack,
  unpack,
  tokenize,
  segment_bloom,
  segment_bloom_filter_many,
  segment_term_bounds,
  segment_overview_project,
  Segment,
  Directory,
  BloomBatch,
  PreparedQuery,
  FrequencyPage,
} from "../dist/wasm/raio_engine";
import {
  StoredDocument,
  PostingSpans,
  SegmentHeader,
  DataRange,
  Filter,
  TermCatalog,
  TermSummaries,
  EligibleMinimum,
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

test("WASM text tokenization agrees across normalization forms", () => {
  expect(tokenize("CAFÉ São ﬂores")).toBe("cafe sao flores");
  expect(tokenize("cafe\u0301")).toBe(tokenize("café"));
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

test("overview projection validates unrequested values and rejects malformed root fields", () => {
  for (const json of [
    '{"dictionary":{"unused":{"df":"bad","bounds":[]}},"eligibility":[[{},0,0]]}',
    '{"dictionary":{"unused":{"df":1,"bounds":[[0,1,0,-1]]}},"eligibility":[[{},0,0]]}',
    '{"dictionary":{"unused":{"df":1,"bounds":[[0,1,0]]}},"eligibility":[[{},0,0]]}',
    '{"dictionary":{"unused":{"df":1,"bounds":[[0,1,0,1,0]]}},"eligibility":[[{},0,0]]}',
    '{"dictionary":{"unused":{"df":1,"bounds":[[0,1,0,4294967296]]}},"eligibility":[[{},0,0]]}',
    '{"dictionary":{"unused":{"df":1}},"eligibility":[[{},0,0]]}',
    '{"dictionary":{"unused":{"df":1,"bounds":[],"bounds":[]}},"eligibility":[[{},0,0]]}',
    '{"dictionary":{},"dictionary":{},"eligibility":[[{},0,0]]}',
    '{"dictionary":{},"eligibility":[[{},0,0]],"eligibility":[[{},0,0]]}',
    '{"dictionary":{},"eligibility":[["invalid",0,0]]}',
    '{"dictionary":{},"eligibility":[[[],0,0]]}',
    '{"dictionary":{},"eligibility":[[{"unused":1e400},0,0]]}',
    '{"dictionary":{},"eligibility":[[{"unused":"\\ud800"},0,0]]}',
    '{"dictionary":{},"eligibility":[[{},0,-1]]}',
    '{"dictionary":{},"eligibility":[[{},0,0,0]]}',
    '{"dictionary":{},"eligibility":[]}',
    '{"dictionary":{}}',
    '{"dictionary":{},"minimum":null,"eligibility":[[{},0,0]]}',
    '{"dictionary":{},"eligibility":[[{},0,0]],"unknown":true}',
    '{"dictionary":{},"eligibility":[[{},0,0]]} trailing',
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

test("WASM document ranges preserve requested order without copying document attributes", () => {
  const segment = new Segment(
    JSON.stringify([
      { id: "a", text: "first", attributes: { large: "value".repeat(1000) } },
      { id: "b", text: "second", attributes: {} },
    ]),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const directory = new Directory(segment.bytes());
  const second = header.documents[1];
  if (second === undefined) throw new Error("Missing second document");
  const encoded = directory.document_ranges("[1,0,1]");
  expect(Schema.decodeSync(Schema.fromJsonString(Schema.Array(DataRange)))(encoded)).toEqual([
    second.data,
    header.documents[0].data,
    second.data,
  ]);
  expect(encoded.length).toBeLessThan(directory.rows("[1,0,1]").length / 10);
  expect(directory.document_ranges("[]")).toBe("[]");
  expect(() => directory.document_ranges("[2]")).toThrow("Invalid row");
  expect(() => directory.document_ranges("[-1]")).toThrow();
  directory.free();
  segment.free();
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
        { dictionary, minimum: [0, 0] },
        { dictionary, minimum: null },
        { dictionary, minimum: [1, 10] },
      ]),
    ),
  );
  expect(actual[0]).toBeGreaterThan(0);
  expect(actual[1]).toBe(0);
  expect(actual[2]).toBe(actual[0]);
  expect(() =>
    segment_term_bounds(
      statistics,
      JSON.stringify(Array.from({ length: 65 }, () => ({ dictionary, minimum: null }))),
    ),
  ).toThrow("Term bound batch exceeds segment budget");
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
  for (const mode of ["any", "all", "phrase"]) {
    const input = {
      text: "ÁLPHA beta",
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
