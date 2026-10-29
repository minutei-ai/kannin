import {
  canonicalFixtureDocuments,
  encodeCanonicalDocuments,
  decodeNativeDocumentFixture,
  decodeNativeQueryFixture,
  decodeNativeQueryFixtures,
} from "./segment-fixture";
import { expect, test } from "bun:test";
import { Match, Schema, Struct } from "effect";
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
  segment_migrate,
  segment_header,
  segment_query_document,
  segment_query_documents,
  Segment,
  Directory,
  CompressedDirectory,
  directory_compress,
  common_directory_compress,
  BloomBatch,
  PreparedQuery,
  FrequencyPage,
  EligibilityQuery,
} from "../dist/wasm/raio_engine";
import {
  StoredDocument,
  CanonicalDocumentMetadata,
  nativeToCanonicalDocument,
  Document,
  PostingSpans,
  SegmentHeader,
  LocatedDocument,
  Filter,
  TermCatalog,
  ProjectedTermCatalog,
  EligibilityProjection,
  TermSummaries,
  TermSummary,
  EligibleMinimum,
  RankingInput,
  SegmentHits,
  NamespaceSchema,
  TermProjectionProps,
} from "../src/protocol";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("common directory handles retain their coverage and reject complete-dictionary operations", () => {
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        Array.from({ length: 8 }, (_, id) => ({
          id: String(id),
          text: "alpha beta",
          attributes: {},
        })),
      ),
    ),
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using full = new Directory(bytes);
  const frame = full.common_frame(base);
  expect(frame).toEqual(common_directory_compress(bytes.subarray(0, base)));
  using projected = Directory.common(frame, base, 40 * 1024 * 1024);
  using retained = projected.retain();
  const input = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
    text: "alpha beta",
    mode: "phrase",
    top_k: 10,
    dead: [],
    filters: [],
    statistics: {
      documents: 8,
      title_length: 0,
      body_length: 16,
      frequencies: { alpha: 8, beta: 8 },
    },
  });
  using query = new PreparedQuery(input);
  expect(retained.covers_query(query)).toBe(true);
  expect(() => Directory.compressed(frame, base, 40 * 1024 * 1024)).toThrow();
  for (const operation of [
    () => retained.compressed_frame(base),
    () => retained.common_frame(base),
    () => retained.terms('["alpha"]'),
    () => retained.summary('["alpha"]'),
    () => retained.catalog('["alpha"]', "[]"),
    () => retained.common_terms(),
    () => retained.common_leaders(),
    () => retained.overview(),
    () => retained.ranker(input),
  ])
    expect(operation).toThrow("Operation requires a complete directory");
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
    JSON.stringify(
      canonicalFixtureDocuments([{ id: "café", text: "alpha", attributes: { city: "São Paulo" } }]),
    ),
  );
  const encoded = new TextEncoder().encode(segment.header_json());
  const position = encoded.findIndex((byte) => byte === 0xc3);
  expect(position).toBeGreaterThanOrEqual(0);
  for (const invalid of [0xff, 0xc0]) {
    const json = encoded.slice();
    json[position] = invalid;
    const frame = new Uint8Array(16 + json.byteLength);
    frame.set(segment.bytes().subarray(0, 8));
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

test("canonical recovery retains metadata while publishing the identical compressed frame", () => {
  using segment = new Segment(
    encodeCanonicalDocuments([
      { id: "é😀", revision: 1, text: "rust storage", attributes: { group: 1 } },
      { id: "\uE000", revision: 2, text: "rust durable", attributes: { group: 2 } },
      { id: "\u{10000}", revision: 3, text: "storage", attributes: { group: null } },
    ]),
  );
  const bytes = segment.bytes();
  const length =
    16 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  const canonical = bytes.subarray(0, length);
  const frame = directory_compress(canonical);
  const directory = Directory.canonical(canonical, length);
  const retained = directory.retain();
  expect(directory.compressed_frame(length)).toEqual(frame);
  expect(() => directory.compressed_frame(0)).toThrow("length");
  expect(() => directory.compressed_frame(16 * 1024 * 1024 + 1)).toThrow("length");
  directory.free();
  using recovered = retained;
  using compressed = Directory.compressed(frame, length, 40 * 1024 * 1024);
  expect(recovered.compressed_frame(length)).toEqual(frame);
  for (const filters of [[], [{ field: "group", op: "eq", value: 1 }]]) {
    const terms = '["rust","storage","durable"]';
    const predicates = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(
      Schema.decodeUnknownSync(Schema.Array(Filter))(filters),
    );
    expect(recovered.terms(terms)).toBe(compressed.terms(terms));
    expect(recovered.summary(terms)).toBe(compressed.summary(terms));
    expect(recovered.catalog(terms, predicates)).toBe(compressed.catalog(terms, predicates));
    expect(recovered.minimum(predicates)).toBe(compressed.minimum(predicates));
  }
});

test("recovered frames preserve raw attribute whitespace, escapes and duplicate keys", () => {
  using segment = new Segment(
    encodeCanonicalDocuments([
      { id: "a", revision: 1, text: "rust storage", attributes: { group: 1 } },
    ]),
  );
  const original = segment.header_json();
  const escaped = original.replace(
    '"attributes":{"group":1}',
    '"attributes": { "gr\\u006fup": 0, "group": 1, "label": "a\\u0062" }',
  );
  expect(escaped).not.toBe(original);
  const json = new TextEncoder().encode(escaped);
  const canonical = new Uint8Array(16 + json.byteLength);
  canonical.set(segment.bytes().subarray(0, 8));
  const view = new DataView(canonical.buffer);
  view.setUint32(8, json.byteLength, true);
  view.setUint32(12, crc32(json), true);
  canonical.set(json, 16);
  using recovered = Directory.canonical(canonical, canonical.byteLength);
  const frame = recovered.compressed_frame(canonical.byteLength);
  expect(frame).toEqual(directory_compress(canonical));
  using compressed = Directory.compressed(frame, canonical.byteLength, 40 * 1024 * 1024);
  for (const value of [0, 1]) {
    const predicates = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))([
      { field: "group", op: "eq", value },
    ]);
    expect(recovered.minimum(predicates)).toBe(compressed.minimum(predicates));
  }
});

test("compressed overviews preserve term bounds and exact filter minima across selectors", () => {
  const segment = new Segment(
    encodeCanonicalDocuments([
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
        Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
          directory.catalog(encodedTerms, encodedFilters),
        ),
      ).toEqual(
        Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
          segment_overview_project(overview, encodedTerms, encodedFilters),
        ),
      );
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
        JSON.stringify(Array.from({ length: 513 }, () => "rust")),
        encodedFilters,
      ),
    ).toThrow("512 terms");
  }
  directory.free();
  segment.free();
});

