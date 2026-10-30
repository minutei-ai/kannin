import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  initSync,
  Directory,
  directory_compress,
  segment_fields,
  Segment,
  segment_build_text_fields,
  segment_local_field_statistics,
  segment_rank_fields,
} from "../dist/wasm/raio_engine";
import {
  CorpusStatistics,
  FieldBuild,
  FieldQuery,
  FieldRankHit,
  FieldStatisticsQuery,
  NamedTextFields,
  SegmentTextFields,
  DataRange,
  SegmentHits,
} from "../src/protocol";
import type { DocumentColumnId } from "../src/protocol";
import { canonicalFixtureDocuments } from "./segment-fixture";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const encodeFields = Schema.encodeSync(Schema.fromJsonString(NamedTextFields));
const encodeBuild = Schema.encodeSync(Schema.fromJsonString(FieldBuild));
const encodeQuery = Schema.encodeSync(Schema.fromJsonString(FieldQuery));
const encodeStatisticsQuery = Schema.encodeSync(Schema.fromJsonString(FieldStatisticsQuery));
const decodeStats = Schema.decodeSync(Schema.fromJsonString(CorpusStatistics), {
  onExcessProperty: "error",
});
const decodeHits = Schema.decodeSync(Schema.fromJsonString(Schema.Array(FieldRankHit)), {
  onExcessProperty: "error",
});
const title: typeof DocumentColumnId.Type = { source: "native", role: "title" };
const text: typeof DocumentColumnId.Type = { source: "native", role: "text" };
const tags: typeof DocumentColumnId.Type = { source: "attribute", name: "tags" };
const titleAttribute: typeof DocumentColumnId.Type = { source: "attribute", name: "title" };
const columns = JSON.stringify([
  { name: "stamp", type: "i64", filterable: true },
  { name: "count", type: "u64", filterable: true },
  { name: "tags", type: "[string]", filterable: true },
  { name: "title", type: "string" },
]);
const declarations = encodeFields([{ name: "tags" }, { name: "title" }]);
const typedDocument = (id: string, body: string, attributes: unknown) => ({
  id,
  revision: 1,
  roles: { title: "", text: body },
  attributes,
});
const documents = (...rows: ReadonlyArray<unknown>) => JSON.stringify(rows);
const rows = (bytes: Uint8Array, request: string) =>
  decodeHits(segment_rank_fields(bytes, request)).map(({ row }) => row);
const query = (
  fields: ReadonlyArray<typeof DocumentColumnId.Type>,
  body: string,
  extra: Partial<Omit<typeof FieldQuery.Type, "fields" | "text">> = {},
) => encodeQuery({ fields, text: body, mode: "all", ...extra });
const phraseFixture = documents(
  typedDocument("a", "native", { tags: ["red", "fox"], title: "nebula" }),
  typedDocument("b", "native", { tags: ["red the fox"], title: "red fox" }),
  typedDocument("c", "native", { tags: ["red fox"] }),
);

test("with_columns keeps the two-argument bytes and indexes no named text without declarations", () => {
  using plain = Segment.with_columns(phraseFixture, columns);
  using omitted = Segment.with_columns(phraseFixture, columns, undefined);
  using absent = Segment.with_columns(phraseFixture, columns, null);
  using empty = Segment.with_columns(phraseFixture, columns, "[]");
  expect(new TextDecoder().decode(plain.bytes().subarray(0, 8))).toBe("RAIOSEG6");
  expect(omitted.bytes()).toEqual(plain.bytes());
  expect(absent.bytes()).toEqual(plain.bytes());
  expect(empty.bytes()).toEqual(plain.bytes());
  expect(() =>
    segment_local_field_statistics(
      plain.bytes(),
      encodeStatisticsQuery({ fields: [tags], text: "red fox", mode: "all" }),
    ),
  ).toThrow();
});

