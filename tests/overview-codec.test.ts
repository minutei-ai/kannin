import { expect, test } from "bun:test";
import { Schema } from "effect";
import { CorrelatedOverview, OverviewBatch } from "../src/protocol";

const original = Schema.Array(Schema.Uint8ArrayFromBase64);

test("overview Base64 preserves native bytes, padding, CRLF and rejected inputs", () => {
  for (const length of [0, 1, 2, 3, 4, 255, 256, 257, 65_537]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 71 + length) % 256);
    const expected = Schema.encodeSync(original)([bytes]);
    expect(Schema.encodeSync(OverviewBatch)([bytes])).toEqual(expected);
    for (const text of expected) {
      expect(Schema.encodeSync(CorrelatedOverview.fields.overview)(bytes)).toBe(text);
      for (const encoded of [text, text.replace(/.{1,76}/g, "$&\r\n")]) {
        expect(Schema.decodeSync(OverviewBatch)([encoded])).toEqual(
          Schema.decodeSync(original)([encoded]),
        );
      }
    }
  }
  for (const text of [
    "",
    "Zg==",
    "Zh==",
    "Zm8=",
    "Zm9=",
    "AAAA",
    "\rA\nA\rA\nA",
    "A",
    "AA",
    "AAA",
    "AAAAA",
    "=AAA",
    "A=AA",
    "AA=A",
    "A===",
    "====",
    "AA==AA==",
    "AA==AAAA",
    "Zg=",
    "Zg===",
    "AA-A",
    "AA_A",
    "AA A",
    "AA\tA",
    "AA\vA",
    "AA\fA",
    "AA\u00a0A",
    "AA\u0000A",
    "AA日本",
    "😀",
    "AA==\n\r",
  ]) {
    const reference = Schema.decodeExit(original)([text]);
    const candidate = Schema.decodeExit(OverviewBatch)([text]);
    expect(candidate._tag).toBe(reference._tag);
    if (reference._tag === "Success" && candidate._tag === "Success") {
      expect(candidate.value).toEqual(reference.value);
    }
  }
  expect(
    Schema.encodeExit(CorrelatedOverview.fields.overview)(new Uint8Array(1024 * 1024 + 1))._tag,
  ).toBe("Failure");
  expect(Schema.decodeExit(OverviewBatch)([])._tag).toBe("Failure");
  expect(Schema.decodeExit(OverviewBatch)(Array.from({ length: 17 }, () => "AA=="))._tag).toBe(
    "Failure",
  );
  expect(Schema.encodeExit(OverviewBatch)([new Uint8Array(3 * 1024 * 1024 + 1)])._tag).toBe(
    "Failure",
  );
});