test("shared attribute groups preserve minima across operators and different document lengths", () => {
  const segment = new Segment(
    encodeCanonicalDocuments([
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
  expect(() =>
    directory.catalog(JSON.stringify(Array.from({ length: 513 }, () => "rust")), "[]"),
  ).toThrow();
  expect(() =>
    directory.catalog(
      '["rust"]',
      JSON.stringify(Array.from({ length: 17 }, () => ({ field: "group", op: "eq", value: 1 }))),
    ),
  ).toThrow();
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

test("overview bytes and projected catalogs are independent of attribute group insertion order", () => {
  const groups = [
    { group: "ação", year: 2024, extra: "日本語" },
    { group: "a", year: 2020, extra: null },
    { group: "🚀", year: 2026, extra: 1.5 },
    { group: "A", year: 2021, extra: 'quoted "value"' },
  ];
  const samples = [];
  for (const shift of [0, 1, 2, 3, 0, 3, 2, 1]) {
    using segment = new Segment(
      encodeCanonicalDocuments(
        groups.flatMap((attributes, group) =>
          Array.from({ length: 8 }, (_, index) => ({
            id: String(((group + shift) % groups.length) * 8 + index).padStart(3, "0"),
            revision: 1,
            title: "",
            text: "alpha beta",
            attributes,
          })),
        ),
      ),
    );
    using directory = new Directory(segment.bytes());
    const filters = '[{"field":"year","op":"gte","value":2021}]';
    const overview = directory.overview();
    const catalog = directory.catalog('["alpha"]', filters);
    expect(segment_overview_project(overview, '["alpha"]', filters)).toBe(catalog);
    samples.push({ overview, catalog });
  }
  const first = samples[0];
  if (first === undefined) throw new Error("Missing overview ordering samples");
  for (const sample of samples) {
    expect(sample.overview).toEqual(first.overview);
    expect(sample.catalog).toBe(first.catalog);
  }
});

test("overview groups stay scoped to their handle and are consumed by catalog projection", () => {
  using segment = new Segment(
    encodeCanonicalDocuments(
      Array.from({ length: 64 }, (_, index) => ({
        id: String(index),
        revision: 1,
        title: "title ".repeat(index % 3),
        text: "alpha ".repeat(1 + (index % 5)),
        attributes: { group: index % 4, year: 2020 + (index % 7) },
      })),
    ),
  );
  using directory = new Directory(segment.bytes());
  const initial = directory.heap_bytes();
  const filters = '[{"field":"year","op":"gte","value":2021}]';
  const expected = directory.catalog('["alpha"]', filters);
  expect(directory.heap_bytes()).toBe(initial);
  const bytes = directory.overview();
  const prepared = directory.heap_bytes();
  expect(prepared).toBeGreaterThan(initial);
  expect(directory.overview()).toEqual(bytes);
  expect(directory.heap_bytes()).toBe(prepared);
  using retained = directory.retain();
  expect(retained.heap_bytes()).toBe(initial);
  expect(retained.catalog('["alpha"]', filters)).toBe(expected);
  expect(retained.heap_bytes()).toBe(initial);
  expect(directory.catalog('["alpha"]', filters)).toBe(expected);
  expect(directory.heap_bytes()).toBe(initial);
  directory.overview();
  directory.catalog('["alpha"]', "[]");
  expect(directory.heap_bytes()).toBe(initial);
});

test("overview projection validates every pool entry and reference before selecting terms", () => {
  for (const json of [
    '[{"unused":0},[[{},0,0]],null,[{"df":"bad","bounds":[]}],{}]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0,-1]]}],{}]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0]]}],{}]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0,1,0]]}],{}]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0,4294967296]]}],{}]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1}],{}]',
    '[{"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[],"bounds":[]}],{}]',
    '[{"unused":1},[[{},0,0]],null,[{"df":1,"bounds":[]}],{}]',
    '[{"unused":-1},[[{},0,0]],null,[],{}]',
    '[{"unused":0.5},[[{},0,0]],null,[],{}]',
    '[{"unused":4294967296},[[{},0,0]],null,[],{}]',
    '[{},[["invalid",0,0]],null,[],{}]',
    "[{},[[[],0,0]],null,[],{}]",
    '[{},[[{"unused":1e400},0,0]],null,[],{}]',
    '[{},[[{"unused":"\\ud800"},0,0]],null,[],{}]',
    "[{},[[{},0,-1]],null,[],{}]",
    "[{},[[{},0,0,0]],null,[],{}]",
    "[{},[],null,[],{}]",
    "[{},[[{},0,0]],null,{}]",
    "[{},[[{},0,0]],null,[],0,{}]",
    "[{},[[{},0,0]],null,[]]",
    "[{},[[{},0,0]],null,[],{},0]",
    "[{},[[{},0,0]],null,[],{}] trailing",
    '{"dictionary":{},"eligibility":[[{},0,0]],"partitions":null}',
    '[{},[[{},0,0]],null,[{"df":"bad","bounds":[]}],{}]',
    '[{},[[{},0,0]],[{"unused":1}],[{"df":1,"bounds":[]}],{}]',
    '[{"unused":1,"unused":0},[[{},0,0]],null,[{"df":1,"bounds":[]}],{}]',
    '[{"unused":{"df":"bad","bounds":[]}},[[{},0,0]],null,[],{}]',
    '[{"unused":{"df":1,"bounds":[[0,1,0,-1]]}},[[{},0,0]],null,[],{}]',
    '[{"unused":{"df":1,"bounds":[],"bounds":[]}},[[{},0,0]],null,[],{}]',
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
    '[{"alias":0,"wanted":{"df":1,"bounds":[[0,1,0,1]]},"w\\u0061nted":0},[[{},0,0]],[{"alias":{"df":2,"bounds":[[0,1,0,1]]},"unused":0}],[{"df":2,"bounds":[[0,1,0,1]]}],{}]';
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
  using segment = new Segment(JSON.stringify(canonicalFixtureDocuments(documents)));
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
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  for (const source of [overview, correlated]) {
    for (const terms of ['["unique0","unique4999"]', '["title","body","unique4500"]']) {
      const projected = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
        segment_overview_project(source, terms, "[]"),
      );
      const expected = Schema.decodeSync(Schema.fromJsonString(TermSummaries))(
        directory.summary(terms),
      );
      expect(Object.keys(projected.dictionary)).toEqual(Object.keys(expected));
      for (const [term, summary] of Object.entries(projected.dictionary)) {
        const baseline = expected[term];
        if (baseline === undefined) throw new Error("Missing unpooled summary");
        expect(summary.df).toBe(baseline.df);
        expect(summary.bounds).toEqual(baseline.bounds);
        if (source === correlated && summary.df === 1) {
          const row = Number(term.slice("unique".length));
          const document = header.documents[row];
          if (document === undefined) throw new Error("Missing canonical singleton row");
          expect(summary.single).toEqual({ row, id: document.id, data: document.data });
        } else expect(summary.single).toBeUndefined();
      }
    }
  }
});

test("overview partitions validate every summary while projecting in one pass", () => {
  const summary = { df: 2, bounds: [[1, 1, 2, 4]] } as const;
  const terms = JSON.stringify(["wanted"]);
  const project = (partitions: string) => {
    const data = new TextEncoder().encode(
      `[{},[[{},0,0]],${partitions},[{"df":2,"bounds":[[1,1,2,4]]}],{}]`,
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
  using segment = new Segment(JSON.stringify(canonicalFixtureDocuments(documents)));
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
      const decoded = decodeNativeDocumentFixture(
        segment_document(
          bytes.subarray(base + hit.data.offset, base + hit.data.offset + hit.data.length),
          new Uint8Array(),
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
  const segments = fixtures.map(
    (docs) => new Segment(JSON.stringify(canonicalFixtureDocuments(docs))),
  );
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
    { ...input, text: Array.from({ length: 513 }, (_, index) => `term${index}`).join(" ") },
    { ...input, mode: "phrase", text: "alpha ".repeat(65) },
  ])
    expect(() => new PreparedQuery(JSON.stringify(invalid))).toThrow();
});

test("retained frequency pages preserve dynamic masks, block ordering and positional bounds", () => {
  const segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        Array.from({ length: 260 }, (_, index) => ({
          id: String(index).padStart(3, "0"),
          text: "alpha beta alpha",
          attributes: { group: index % 2 },
        })),
      ),
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
    JSON.stringify(
      canonicalFixtureDocuments(
        ["a", "b"].map((id) => ({ id, text: "alpha ".repeat(101), attributes: {} })),
      ),
    ),
  );
  using shortSegment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(["a", "b"].map((id) => ({ id, text: "alpha", attributes: {} }))),
    ),
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

test("directory lookup preserves UTF-16 rows, duplicate requests and tombstones", () => {
  const ids = ["\uE000", "a😀", "\u{10000}", "ação", "a", "a-b", "😀"];
  using segment = new Segment(
    encodeCanonicalDocuments(
      ids.map((id) => ({ id, revision: 1, title: "", text: "alpha", attributes: {} })),
    ),
  );
  const bytes = segment.bytes();
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const sorted = ids.toSorted();
  expect(header.documents.map((document) => document.id)).toEqual(sorted);
  const requested = ["a😀", "\u{10000}", "missing", "a", "a", "\uE000", "ação", "😀"];
  const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))(requested);
  const dead = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))([
    sorted.indexOf("a😀"),
  ]);
  const expected = ["\u{10000}", "a", "a", "\uE000", "ação", "😀"];
  const length = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const frame = directory_compress(bytes.subarray(0, length));
  using direct = new Directory(bytes);
  using compressed = Directory.compressed(frame, length, 32 * 1024 * 1024);
  for (const directory of [direct, compressed]) {
    const located = Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
      directory.lookup(encoded, dead),
    );
    expect(located.map((result) => result.document.id)).toEqual(expected);
    expect(located.map((result) => result.row)).toEqual(expected.map((id) => sorted.indexOf(id)));
    for (const result of located) expect(header.documents[result.row]).toEqual(result.document);
  }
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
  using segment = new Segment(encodeCanonicalDocuments(documents));
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
      canonicalFixtureDocuments(
        ["a", "😀", "\uE000"].flatMap((prefix) =>
          Array.from({ length: 128 }, (_, index) => ({
            id: `${prefix}-${String(index).padStart(4, "0")}`,
            text: "alpha beta",
            attributes: {},
          })),
        ),
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
    using segment = new Segment(JSON.stringify(canonicalFixtureDocuments(docs)));
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
      canonicalFixtureDocuments(
        Array.from({ length: 2048 }, (_, index) => ({
          id: String(index).padStart(5, "0"),
          text: "alpha beta",
          attributes: { selected: index % 128 === 0 },
        })),
      ),
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
  using segment = new Segment(JSON.stringify(canonicalFixtureDocuments(docs)));
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
      canonicalFixtureDocuments(
        Array.from({ length: 128 }, (_, index) => ({
          id: String(index).padStart(4, "0"),
          text: "alpha beta",
          attributes: { state: "initial" },
        })),
      ),
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
  expect(compact[0]).toBe(3);
  const invalid = new Uint8Array(compact);
  invalid[0] = 4;
  const compressed = deflateSync(invalid);
  const forged = new Uint8Array(20 + compressed.byteLength);
  forged.set(encoded.subarray(0, 20));
  forged.set(compressed, 20);
  expect(() => Directory.compressed(forged, length, 40 * 1024 * 1024)).toThrow();
  covered.set(forged.subarray(0, 16));
  covered.set(invalid, 16);
  new DataView(forged.buffer).setUint32(16, crc32(covered), true);
  expect(() => Directory.compressed(forged, length, 40 * 1024 * 1024)).toThrow("version");
  using cached = new CompressedDirectory(forged, length);
  expect(() => cached.directory(1)).toThrow("budget");
  expect(() => cached.directory(40 * 1024 * 1024)).toThrow("version");
  expect(() => cached.directory(40 * 1024 * 1024)).toThrow("version");
  using retained = cached.retain();
  expect(() => retained.directory(40 * 1024 * 1024)).toThrow("version");
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
    JSON.stringify(
      canonicalFixtureDocuments([
        { id: "compressed", text: "alpha", attributes: { padding: "x".repeat(65536) } },
      ]),
    ),
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
    encodeCanonicalDocuments(
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
    expect(
      Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
        directory.catalog(encodedTerms, encodedFilters),
      ),
    ).toEqual(projected);
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
  expect(
    Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
      directory.catalog('["alpha"]', warm),
    ),
  ).toEqual(projected);
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

test("canonical eligibility models cover 64 fields while subset queries retain their predicate limit", () => {
  const fields = Array.from({ length: 64 }, (_, index) => `field${String(index).padStart(2, "0")}`);
  const encodeFields = Schema.encodeSync(Schema.fromJsonString(NamespaceSchema.fields.filterable));
  const encodedFields = encodeFields(fields);
  using segment = new Segment(
    encodeCanonicalDocuments(
      Array.from({ length: 24 }, (_, index) => ({
        id: String(index).padStart(3, "0"),
        revision: 1,
        title: "alpha ".repeat(index % 4),
        text: "alpha beta ".repeat(1 + (index % 5)),
        attributes: Object.fromEntries(
          fields
            .filter((field) => field !== "field31" || index % 2 !== 0)
            .map((field) => {
              const value = Match.value(field).pipe(
                Match.when(
                  (name) => name === "field17" || name === "field63",
                  () => index % 2,
                ),
                Match.orElse(() => null),
              );
              return [field, value] as const;
            }),
        ),
      })),
    ),
    encodedFields,
  );
  using directory = new Directory(segment.bytes());
  const encoded = segment.eligibility(encodedFields);
  if (encoded === undefined) throw new Error("Missing 64-field eligibility model");
  expect(directory.eligibility(encodedFields)).toBe(encoded);
  const model = Schema.decodeSync(Schema.fromJsonString(EligibilityProjection))(encoded);
  expect(model.fields).toEqual(fields);
  expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(4096);
  const cases = Schema.decodeSync(Schema.Array(Schema.Array(Filter)))([
    [{ field: "field17", op: "eq", value: 1 }],
    [{ field: "field31", op: "exists", value: false }],
    [{ field: "field31", op: "eq", value: null }],
    [{ field: "field63", op: "eq", value: 1 }],
    [
      { field: "field17", op: "eq", value: 1 },
      { field: "field31", op: "exists", value: false },
    ],
    [
      ...Array.from({ length: 13 }, (_, index) => ({
        field: `field${String(index).padStart(2, "0")}`,
        op: "exists" as const,
        value: true,
      })),
      { field: "field17", op: "exists", value: true },
      { field: "field31", op: "exists", value: false },
      { field: "field63", op: "eq", value: 0 },
    ],
  ]);
  const encodeFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)));
  for (const filters of cases) {
    const input = encodeFilters(filters);
    using query = new EligibilityQuery(input);
    expect(query.minimum(encoded)).toBe(directory.minimum(input));
  }
  using absent = new EligibilityQuery('[{"field":"missing","op":"exists","value":false}]');
  expect(() => absent.minimum(encoded)).toThrow("omitted filter field");
  using empty = new EligibilityQuery("[]");
  expect(empty.minimum(encoded)).toBe("[0,0]");
  const excessiveFilters = Array.from({ length: 17 }, (_, index) => ({
    field: fields[index],
    op: "exists" as const,
    value: true,
  }));
  expect(() => new EligibilityQuery(JSON.stringify(excessiveFilters))).toThrow("sixteen filters");
  const selection = TermProjectionProps.fields.selection;
  expect(Schema.is(selection)({ kind: "fields", fields: fields.slice(0, 16) })).toBe(true);
  expect(Schema.is(selection)({ kind: "fields", fields: fields.slice(0, 17) })).toBe(false);
  const tooManyFields = [...fields, "field64"];
  expect(() => directory.eligibility(JSON.stringify(tooManyFields))).toThrow("sixty-four fields");
  expect(() => segment.eligibility(JSON.stringify(tooManyFields))).toThrow("sixty-four fields");
  if (model.data.kind !== "joint") throw new Error("Expected complete joint model");
  const malformed = {
    ...model,
    data: {
      kind: "joint" as const,
      groups: model.data.groups.map(([values, title, body]) => [
        values.map((value, column) => {
          if (column === 63) return ["[]"];
          return value;
        }),
        title,
        body,
      ]),
    },
  };
  expect(Schema.is(EligibilityProjection)(malformed)).toBe(false);
  using subset = new EligibilityQuery('[{"field":"field17","op":"eq","value":200}]');
  expect(() => subset.minimum(JSON.stringify(malformed))).toThrow("scalar");
});

test("oversized field projections retain the original minimum fallback", () => {
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        Array.from({ length: 1000 }, (_, index) => ({
          id: String(index),
          revision: 1,
          title: "",
          text: "alpha ".repeat(1 + (index % 3)),
          attributes: { year: index },
        })),
      ),
    ),
  );
  using directory = new Directory(segment.bytes());
  const filters = '[{"field":"year","op":"gte","value":500}]';
  const projected = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(directory.overview(), '["alpha"]', filters),
  );
  expect(projected.eligibility).toBeNull();
  expect(
    Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
      directory.catalog('["alpha"]', filters),
    ),
  ).toEqual(projected);
  expect(projected.minimum).toEqual(
    Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(directory.minimum(filters)),
  );
  using large = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments([
        {
          id: "large",
          revision: 1,
          title: "",
          text: "alpha",
          attributes: { note: "x".repeat(8192) },
        },
      ]),
    ),
  );
  using largeDirectory = new Directory(large.bytes());
  const largeFilters = '[{"field":"note","op":"exists","value":true}]';
  const largeProjection = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(largeDirectory.overview(), '["alpha"]', largeFilters),
  );
  expect(largeProjection.eligibility).toBeNull();
  expect(
    Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
      largeDirectory.catalog('["alpha"]', largeFilters),
    ),
  ).toEqual(largeProjection);
  expect(largeProjection.minimum).toEqual(
    Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(largeDirectory.minimum(largeFilters)),
  );
});

