import { expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import {
  CanonicalDocument,
  CanonicalDocumentMetadata,
  CanonicalQueryDocument,
  Write,
  canonicalToNativeDocument,
  canonicalToQueryRow,
  nativeToCanonicalDocument,
  readCanonicalColumn,
} from "../src/protocol";

test("canonical native roles remain distinct from same-name attribute columns", () => {
  const input = Schema.decodeSync(Write)({
    requestId: "canonical-contract",
    upserts: [
      {
        id: "native-id",
        title: "native title",
        text: "native body",
        vector: [1, 0],
        attributes: {
          id: "attribute-id",
          revision: 99,
          title: "attribute-title",
          text: "attribute-text",
          vector: "attribute-vector",
          nullable: null,
        },
      },
    ],
    deletes: [],
  });
  const encode = Schema.encodeSync(Schema.fromJsonString(Write));
  const fingerprintInput = encode(input);
  const document = input.upserts[0];
  if (document === undefined) throw new Error("Missing native fixture");
  const canonical = nativeToCanonicalDocument(document, 7);
  expect(readCanonicalColumn(canonical, { source: "native", role: "title" })).toBe("native title");
  expect(readCanonicalColumn(canonical, { source: "attribute", name: "title" })).toBe(
    "attribute-title",
  );
  expect(readCanonicalColumn(canonical, { source: "native", role: "vector" })).toEqual([1, 0]);
  expect(readCanonicalColumn(canonical, { source: "attribute", name: "vector" })).toBe(
    "attribute-vector",
  );
  expect(readCanonicalColumn(canonical, { source: "attribute", name: "nullable" })).toBeNull();
  expect(readCanonicalColumn(canonical, { source: "attribute", name: "absent" })).toBeUndefined();
  expect(canonical.id).toBe("native-id");
  expect(canonical.revision).toBe(7);
  expect(canonical.attributes).toBe(document.attributes);
  expect(canonical.vector).toBe(document.vector);
  expect(canonicalToNativeDocument(canonical)).toEqual({ ...document, revision: 7 });
  expect(encode(input)).toBe(fingerprintInput);
  const query = Schema.decodeSync(CanonicalQueryDocument)({
    ...Struct.omit(canonical, ["vector"]),
    vectorSummary: [2, true, true],
  });
  expect(canonicalToQueryRow(query, 0.75)).toEqual({
    ...Struct.omit(document, ["vector"]),
    title: document.title ?? "",
    revision: 7,
    score: 0.75,
  });
});

test("canonical defaults do not change omitted native title and vector fields", () => {
  const document = { id: "no-vector", text: "body", attributes: {} };
  const canonical = nativeToCanonicalDocument(document, 1);
  expect(canonical.roles).toEqual({ title: "", text: "body" });
  expect(Object.hasOwn(canonical, "vector")).toBe(false);
  expect(Object.hasOwn(document, "title")).toBe(false);
});

test("canonical metadata rejects vector payloads and unsupported role declarations", () => {
  const decode = Schema.decodeSync(Schema.fromJsonString(CanonicalDocument), {
    onExcessProperty: "error",
  });
  for (const value of [
    {
      id: "one",
      revision: 1,
      roles: { title: "", text: "body", other: "unsupported" },
      attributes: {},
    },
    { id: "one", revision: 1, roles: { title: "" }, attributes: {} },
    { id: "one", revision: 1, roles: { title: "", text: "body" }, attributes: {}, ann: true },
  ])
    expect(() => decode(JSON.stringify(value))).toThrow();
  const metadata = Schema.decodeSync(Schema.fromJsonString(CanonicalDocumentMetadata), {
    onExcessProperty: "error",
  });
  expect(() =>
    metadata(
      JSON.stringify({
        id: "one",
        revision: 1,
        roles: { title: "", text: "body" },
        attributes: {},
        vector: [1, 0],
      }),
    ),
  ).toThrow();
});
