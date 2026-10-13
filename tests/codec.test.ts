import { expect, test } from "bun:test";
import { initSync, pack, unpack, tokenize } from "../dist/wasm/raio_engine";

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