test("overview projections keep exact filters after eligibility scratch reuse begins", () => {
  const prefix = Array.from({ length: 257 }, (_, index) => `[{"year":${index}},0,0]`).join(",");
  const json = `[{},[${prefix},[{"year":800,"year":650},5,6],[{},0,0],[{"year":700,"year":800},1,1],[{"year":650},2,3]],null,[],{}]`;
  const filters =
    '[{"field":"year","op":"gte","value":600},{"field":"year","op":"lte","value":700}]';
  const projected = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(pack(json).subarray(8), '["alpha"]', filters),
  );
  expect(projected.minimum).toEqual([2, 3]);
  expect(projected.eligibility).toBeNull();

  const wideFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))([
    { field: "year", op: "gte", value: 600 },
    { field: "year", op: "lte", value: 700 },
    ...Array.from({ length: 8 }, (_, index) => ({
      field: `missing${index}`,
      op: "exists" as const,
      value: false,
    })),
  ]);
  const wideProjection = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
    segment_overview_project(pack(json).subarray(8), '["alpha"]', wideFilters),
  );
  expect(wideProjection.minimum).toEqual([2, 3]);
  expect(wideProjection.eligibility).toBeNull();

  for (const value of ["[]", "{}", JSON.stringify("x".repeat(4097))]) {
    const overview = `[{},[[{"note":${value}},5,6],[{},0,0]],null,[],{}]`;
    const result = Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
      segment_overview_project(
        pack(overview).subarray(8),
        '["alpha"]',
        '[{"field":"note","op":"exists","value":true}]',
      ),
    );
    expect(result.minimum).toEqual([5, 6]);
    expect(result.eligibility).toBeNull();
  }
});

