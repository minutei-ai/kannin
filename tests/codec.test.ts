import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  initSync,
  pack,
  unpack,
  tokenize,
  segment_bloom,
  segment_bloom_filter_many,
  segment_term_bounds,
} from "../dist/wasm/raio_engine";

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
