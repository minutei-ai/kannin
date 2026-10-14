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
} from "../dist/wasm/raio_engine";
import {
  StoredDocument,
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

test("binary overviews reject rechecksummed malformed dictionaries and eligibility", () => {
  const prefix = new Uint8Array(44);
  prefix.set(new TextEncoder().encode("RAIOOVR3"));
  const view = new DataView(prefix.buffer);
  view.setUint32(8, 1, true);
  view.setUint32(12, 4, true);
  prefix.set(new TextEncoder().encode("rust"), 16);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  view.setUint32(32, 1, true);
  view.setUint32(40, 1, true);
  const badMagic = prefix.slice();
  badMagic[0] = 0;
  const badUtf8 = prefix.slice();
  badUtf8[16] = 255;
  const duplicate = new Uint8Array(76);
  duplicate.set(prefix);
  duplicate.set(prefix.subarray(12), 44);
  new DataView(duplicate.buffer).setUint32(8, 2, true);
  const unordered = duplicate.slice();
  unordered[48] = 97;
  const corrupted = [
    badMagic,
    badUtf8,
    duplicate,
    unordered,
    prefix.slice(0, 43),
    ...[
      [8, 4294967295],
      [12, 4294967295],
      [12, 0],
      [20, 0],
      [24, 0],
      [24, 4294967295],
    ].map(([offset, value]) => {
      const bytes = prefix.slice();
      if (offset === undefined || value === undefined)
        throw new Error("Missing corruption fixture");
      new DataView(bytes.buffer).setUint32(offset, value, true);
      return bytes;
    }),
  ];
  const cases = [
    ...corrupted.map((bytes) => [bytes, "[[{},0,1]]"] as const),
    ...[
      "[]",
      "[[[],0,0]]",
      "[[{},-1,0]]",
      "[[{},0,0,0]]",
      '{"unknown":true}',
      '[[{"unused":1e400},0,0]]',
      '[[{"unused":"\\ud800"},0,0]]',
      "[[{},0,0]] trailing",
    ].map((json) => [prefix, json] as const),
  ];
  for (const [dictionary, json] of [[prefix, "[[{},0,1]]"] as const, ...cases]) {
    const groups = new TextEncoder().encode(json);
    const data = new Uint8Array(dictionary.length + groups.length);
    data.set(dictionary);
    data.set(groups, dictionary.length);
    const compressed = deflateSync(data);
    const bytes = new Uint8Array(8 + compressed.byteLength);
    const frame = new DataView(bytes.buffer);
    frame.setUint32(0, data.byteLength, true);
    frame.setUint32(4, crc32(data), true);
    bytes.set(compressed, 8);
    if (dictionary === prefix && json === "[[{},0,1]]") {
      expect(
        Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
          segment_overview_project(bytes, '["rust"]', "[]"),
        ).dictionary.rust?.df,
      ).toBe(1);
      continue;
    }
    expect(() => segment_overview_project(bytes, '["absent"]', "[]")).toThrow();
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