test("overview projection still rejects malformed groups after eligibility scratch reuse begins", () => {
  const prefix = Array.from({ length: 257 }, (_, index) => `[{"year":${index}},0,0]`).join(",");
  const filters = '[{"field":"year","op":"exists","value":true}]';
  for (const group of [
    '[{"year":300,"extra":{"nested":1e400}},0,0]',
    '[{"year":300},4294967296,0]',
    '[{"year":300},0,0,1]',
  ]) {
    const overview = pack(`[{},[${prefix},${group}],null,[],{}]`).subarray(8);
    expect(() => segment_overview_project(overview, '["alpha"]', filters)).toThrow();
  }
});

test("indexed eligibility predicates preserve field order, duplicates and every scalar operator", () => {
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        Array.from({ length: 12 }, (_, index) => ({
          id: String(index),
          revision: 1,
          title: "alpha ".repeat(index % 3),
          text: "alpha ".repeat(1 + (index % 4)),
          attributes: { year: index, group: index % 2, flag: index % 3 === 0 },
        })),
      ),
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
    expect(
      Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
        directory.catalog('["alpha"]', encodedFilters),
      ),
    ).toEqual(projected);
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
      canonicalFixtureDocuments(
        Array.from({ length: 1400 }, (_, index) => ({
          id: String(index),
          revision: 1,
          title: "alpha ".repeat(index % 5),
          text: "alpha ".repeat(1 + (index % 13)),
          attributes: { group: index % 100, year: 2020 + (index % 7) },
        })),
      ),
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
  expect(
    Schema.decodeSync(Schema.fromJsonString(ProjectedTermCatalog))(
      directory.catalog('["alpha"]', warm),
    ),
  ).toEqual(projected);
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
      canonicalFixtureDocuments(
        Array.from({ length: 2800 }, (_, index) => ({
          id: String(index),
          revision: 1,
          title: "alpha ".repeat(index % 5),
          text: "alpha ".repeat(1 + (index % 13)),
          attributes: { group: index % 100, year: 2020 + (index % 7), ...attributes[index % 4] },
        })),
      ),
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

