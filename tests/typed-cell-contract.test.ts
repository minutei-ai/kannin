import { expect, test } from "bun:test";
import { Schema } from "effect";
import { AttributeValue, TypedCell } from "../src/protocol";

const codec = Schema.fromJsonString(TypedCell);
const decode = Schema.decodeSync(codec, { onExcessProperty: "error" });
const encode = Schema.encodeSync(codec, { onExcessProperty: "error" });

test("typed cell JSON retains exact scalars and homogeneous arrays", () => {
  const scalars = [
    "texto",
    true,
    { i64: "-9223372036854775808" },
    { i64: "9223372036854775807" },
    { u64: "18446744073709551615" },
    { f64: "8000000000000000" },
    { f64: "0000000000000001" },
    { uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    { datetime_ms: "-9223372036854775808" },
  ];
  for (const input of [null, [], { bytes: "AP8=" }, ...scalars]) {
    const json = JSON.stringify(input);
    expect(encode(decode(json))).toBe(json);
  }
  for (const scalar of scalars) {
    const json = JSON.stringify([scalar, scalar]);
    expect(encode(decode(json))).toBe(json);
  }
});

test("typed cell JSON rejects ambiguous tags, bare numbers and mixed arrays", () => {
  for (const input of [
    1,
    {},
    { i64: "1", u64: "1" },
    { i64: "1", ignored: true },
    { i64: "01" },
    { u64: "18446744073709551616" },
    { f64: "7ff0000000000000" },
    { datetime_ms: "9223372036854775808" },
    { bytes: "AB==" },
    { unknown: "value" },
    [null],
    [1],
    ["1", true],
    [{ i64: "1" }, { u64: "1" }],
    [{ bytes: "AA==" }],
    [["nested"]],
    Array.from({ length: 4097 }, () => true),
  ])
    expect(() => decode(JSON.stringify(input))).toThrow();
  expect(decode(JSON.stringify(Array.from({ length: 4096 }, () => true)))).toHaveLength(4096);
});

test("typed cell declarations do not widen the historical attribute contract", () => {
  for (const value of [{ i64: "1" }, { bytes: "AA==" }, [{ u64: "1" }]])
    expect(Schema.is(AttributeValue)(value)).toBe(false);
  expect(Schema.is(AttributeValue)([1, "text", null])).toBe(true);
});
