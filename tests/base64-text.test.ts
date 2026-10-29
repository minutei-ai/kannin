import { expect, test } from "bun:test";
import { Schema } from "effect";
import { BytesBase64Text } from "../src/protocol";

test("bytes base64 preserves canonical native encodings across every padding length", () => {
  const codec = Schema.fromJsonString(BytesBase64Text);
  const decode = Schema.decodeSync(codec);
  const encode = Schema.encodeSync(codec);
  for (const length of Array.from({ length: 129 }, (_, index) => index)) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 73 + length) % 256);
    const text = btoa(String.fromCharCode(...bytes));
    expect(Schema.is(BytesBase64Text)(text)).toBe(true);
    expect(decode(encode(text))).toBe(text);
    expect(Uint8Array.from(atob(text), (character) => character.charCodeAt(0))).toEqual(bytes);
  }
});

test("bytes base64 rejects non-canonical encodings and malformed padding", () => {
  for (const value of [
    "A",
    "AA",
    "AAA",
    "====",
    "A===",
    "AA=A",
    "AA==AAAA",
    "AB==",
    "AAB=",
    "AA-_",
    "AAAA\n",
    "AAA ",
    "ＡAAA",
    "AA\u0000=",
    null,
    12,
  ])
    expect(Schema.is(BytesBase64Text)(value)).toBe(false);
});

test("bytes base64 enforces the decoded size rather than encoded length alone", () => {
  const prefix = "A".repeat(11_184_808);
  expect(Schema.is(BytesBase64Text)(`${prefix}AAA=`)).toBe(true);
  expect(Schema.is(BytesBase64Text)(`${prefix}AAAA`)).toBe(false);
  expect(Schema.is(BytesBase64Text)(`${prefix}AAAAAA==`)).toBe(false);
});