function compressedDirectoryFixture() {
  using segment = new Segment(
    encodeCanonicalDocuments([
      { id: "ação😀", revision: 1, text: "cloudflare rust", attributes: { group: 1 } },
      { id: "日本語", revision: 2, text: "rust search", attributes: { group: 2 }, vector: [1, 0] },
    ]),
  );
  const bytes = segment.bytes();
  const length = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  return { bytes: directory_compress(bytes.subarray(0, length)), length };
}

test("cached directory frames own immutable input and expose only copied bytes", () => {
  const source = compressedDirectoryFixture();
  const original = source.bytes.slice();
  using reference = Directory.compressed(original, source.length, 40 * 1024 * 1024);
  using cached = new CompressedDirectory(source.bytes, source.length);
  source.bytes.fill(0);
  using first = cached.directory(40 * 1024 * 1024);
  expect(first.rows("[0,1]")).toBe(reference.rows("[0,1]"));
  const exposed = cached.bytes();
  exposed.fill(0);
  expect(cached.bytes()).toEqual(original);
  using second = cached.directory(40 * 1024 * 1024);
  expect(second.rows("[0,1]")).toBe(reference.rows("[0,1]"));
  expect(() => Directory.compressed(exposed, source.length, 40 * 1024 * 1024)).toThrow();
});

test("retained frames and acquired directories survive release of their cache owners", () => {
  const source = compressedDirectoryFixture();
  using owner = new DisposableStack();
  const frame = owner.use(new CompressedDirectory(source.bytes, source.length));
  using retainedOwner = new DisposableStack();
  const retained = retainedOwner.use(frame.retain());
  using first = frame.directory(40 * 1024 * 1024);
  const expected = first.rows("[0,1]");
  owner.dispose();
  using second = retained.directory(40 * 1024 * 1024);
  retainedOwner.dispose();
  expect(first.rows("[0,1]")).toBe(expected);
  expect(second.rows("[0,1]")).toBe(expected);
});

test("failed checksum validation never becomes trusted cached directory state", () => {
  const source = compressedDirectoryFixture();
  const bytes = source.bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(16, view.getUint8(16) ^ 1);
  using cached = new CompressedDirectory(bytes, source.length);
  expect(() => cached.directory(40 * 1024 * 1024)).toThrow("integrity");
  expect(() => cached.directory(40 * 1024 * 1024)).toThrow("integrity");
});

test("cached validation never bypasses decoded budgets or expected header lengths", () => {
  const source = compressedDirectoryFixture();
  using cached = new CompressedDirectory(source.bytes, source.length);
  using first = cached.directory(40 * 1024 * 1024);
  const budget = first.heap_bytes();
  using exact = cached.directory(budget);
  expect(exact.heap_bytes()).toBe(budget);
  expect(() => cached.directory(budget - 1)).toThrow("budget");
  using recovered = cached.directory(budget);
  expect(recovered.rows("[0,1]")).toBe(first.rows("[0,1]"));
  using wrong = new CompressedDirectory(source.bytes, source.length + 1);
  expect(() => wrong.directory(40 * 1024 * 1024)).toThrow("length");
  expect(() => wrong.directory(40 * 1024 * 1024)).toThrow("length");
});

test("cached common frames preserve coverage, owned bytes and budgets after owner release", () => {
  const source = compressedDirectoryFixture();
  using full = Directory.compressed(source.bytes, source.length, 40 * 1024 * 1024);
  const common = full.common_frame(source.length);
  const original = common.slice();
  using owner = new DisposableStack();
  const cached = owner.use(CompressedDirectory.common(common, source.length));
  common.fill(0);
  using retainedOwner = new DisposableStack();
  const retained = retainedOwner.use(cached.retain());
  using decodedOwner = new DisposableStack();
  const decoded = decodedOwner.use(cached.directory(40 * 1024 * 1024));
  using first = decoded.retain();
  decodedOwner.dispose();
  expect(first.rows("[0,1]")).toBe(full.rows("[0,1]"));
  expect(() => first.overview()).toThrow("complete directory");
  const exposed = cached.bytes();
  exposed.fill(0);
  expect(cached.bytes()).toEqual(original);
  owner.dispose();
  const budget = first.heap_bytes();
  expect(() => retained.directory(budget - 1)).toThrow("budget");
  using second = retained.directory(budget);
  expect(second.heap_bytes()).toBe(budget);
  retainedOwner.dispose();
  expect(second.rows("[0,1]")).toBe(first.rows("[0,1]"));
  for (const text of ["rust", "cloudflare"] as const) {
    using query = new PreparedQuery(
      Schema.encodeSync(Schema.fromJsonString(RankingInput))({
        text,
        mode: "any",
        top_k: 10,
        dead: [],
        filters: [],
        statistics: {
          documents: 2,
          title_length: 0,
          body_length: 4,
          frequencies: { rust: 2, cloudflare: 1 },
        },
      }),
    );
    expect(second.covers_query(query)).toBe(text === "rust");
    if (text === "cloudflare")
      expect(() => second.ranker_prepared(query, "[]")).toThrow("does not cover");
  }
  using wrong = CompressedDirectory.common(original, source.length + 1);
  expect(() => wrong.directory(40 * 1024 * 1024)).toThrow("length");
  expect(() => wrong.directory(40 * 1024 * 1024)).toThrow("length");
  expect(() => new CompressedDirectory(original, source.length)).toThrow("frame");
  expect(() => CompressedDirectory.common(source.bytes, source.length)).toThrow("frame");
});

test("cached common frames never trust rejected selection or checksum validation", () => {
  const text = Array.from({ length: 17 }, (_, index) => `term${index}`).join(" ");
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments([
        { id: "0", text, attributes: {} },
        { id: "1", text, attributes: {} },
      ]),
    ),
  );
  const bytes = segment.bytes();
  const length = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const complete = directory_compress(bytes.subarray(0, length));
  const binaryHeader = inflateSync(complete.subarray(20));
  const compact = new Uint8Array(4 + binaryHeader.byteLength + 2);
  new DataView(compact.buffer).setUint32(0, binaryHeader.byteLength, true);
  compact.set(binaryHeader, 4);
  const payload = deflateSync(compact);
  const excessive = new Uint8Array(20 + payload.byteLength);
  excessive.set(complete.subarray(0, 16));
  excessive.set(new TextEncoder().encode("RAIOCOM3"));
  const envelope = new DataView(excessive.buffer);
  envelope.setUint32(12, compact.byteLength, true);
  envelope.setUint32(16, crc32(compact, crc32(excessive.subarray(0, 16))), true);
  excessive.set(payload, 20);
  using selection = CompressedDirectory.common(excessive, length);
  for (const repeat of [0, 1]) {
    expect(() => selection.directory(40 * 1024 * 1024), String(repeat)).toThrow("term selection");
  }
  const common = common_directory_compress(bytes.subarray(0, length));
  const view = new DataView(common.buffer, common.byteOffset);
  view.setUint8(16, view.getUint8(16) ^ 1);
  using checksum = CompressedDirectory.common(common, length);
  expect(() => checksum.directory(40 * 1024 * 1024)).toThrow("integrity");
  expect(() => checksum.directory(40 * 1024 * 1024)).toThrow("integrity");
});

