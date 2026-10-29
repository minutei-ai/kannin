import { expect, test } from "bun:test";
import { Schema } from "effect";
import { CanonicalId, Int64Text, Uint64Text, UuidText } from "../src/protocol";

const intMinimum = -(1n << 63n);
const intMaximum = (1n << 63n) - 1n;
const uintMaximum = (1n << 64n) - 1n;

test("exact integer contracts agree with a bigint range oracle", () => {
  const values = [
    intMinimum - 1n,
    intMinimum,
    intMinimum + 1n,
    -(1n << 53n) - 1n,
    -1n,
    0n,
    1n,
    (1n << 53n) + 1n,
    intMaximum - 1n,
    intMaximum,
    intMaximum + 1n,
    uintMaximum - 1n,
    uintMaximum,
    uintMaximum + 1n,
    ...Array.from(
      { length: 256 },
      (_, index) => ((BigInt(index) * 11400714819323198485n) % (1n << 65n)) - (1n << 64n),
    ),
  ];
  for (const value of values) {
    const encoded = value.toString();
    expect(Schema.is(Int64Text)(encoded)).toBe(value >= intMinimum && value <= intMaximum);
    expect(Schema.is(Uint64Text)(encoded)).toBe(value >= 0n && value <= uintMaximum);
    expect(Schema.is(CanonicalId)({ kind: "uint", value: encoded })).toBe(
      value >= 0n && value <= uintMaximum,
    );
  }
});

test("integer contracts reject noncanonical spellings without coercion", () => {
  for (const value of [
    "",
    "+1",
    "00",
    "01",
    "-01",
    "-0",
    "-00",
    "1e0",
    "1.0",
    "1\n",
    "１",
    1,
    1n,
  ]) {
    expect(Schema.is(Int64Text)(value)).toBe(false);
    expect(Schema.is(Uint64Text)(value)).toBe(false);
  }
});

test("the shared UUID text contract retains canonical spelling and ID validation", () => {
  const value = "00112233-4455-6677-8899-aabbccddeeff";
  expect(Schema.is(UuidText)(value)).toBe(true);
  expect(Schema.is(CanonicalId)({ kind: "uuid", value })).toBe(true);
  for (const invalid of [value.toUpperCase(), value.replaceAll("-", ""), `${value}\n`]) {
    expect(Schema.is(UuidText)(invalid)).toBe(false);
    expect(Schema.is(CanonicalId)({ kind: "uuid", value: invalid })).toBe(false);
  }
});