test("with_columns named fields produce statistics and ranking for strings and arrays", () => {
  using segment = Segment.with_columns(phraseFixture, columns, declarations);
  const bytes = segment.bytes();
  const statistics = decodeStats(
    segment_local_field_statistics(
      bytes,
      encodeStatisticsQuery({ fields: [tags], text: "red fox", mode: "all" }),
    ),
  );
  expect(statistics.documents).toBe(3);
  expect(statistics.fields.map(({ id }) => id)).toEqual([tags]);
  expect(statistics.fields[0]?.frequencies).toEqual({ fox: 3, red: 3 });
  expect(rows(bytes, query([tags], "red fox", { mode: "phrase" }))).toEqual([2]);
  expect(rows(bytes, query([tags], "red the fox", { mode: "phrase" }))).toEqual([1]);
  expect(rows(bytes, query([tags], "red fox")).toSorted((left, right) => left - right)).toEqual([
    0, 1, 2,
  ]);
  expect(rows(bytes, query([titleAttribute], "red fox"))).toEqual([1]);
});

test("named attributes called title and text stay isolated from native roles", () => {
  using segment = Segment.with_columns(phraseFixture, columns, declarations);
  const bytes = segment.bytes();
  expect(rows(bytes, query([titleAttribute], "nebula"))).toEqual([0]);
  expect(rows(bytes, query([title], "nebula"))).toEqual([]);
  expect(rows(bytes, query([text], "nebula"))).toEqual([]);
  expect(rows(bytes, query([text], "native")).toSorted((left, right) => left - right)).toEqual([
    0, 1, 2,
  ]);
  expect(rows(bytes, query([titleAttribute], "native"))).toEqual([]);
  expect(() => rows(bytes, query([{ source: "attribute", name: "text" }], "native"))).toThrow();
});

const exactFixture = documents(
  typedDocument("a", "native", {
    tags: ["rust rust"],
    stamp: { i64: "9007199254740993" },
    count: { u64: "18446744073709551615" },
  }),
  typedDocument("b", "native", {
    tags: ["rust"],
    stamp: { i64: "9007199254740994" },
    count: { u64: "18446744073709551614" },
  }),
  typedDocument("c", "native", {
    tags: ["rust rust rust"],
    stamp: { i64: "9007199254740992" },
    count: { u64: "18446744073709551613" },
  }),
);

test("typed operands above 2^53 filter exactly before named top-k and tombstones apply first", () => {
  using segment = Segment.with_columns(exactFixture, columns, declarations);
  const bytes = segment.bytes();
  const filtered = (filters: NonNullable<typeof FieldQuery.Type.filters>) =>
    rows(bytes, query([tags], "rust", { mode: "any", top_k: 1, filters }));
  const above: NonNullable<typeof FieldQuery.Type.filters> = [
    { field: "stamp", op: "gt", value: { i64: "9007199254740993" } },
  ];
  expect(filtered(above)).toEqual([1]);
  expect(filtered([{ field: "stamp", op: "eq", value: { i64: "9007199254740993" } }])).toEqual([0]);
  expect(filtered([{ field: "count", op: "eq", value: { u64: "18446744073709551615" } }])).toEqual([
    0,
  ]);
  expect(filtered([{ field: "count", op: "lt", value: { u64: "18446744073709551614" } }])).toEqual([
    2,
  ]);
  expect(filtered([{ field: "tags", op: "contains", value: "rust rust" }])).toEqual([0]);
  expect(
    rows(bytes, query([tags], "rust", { mode: "any", top_k: 1, dead: [1], filters: above })),
  ).toEqual([]);
  const best = rows(bytes, query([tags], "rust", { mode: "any", top_k: 1 }));
  const next = rows(bytes, query([tags], "rust", { mode: "any", top_k: 1, dead: best }));
  expect(next).toHaveLength(1);
  expect(next).not.toEqual(best);
});

test("explicit global statistics rank filtered named fields like the local corpus", () => {
  using segment = Segment.with_columns(exactFixture, columns, declarations);
  const bytes = segment.bytes();
  const statistics = decodeStats(
    segment_local_field_statistics(
      bytes,
      encodeStatisticsQuery({ fields: [tags], text: "rust", mode: "any" }),
    ),
  );
  const filters: NonNullable<typeof FieldQuery.Type.filters> = [
    { field: "stamp", op: "gte", value: { i64: "9007199254740993" } },
  ];
  const request = (extra: Partial<Omit<typeof FieldQuery.Type, "fields" | "text">>) =>
    query([tags], "rust", { mode: "any", filters, ...extra });
  expect(decodeHits(segment_rank_fields(bytes, request({ statistics })))).toEqual(
    decodeHits(segment_rank_fields(bytes, request({}))),
  );
});

