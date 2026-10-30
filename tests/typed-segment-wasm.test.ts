import { expect, test } from "bun:test";
import { Schema } from "effect";
import { initSync, Segment, segment_header } from "../dist/wasm/raio_engine";

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
