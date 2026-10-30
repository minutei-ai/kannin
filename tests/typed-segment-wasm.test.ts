import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  initSync,
  Segment,
  segment_header,
  segment_document,
  segment_query_document,
} from "../dist/wasm/raio_engine";
import { FieldName, TypedCell } from "../src/protocol";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const columns = JSON.stringify([{ name: "count", type: "u64", filterable: true }]);
const documents = (attributes: unknown) =>
  JSON.stringify([{ id: "a", revision: 1, roles: { title: "", text: "search" }, attributes }]);

test("WASM builds typed segments through the canonical Rust column owner", () => {
  using segment = Segment.with_columns(
    documents({ count: { u64: "18446744073709551615" } }),
    columns,
  );
  const bytes = segment.bytes();
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("RAIOSEG6");
  const decode = Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(6) })),
  );
  expect(decode(segment_header(bytes)).version).toBe(6);
});

test("WASM rejects typed cells outside their declared columns without coercion", () => {
  for (const attributes of [
    { count: 1 },
    { count: { u64: "18446744073709551616" } },
    { count: { i64: "1" } },
    { count: { u64: "1", ignored: true } },
    { undeclared: { u64: "1" } },
  ])
    expect(() => Segment.with_columns(documents(attributes), columns)).toThrow();
  expect(() =>
    Segment.with_columns(
      documents({ count: { u64: "1" } }),
      JSON.stringify([{ name: "count", type: "u64", ignored: true }]),
    ),
  ).toThrow();
});

test("WASM document reads retain exact cells with an explicit format policy", () => {
  const attributes = { count: { u64: "18446744073709551615" } };
  using segment = Segment.with_columns(documents(attributes), columns);
  const bytes = segment.bytes();
  const range = Schema.Struct({ offset: Schema.Int, length: Schema.Int });
  const header = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({ documents: Schema.Array(Schema.Struct({ data: range })) }),
    ),
  )(segment.header_json());
  const row = header.documents[0];
  if (row === undefined) throw new Error("Missing typed fixture row");
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const metadata = bytes.subarray(base + row.data.offset, base + row.data.offset + row.data.length);
  const decode = Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ attributes: Schema.Record(FieldName, TypedCell) })),
  );
  expect(decode(segment_document(metadata, new Uint8Array(), true)).attributes).toEqual(attributes);
  expect(decode(segment_query_document(metadata, true)).attributes).toEqual(attributes);
  expect(() => segment_document(metadata, new Uint8Array())).toThrow("codec");
  expect(() => segment_query_document(metadata)).toThrow("codec");
});