test("legacy segments keep scalar filters and reject typed tags", () => {
  const legacy = segment_build_text_fields(
    encodeBuild({
      documents: canonicalFixtureDocuments([
        { id: "a", text: "native", attributes: { tags: "red fox" } },
      ]),
      text_fields: [{ name: "tags" }],
    }),
  );
  expect(
    rows(
      legacy,
      query([tags], "red fox", { filters: [{ field: "tags", op: "eq", value: "red fox" }] }),
    ),
  ).toEqual([0]);
  for (const value of [{ u64: "1" }, { i64: "1" }, { f64: "3ff0000000000000" }])
    expect(() =>
      rows(legacy, query([tags], "red fox", { filters: [{ field: "tags", op: "eq", value }] })),
    ).toThrow();
});

const rawQuery = (filter: string) =>
  `{"fields":[{"source":"attribute","name":"tags"}],"text":"rust","mode":"any","filters":[${filter}]}`;

test("typed segments reject noncanonical, overflowing, nested and unknown filter operands", () => {
  using segment = Segment.with_columns(exactFixture, columns, declarations);
  const bytes = segment.bytes();
  expect(rows(bytes, rawQuery('{"field":"stamp","op":"gt","value":{"i64":"1"}}')).length).toBe(3);
  const invalid = [
    '{"field":"count","op":"eq","value":{"u64":"18446744073709551616"}}',
    '{"field":"count","op":"eq","value":{"u64":"01"}}',
    '{"field":"count","op":"eq","value":{"u64":1}}',
    '{"field":"count","op":"eq","value":{"u64":"1","extra":true}}',
    '{"field":"count","op":"eq","value":{"i64":"1","u64":"1"}}',
    '{"field":"count","op":"eq","value":{"nope":"1"}}',
    '{"field":"count","op":"eq","value":{}}',
    '{"field":"count","op":"eq","value":1}',
    '{"field":"count","op":"eq","value":[{"u64":"1"}]}',
    '{"field":"count","op":"gt","value":true}',
    '{"field":"count","op":"gt","value":null}',
    '{"field":"tags","op":"eq","value":[[{"u64":"1"}]]}',
    '{"field":"tags","op":"contains","value":[{"u64":"1"}]}',
    '{"field":"tags","op":"containsAny","value":[[{"u64":"1"}]]}',
    '{"field":"count","op":"in","value":[]}',
    '{"field":"count","op":"in","value":[1,2]}',
    '{"field":"tags","op":"in","value":[["rust"]]}',
    `{"field":"count","op":"in","value":[${Array.from({ length: 33 }, () => '{"u64":"1"}').join(",")}]}`,
    '{"field":"count","op":"gt","value":{"f64":"7ff8000000000000"}}',
    '{"field":"count","op":"gt","value":{"f64":"3FF0000000000000"}}',
    '{"field":"count","op":"eq","value":{"bytes":"AA=="}}',
    '{"field":"count","op":"mystery","value":{"u64":"1"}}',
    '{"field":"$count","op":"eq","value":{"u64":"1"}}',
    '{"field":"count","op":"exists","value":{"u64":"1"}}',
    '{"field":"count","op":"eq","value":{"u64":"1"},"extra":true}',
  ];
  for (const filter of invalid) expect(() => rows(bytes, rawQuery(filter))).toThrow();
});

test("forged magic never reinterprets typed filters against another stored version", () => {
  using typed = Segment.with_columns(exactFixture, columns, declarations);
  const legacy = segment_build_text_fields(
    encodeBuild({
      documents: canonicalFixtureDocuments([
        { id: "a", text: "native", attributes: { tags: "rust" } },
      ]),
      text_fields: [{ name: "tags" }],
    }),
  );
  const forgedTyped = typed.bytes();
  forgedTyped.set(new TextEncoder().encode("RAIOSEG4"));
  const forgedLegacy = new Uint8Array(legacy);
  forgedLegacy.set(new TextEncoder().encode("RAIOSEG6"));
  const request = rawQuery('{"field":"count","op":"eq","value":{"u64":"1"}}');
  expect(() => segment_rank_fields(forgedTyped, request)).toThrow();
  expect(() => segment_rank_fields(forgedLegacy, request)).toThrow();
});