const VectorFrameFixture = Document.mapFields((fields) => ({
  ...fields,
  revision: Schema.optional(Schema.Int),
  vector: Schema.optional(Schema.Array(Schema.Number)),
}));
function documentFrames(document: unknown) {
  const input = Schema.decodeUnknownSync(VectorFrameFixture)(document);
  using segment = new Segment(JSON.stringify(canonicalFixtureDocuments([input])));
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const entry = header.documents[0];
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const metadata = bytes.slice(
    base + entry.data.offset,
    base + entry.data.offset + entry.data.length,
  );
  const vector = header.vector_ranges[0];
  if (vector === undefined) return { header, metadata, vector: new Uint8Array() };
  return {
    header,
    metadata,
    vector: bytes.slice(base + vector.offset, base + vector.offset + vector.length),
  };
}

test("query document projection preserves fields and rejects invalid vectors and corrupt frames", () => {
  const document = {
    id: "ação/😀",
    revision: 7,
    title: '日本語\n"',
    text: "café\t text",
    attributes: { year: 2024, label: "ação", enabled: true, empty: null },
  };
  const decodeFull = decodeNativeDocumentFixture;
  const decodeProjection = decodeNativeQueryFixture;
  const absent = documentFrames(document);
  expect(decodeProjection(segment_query_document(absent.metadata))).toEqual({
    ...decodeFull(segment_document(absent.metadata, absent.vector)),
    vectorSummary: null,
  });
  for (const vector of [
    [1],
    [0.5, 0, -0.25],
    Array.from({ length: 768 }, (_, index) => Math.sin(index + 1)),
    [...Array<number>(4095).fill(0), 1],
    [...Array<number>(10_751).fill(0), 1],
  ]) {
    const frames = documentFrames({ ...document, vector });
    const full = decodeFull(segment_document(frames.metadata, frames.vector));
    const projected = decodeProjection(segment_query_document(frames.metadata));
    expect(projected).toEqual({ ...document, vectorSummary: [vector.length, true, true] });
    expect(full.vector).toHaveLength(vector.length);
    expect(projected).not.toHaveProperty("vector");
  }
  for (const vector of [[], [0, -0], Array<number>(10_753).fill(1), [1e-100], [3.5e38]]) {
    expect(() => {
      const frames = documentFrames({ ...document, vector });
      return decodeFull(segment_document(frames.metadata, frames.vector));
    }).toThrow();
    expect(() => {
      const frames = documentFrames({ ...document, vector });
      return decodeProjection(segment_query_document(frames.metadata));
    }).toThrow();
  }
  const corrupt = absent.metadata.slice();
  const corruptView = new DataView(corrupt.buffer);
  corruptView.setUint32(4, corruptView.getUint32(4, true) ^ 1, true);
  for (const bytes of [new Uint8Array(), absent.metadata.subarray(0, 10), corrupt]) {
    expect(() => segment_document(bytes, new Uint8Array())).toThrow();
    expect(() => segment_query_document(bytes)).toThrow();
  }
  const present = documentFrames({ ...document, vector: [1, 2] });
  const corruptVector = present.vector.slice();
  const vectorView = new DataView(corruptVector.buffer);
  vectorView.setUint32(4, vectorView.getUint32(4, true) ^ 1, true);
  for (const vector of [new Uint8Array(), present.vector.subarray(0, 10), corruptVector])
    expect(() => segment_document(present.metadata, vector)).toThrow();
  expect(decodeProjection(segment_query_document(present.metadata)).vectorSummary).toEqual([
    2,
    true,
    true,
  ]);
  const wrongDimensions = documentFrames({ ...document, vector: [1] });
  expect(() => segment_document(present.metadata, wrongDimensions.vector)).toThrow();
});

test("native float32 extrema stay inside the stored vector contract after legacy migration", () => {
  const maximum = 3.4028234663852886e38;
  const vector = [maximum, -maximum, 0.1, 0, 2 ** -149, ...Array<number>(763).fill(0)];
  const document = {
    id: "float32-extrema",
    revision: 1,
    title: "",
    text: "alpha",
    attributes: {},
    vector,
  };
  expect(Schema.is(StoredDocument)(document)).toBe(true);
  const current = documentFrames(document);
  const legacy = { ...document, vector: [3.4028235e38, -3.4028235e38, ...vector.slice(2)] };
  const raw = new TextEncoder().encode(JSON.stringify(legacy));
  const compressed = deflateSync(raw);
  const oldFrame = new Uint8Array(8 + compressed.byteLength);
  const framing = new DataView(oldFrame.buffer);
  framing.setUint32(0, raw.byteLength, true);
  framing.setUint32(4, crc32(raw), true);
  oldFrame.set(compressed, 8);
  const LegacyHeader = SegmentHeader.mapFields((fields) => ({
    ...Struct.omit(fields, ["metadata_end", "vector_end", "vector_ranges"]),
    version: Schema.Literal(1),
  }));
  const json = new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(LegacyHeader))({
      ...current.header,
      version: 1,
      documents: [
        { ...current.header.documents[0], data: { offset: 0, length: oldFrame.byteLength } },
      ],
      terms: {},
    }),
  );
  const source = new Uint8Array(16 + json.byteLength + oldFrame.byteLength);
  source.set(new TextEncoder().encode("RAIOSEG1"));
  const sourceView = new DataView(source.buffer);
  sourceView.setUint32(8, json.byteLength, true);
  sourceView.setUint32(12, crc32(json), true);
  source.set(json, 16);
  source.set(oldFrame, 16 + json.byteLength);
  expect(() => new Directory(source)).toThrow();
  expect(() => segment_query_document(oldFrame)).toThrow();
  const migrated = segment_migrate(source);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment_header(migrated));
  const base = 16 + new DataView(migrated.buffer, migrated.byteOffset).getUint32(8, true);
  const entry = header.documents[0];
  const vectorData = header.vector_ranges[0];
  if (vectorData === undefined) throw new Error("Missing migrated vector frame");
  const metadata = migrated.slice(
    base + entry.data.offset,
    base + entry.data.offset + entry.data.length,
  );
  const vectorFrame = migrated.slice(
    base + vectorData.offset,
    base + vectorData.offset + vectorData.length,
  );
  for (const frames of [current, { metadata, vector: vectorFrame }]) {
    const decoded = decodeNativeDocumentFixture(segment_document(frames.metadata, frames.vector));
    expect(decoded.vector?.[0]).toBe(maximum);
    expect(decoded.vector?.[1]).toBe(-maximum);
    expect(decoded.vector?.map(Math.fround)).toEqual(vector.map(Math.fround));
    const query = decodeNativeQueryFixture(segment_query_document(frames.metadata));
    expect(query.vectorSummary).toEqual([768, true, true]);
  }
});

