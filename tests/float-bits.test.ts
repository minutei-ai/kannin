import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Float64BitsText } from "../src/protocol";

test("float bits agree with native IEEE-754 decoding without rewriting signed zero", () => {
  const cases = [
    0n,
    0x8000000000000000n,
    1n,
    0x8000000000000001n,
    0x0010000000000000n,
    0x3ff0000000000000n,
    0x3ff8000000000000n,
    0x7fefffffffffffffn,
    0xffefffffffffffffn,
    0x7ff0000000000000n,
    0xfff0000000000000n,
    0x7ff0000000000001n,
    0x7ff8000000000000n,
    0xffffffffffffffffn,
    ...Array.from(
      { length: 1024 },
      (_, index) => (BigInt(index) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn,
    ),
  ];
  const view = new DataView(new ArrayBuffer(8));
  const decode = Schema.decodeSync(Schema.fromJsonString(Float64BitsText));
  const encode = Schema.encodeSync(Schema.fromJsonString(Float64BitsText));
  for (const bits of cases) {
    const text = bits.toString(16).padStart(16, "0");
    view.setBigUint64(0, bits);
    const finite = Number.isFinite(view.getFloat64(0));
    expect(Schema.is(Float64BitsText)(text)).toBe(finite);
    if (finite) expect(decode(encode(text))).toBe(text);
  }
  view.setBigUint64(0, 0x8000000000000000n);
  expect(Object.is(view.getFloat64(0), -0)).toBe(true);
});

test("float bit validation rejects malformed text before parsing it", () => {
  for (const value of [
    "",
    "0",
    "00000000000000000",
    "3FF0000000000000",
    "3ff0000000000000\n",
    "0x3ff0000000000000",
    "gggggggggggggggg",
    "+000000000000000",
    1,
    null,
  ])
    expect(Schema.is(Float64BitsText)(value)).toBe(false);
});