test("with_columns rejects malformed, oversized, duplicate, undeclared and wrongly typed declarations", () => {
  const sixtyFive = JSON.stringify(
    Array.from({ length: 65 }, (_, index) => ({ name: `f${String(index).padStart(2, "0")}` })),
  );
  const invalid = [
    "{",
    "null",
    '{"name":"tags"}',
    '[{"name":"tags","extra":true}]',
    '[{"name":"tags","config":{"extra":true}}]',
    '[{"name":"tags","config":{"max_token_length":0}}]',
    '[{"name":"tags","config":{"case_sensitive":true}}]',
    '[{"name":"tags"},{"name":"tags"}]',
    '[{"name":"title"},{"name":"tags"}]',
    '[{"name":"missing"}]',
    '[{"name":"count"}]',
    '[{"name":"stamp"}]',
    '[{"name":""}]',
    '[{"name":"$tags"}]',
    sixtyFive,
    `[${" ".repeat(16 * 1024 * 1024 + 1)}]`,
  ];
  for (const declaration of invalid)
    expect(() => Segment.with_columns(phraseFixture, columns, declaration)).toThrow();
  using segment = Segment.with_columns(phraseFixture, columns, declarations);
  expect(new TextDecoder().decode(segment.bytes().subarray(0, 8))).toBe("RAIOSEG6");
});

test("complete directories expose the same typed named field table without posting payloads", () => {
  using segment = Segment.with_columns(phraseFixture, columns, declarations);
  const bytes = segment.bytes();
  const length =
    16 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  const canonical = bytes.subarray(0, length);
  const decode = Schema.decodeSync(Schema.fromJsonString(SegmentTextFields), {
    onExcessProperty: "error",
  });
  const expected = decode(segment_fields(bytes));
  using full = new Directory(bytes);
  using header = Directory.canonical(canonical, length);
  const frame = directory_compress(canonical);
  using compressed = Directory.compressed(frame, length, 40 * 1024 * 1024);
  using retained = compressed.retain();
  expect(decode(full.fields())).toEqual(expected);
  expect(decode(header.fields())).toEqual(expected);
  expect(decode(compressed.fields())).toEqual(expected);
  expect(decode(retained.fields())).toEqual(expected);
  expect(expected.map((field) => field.name)).toEqual([null, null, "tags", "title"]);
});

test("directory field passes rank exact typed posting ranges in arbitrary arrival order", () => {
  using segment = Segment.with_columns(phraseFixture, columns, declarations);
  const bytes = segment.bytes();
  const base =
    16 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  using directory = Directory.canonical(bytes.subarray(0, base), base);
  const request = query([tags], "red fox", { mode: "phrase" });
  const pass = directory.field_rank_pass(request, 16 * 1024 * 1024, 16 * 1024 * 1024);
  const ranges = Schema.decodeSync(Schema.fromJsonString(Schema.Array(DataRange)))(pass.ranges());
  expect(ranges.length).toBeGreaterThan(0);
  for (const range of [...ranges].reverse()) {
    pass.add(range.offset, bytes.subarray(base + range.offset, base + range.offset + range.length));
  }
  const hits = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(pass.finish());
  expect(hits.map(({ row, score }) => ({ row, score }))).toEqual(
    decodeHits(segment_rank_fields(bytes, request)),
  );
  expect(hits.map(({ id }) => id)).toEqual(["c"]);
  expect(() => directory.field_rank_pass(request, 0, 16 * 1024 * 1024)).toThrow("budget");
  expect(() => directory.field_rank_pass(request, 16 * 1024 * 1024, 0)).toThrow("budget");
  using invalid = directory.field_rank_pass(request, 16 * 1024 * 1024, 16 * 1024 * 1024);
  for (const range of ranges.slice(0, 1)) {
    const page = bytes.subarray(base + range.offset, base + range.offset + range.length);
    expect(() => invalid.add(range.offset, page.subarray(1))).toThrow();
    invalid.add(range.offset, page);
    expect(() => invalid.add(range.offset, page)).toThrow("Duplicate");
  }
  expect(() => invalid.add(0xffffffff, new Uint8Array())).toThrow("Unplanned");
  const missing = directory.field_rank_pass(request, 16 * 1024 * 1024, 16 * 1024 * 1024);
  expect(() => missing.finish()).toThrow("Missing");
});