test("native metadata batches preserve scalar projections and decline oversized decoded batches", () => {
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        Array.from({ length: 16 }, (_, index) => ({
          id: String(index).padStart(2, "0"),
          revision: 1,
          title: "á 字",
          text: "rust search",
          attributes: { n: index, nullable: null, maximum: Number.MAX_SAFE_INTEGER },
          vector: [1, ...Array<number>(767).fill(0)],
        })),
      ),
    ),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const payload = bytes.subarray(base, base + header.metadata_end);
  const selected = header.documents.toReversed();
  const ranges = new Uint32Array(
    selected.flatMap((document) => [document.data.offset, document.data.length]),
  );
  const expected = selected.map((document) =>
    decodeNativeQueryFixture(
      segment_query_document(
        payload.subarray(document.data.offset, document.data.offset + document.data.length),
      ),
    ),
  );
  const encoded = segment_query_documents(payload, ranges);
  if (encoded === undefined) throw new Error("Small metadata batch unexpectedly declined");
  expect(decodeNativeQueryFixtures(encoded)).toEqual(expected);
  for (const invalid of [
    new Uint32Array(),
    new Uint32Array([0]),
    new Uint32Array(34),
    new Uint32Array([4294967295, 4294967295]),
  ])
    expect(() => segment_query_documents(payload, invalid)).toThrow();
  const first = selected[0];
  const last = selected.at(-1);
  if (first === undefined || last === undefined) throw new Error("Missing batch boundary metadata");
  const duplicate = segment_query_documents(
    payload,
    new Uint32Array([first.data.offset, first.data.length, first.data.offset, first.data.length]),
  );
  if (duplicate === undefined) throw new Error("Repeated metadata batch unexpectedly declined");
  const firstExpected = expected[0];
  if (firstExpected === undefined) throw new Error("Missing expected metadata projection");
  expect(decodeNativeQueryFixtures(duplicate)).toEqual([firstExpected, firstExpected]);
  const damaged = payload.slice();
  damaged[last.data.offset + 4] = (damaged[last.data.offset + 4] ?? 0) ^ 1;
  expect(() =>
    segment_query_documents(damaged, new Uint32Array([first.data.offset, first.data.length])),
  ).not.toThrow();
  expect(() => segment_query_documents(damaged, ranges)).toThrow();
  using large = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments([
        { id: "large", revision: 1, title: "", text: "x".repeat(70000), attributes: {} },
      ]),
    ),
  );
  const largeHeader = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(large.header_json());
  const largeBytes = large.bytes();
  const largeBase = 16 + new DataView(largeBytes.buffer, largeBytes.byteOffset).getUint32(8, true);
  const page = largeHeader.documents[0];
  if (page === undefined) throw new Error("Missing large metadata page");
  const frame = largeBytes.subarray(
    largeBase + page.data.offset,
    largeBase + page.data.offset + page.data.length,
  );
  expect(segment_query_documents(frame, new Uint32Array([0, frame.length]))).toBeUndefined();
  expect(decodeNativeQueryFixture(segment_query_document(frame)).text).toBe("x".repeat(70000));
});

test("metadata batches mix native vector facts and scalar attribute kinds", () => {
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments([
        {
          id: "a",
          revision: 1,
          title: "",
          text: "no vector",
          attributes: { enabled: true, decimal: 4.25, absent: null, label: "字" },
        },
        {
          id: "b",
          revision: 1,
          title: "",
          text: "vector",
          attributes: { enabled: false, integer: Number.MAX_SAFE_INTEGER },
          vector: [1, ...Array<number>(767).fill(0)],
        },
      ]),
    ),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const payload = bytes.subarray(base, base + header.metadata_end);
  const encoded = segment_query_documents(
    payload,
    new Uint32Array(
      header.documents.flatMap((document) => [document.data.offset, document.data.length]),
    ),
  );
  if (encoded === undefined) throw new Error("Mixed small metadata batch unexpectedly declined");
  const decoded = decodeNativeQueryFixtures(encoded);
  expect(decoded).toEqual(
    header.documents.map((document) =>
      decodeNativeQueryFixture(
        segment_query_document(
          payload.subarray(document.data.offset, document.data.offset + document.data.length),
        ),
      ),
    ),
  );
  expect(decoded.map((document) => document.vectorSummary)).toEqual([null, [768, true, true]]);
});

test.each([2, 3])("metadata codec %i batch budget includes exact decoded prefixes", (codec) => {
  for (const extra of [0, 1]) {
    const frames = [32768, 32768 + extra].map((length, index) => {
      const source = { id: String(index), revision: 1, title: "", text: "", attributes: {} };
      function encode(document: typeof StoredDocument.Type) {
        if (codec === 2) return Schema.encodeSync(Schema.fromJsonString(StoredDocument))(document);
        return Schema.encodeSync(Schema.fromJsonString(CanonicalDocumentMetadata))(
          nativeToCanonicalDocument(document, document.revision),
        );
      }
      const prefix = [2, 0, 0, 0, 0, 0];
      if (codec === 3) prefix.unshift(3);
      const overhead = new TextEncoder().encode(encode(source)).length + prefix.length;
      const json = new TextEncoder().encode(
        encode({ ...source, text: "x".repeat(length - overhead) }),
      );
      const decoded = new Uint8Array(length);
      decoded.set(prefix);
      decoded.set(json, prefix.length);
      const compressed = deflateSync(decoded);
      const frame = new Uint8Array(8 + compressed.length);
      const view = new DataView(frame.buffer);
      view.setUint32(0, length, true);
      view.setUint32(4, crc32(decoded), true);
      frame.set(compressed, 8);
      return frame;
    });
    const first = frames[0];
    const second = frames[1];
    if (first === undefined || second === undefined)
      throw new Error("Missing budget boundary frames");
    const payload = new Uint8Array(first.length + second.length);
    payload.set(first);
    payload.set(second, first.length);
    const encoded = segment_query_documents(
      payload,
      new Uint32Array([0, first.length, first.length, second.length]),
    );
    const scalar = frames.map((frame) => decodeNativeQueryFixture(segment_query_document(frame)));
    if (extra === 1) {
      expect(encoded).toBeUndefined();
      expect(scalar.map((document) => document.id)).toEqual(["0", "1"]);
      continue;
    }
    if (encoded === undefined) throw new Error("Exact decoded batch budget unexpectedly declined");
    expect(decodeNativeQueryFixtures(encoded)).toEqual(scalar);
  }
});

