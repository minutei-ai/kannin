import { expect, test } from "bun:test";
import { Schema } from "effect";
import { SegmentTextFields } from "../src/protocol";
import type { SegmentTextField, WordV4Config } from "../src/protocol";

const analysis: typeof WordV4Config.Type = {
  max_token_length: 39,
  case_sensitive: false,
  stopwords: "english",
  stemming: null,
  ascii_folding: false,
};
const title: typeof SegmentTextField.Type = {
  kind: "title",
  name: null,
  analysis: null,
  total: 3,
  terms: 2,
};
const text: typeof SegmentTextField.Type = { ...title, kind: "text" };
function attribute(name: string): typeof SegmentTextField.Type {
  return { kind: "attribute", name, analysis, total: 1, terms: 1 };
}

test("field contracts preserve native roles and same-name attributes as distinct identities", () => {
  const fields = [title, text, attribute("text"), attribute("title")];
  expect(Schema.decodeSync(SegmentTextFields)(fields)).toEqual(fields);
});

test("field contracts reject inconsistent analysis, identities, ordering and counts", () => {
  const invalid: ReadonlyArray<unknown> = [
    [],
    [text, title],
    [title, { ...text, name: "text" }],
    [{ ...title, analysis }, text],
    [title, text, { ...attribute("tags"), analysis: null }],
    [title, text, { ...attribute("tags"), name: null }],
    [title, text, attribute("tags"), attribute("tags")],
    [title, text, attribute("z"), attribute("a")],
    [title, text, title],
    [title, text, { ...attribute("tags"), total: -1 }],
    [title, text, { ...attribute("tags"), terms: 0.5 }],
    [title, text, attribute("$reserved")],
    [title, text, attribute("x".repeat(129))],
    [
      title,
      text,
      ...Array.from({ length: 65 }, (_, index) => attribute(`f${String(index).padStart(2, "0")}`)),
    ],
  ];
  for (const fields of invalid)
    expect(Schema.decodeUnknownExit(SegmentTextFields)(fields)._tag).toBe("Failure");
});

test("the field contract accepts the complete 64-attribute budget in UTF-8 order", () => {
  const names = Array.from({ length: 63 }, (_, index) => `f${String(index).padStart(2, "0")}`);
  const fields = [title, text, ...names.map(attribute), attribute("日本語")];
  expect(Schema.decodeSync(SegmentTextFields)(fields)).toHaveLength(66);
});