test("lazy selected hot postings preserve cutoff, filters, dead rows and remaining spans", () => {
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        Array.from({ length: 512 }, (_, row) => ({
          id: String(row).padStart(4, "0"),
          revision: 1,
          title: "common dense",
          text: "dense ".repeat(512),
          attributes: { group: row % 2 },
        })),
      ),
    ),
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  using full = Directory.canonical(bytes.subarray(0, base), base);
  using hot = Directory.common(full.common_frame(base, bytes), base, 2000000);
  using empty = Directory.common(full.common_frame(base), base, 2000000);
  for (const mode of ["any", "all", "phrase"] as const) {
    const input = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
      text: "common dense",
      mode,
      top_k: 10,
      dead: [],
      filters: [{ field: "group", op: "eq", value: 1 }],
      statistics: {
        documents: 512,
        title_length: header.total_title_length,
        body_length: header.total_body_length,
        frequencies: Object.fromEntries(
          Object.entries(header.terms).map(([term, meta]) => [term, meta.df]),
        ),
      },
    });
    using prepared = new PreparedQuery(input);
    const add = (ranker: ReturnType<typeof full.ranker>, encoded: string) => {
      for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(encoded))
        for (const block of span.blocks)
          ranker.add(
            span.term,
            bytes.subarray(base + block.data.offset, base + block.data.offset + block.data.length),
          );
    };
    using oracle = full.ranker_prepared(prepared, "[7]");
    add(oracle, oracle.posting_spans());
    const hits = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(oracle.finish());
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0];
    if (first === undefined) throw new Error("Missing ranked fixture hit");
    for (const score of [0.000001, first.score, first.score * 2]) {
      using baseline = full.ranker_prepared(prepared, "[7]");
      const original = baseline.posting_spans_after(score, "0255");
      add(baseline, original);
      const expected = baseline.finish();
      using candidate = hot.ranker_prepared(prepared, "[7]");
      const remaining = candidate.posting_spans_after(score, "0255");
      expect(candidate.posting_spans_after(score, "0255")).toBe(remaining);
      add(candidate, remaining);
      expect(candidate.finish()).toBe(expected);
      using headerOnly = empty.ranker_prepared(prepared, "[7]");
      const missing = headerOnly.posting_spans_after(score, "0255");
      expect(missing).toBe(original);
      add(headerOnly, missing);
      expect(headerOnly.finish()).toBe(expected);
    }
  }
});

test("verified singleton summaries equal full posting rankings and preserve fallback boundaries", () => {
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments([
        { id: "a", title: "alpha", text: "rare common", attributes: { group: 1 } },
        { id: "𐀀", title: "beta", text: "unique common", attributes: { group: 1 } },
        { id: "", title: "gamma", text: "third common", attributes: { group: 1 } },
      ]),
    ),
  );
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const overview = segment_correlated_overview(bytes);
  if (overview === undefined) throw new Error("Missing verified singleton overview");
  using directory = new Directory(bytes);
  const statistics = {
    documents: 1000,
    title_length: 4000,
    body_length: 8000,
    frequencies: Object.fromEntries(
      Object.entries(header.terms).map(([term, metadata]) => [term, metadata.df + 3]),
    ),
  };
  const comparisons = { fast: 0 };
  for (const mode of ["any", "all", "phrase"] as const)
    for (const text of [
      "rare",
      "alpha rare",
      "rare unique",
      "rare absent",
      "rare common",
      "common",
      "rare rare",
    ])
      for (const dead of [[], [0], [1, 2]])
        for (const filters of [
          [],
          [{ field: "group", op: "eq", value: 1 }],
          [{ field: "group", op: "eq", value: 2 }],
        ]) {
          const input = Schema.decodeUnknownSync(RankingInput)({
            text,
            mode,
            top_k: 10,
            dead,
            filters,
            statistics,
          });
          using prepared = new PreparedQuery(
            Schema.encodeSync(Schema.fromJsonString(RankingInput))({ ...input, dead: [] }),
          );
          const terms = JSON.stringify(
            Array.from(new Set(tokenize(text).split(" ").filter(Boolean))),
          );
          const catalog = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
            segment_overview_project(overview, terms, JSON.stringify(filters)),
          );
          const encoded = Schema.encodeSync(Schema.fromJsonString(TermSummaries))(
            catalog.dictionary,
          );
          const hits = prepared.singleton_hits(
            encoded,
            3,
            JSON.stringify(dead),
            JSON.stringify({ group: 1 }),
          );
          if (mode === "phrase" && text.includes(" ")) expect(hits).toBeUndefined();
          if (filters.length > 0)
            expect(prepared.singleton_hits(encoded, 3, JSON.stringify(dead))).toBeUndefined();
          if (hits === undefined) continue;
          using full = directory.ranker(
            Schema.encodeSync(Schema.fromJsonString(RankingInput))(input),
          );
          const spans = Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
            full.posting_spans(),
          );
          for (const span of spans)
            for (const block of span.blocks)
              full.add(
                span.term,
                bytes.subarray(
                  base + block.data.offset,
                  base + block.data.offset + block.data.length,
                ),
              );
          expect(hits).toBe(full.finish());
          comparisons.fast += 1;
        }
  expect(comparisons.fast).toBe(66);
  const headerOnly = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
    segment_overview_project(directory.overview(), '["rare"]', "[]"),
  );
  expect(headerOnly.dictionary.rare?.single).toBeUndefined();
  const block = header.terms.rare?.blocks[0];
  if (block === undefined) throw new Error("Missing singleton posting");
  const corrupt = bytes.slice();
  const offset = base + block.data.offset + 8;
  const original = corrupt[offset];
  if (original === undefined) throw new Error("Missing singleton CRC byte");
  corrupt[offset] = original ^ 1;
  expect(() => segment_correlated_overview(corrupt)).toThrow();
});

function projectSingletonDictionary(proofs: string) {
  const json = `[{"rare":0},[[{},0,0]],null,[{"df":1,"bounds":[[0,1,0,1]]}],${proofs}]`;
  const data = new TextEncoder().encode(json);
  const compressed = deflateSync(data);
  const bytes = new Uint8Array(8 + compressed.byteLength);
  const frame = new DataView(bytes.buffer);
  frame.setUint32(0, data.byteLength, true);
  frame.setUint32(4, crc32(data), true);
  bytes.set(compressed, 8);
  return Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
    segment_overview_project(bytes, '["rare","absent"]', "[]"),
  );
}

test("separate singleton dictionaries validate selected facts and reject dangling references", () => {
  expect(projectSingletonDictionary('{"rare":[0,"a",7,8]}').dictionary.rare?.single).toEqual({
    row: 0,
    id: "a",
    data: { offset: 7, length: 8 },
  });
  expect(projectSingletonDictionary("{}").dictionary.rare?.single).toBeUndefined();
  for (const proofs of [
    "null",
    "[]",
    '{"rare":[0,"a",0]}',
    '{"rare":[0,"a",0,8,0]}',
    '{"rare":[-1,"a",0,8]}',
    '{"rare":[0,1,0,8]}',
    '{"rare":[0,"a",0,0]}',
    '{"rare":[10000,"a",0,8]}',
    '{"rare":[0,"",0,8]}',
    '{"rare":[0,"a",4294967295,8]}',
    '{"rare":[0,"a",0,8],"r\\u0061re":[0,"a",0,8]}',
    '{"absent":[0,"a",0,8]}',
  ])
    expect(() => projectSingletonDictionary(proofs)).toThrow();
});
