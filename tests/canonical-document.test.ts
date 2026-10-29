import { expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import {
  CanonicalDocument,
  CanonicalDocumentMetadata,
  CanonicalQueryDocument,
  CanonicalId,
  Write,
  canonicalToNativeDocument,
  canonicalToQueryRow,
  nativeToCanonicalDocument,
  readCanonicalColumn,
} from "../src/protocol";

test("canonical IDs preserve string, uint64 and UUID identities across ordinary JSON", () => {
  const ids: ReadonlyArray<typeof CanonicalId.Type> = [
    "1",
    { kind: "uint", value: "1" },
    { kind: "uint", value: "18446744073709551615" },
    "00000000-0000-0000-0000-000000000001",
    { kind: "uuid", value: "00000000-0000-0000-0000-000000000001" },
  ];
  const encode = Schema.encodeSync(Schema.fromJsonString(CanonicalId));
  const decode = Schema.decodeSync(Schema.fromJsonString(CanonicalId), {
    onExcessProperty: "error",
  });
  expect(ids.map((id) => decode(encode(id)))).toEqual(ids);
  expect(new Set(ids.map((id) => encode(id))).size).toBe(ids.length);
});

test("canonical ID tags reject lossy numbers, overflows and noncanonical representations", () => {
  const invalid: ReadonlyArray<unknown> = [
    1,
    { kind: "uint", value: 1 },
    { kind: "uint", value: "18446744073709551616" },
    { kind: "uint", value: "01" },
    { kind: "uint", value: "-1" },
    { kind: "uint", value: "+1" },
    { kind: "uint", value: "1.0" },
    { kind: "uint", value: "1e3" },
    { kind: "uint", value: "" },
    { kind: "uint", value: "1\n" },
    { kind: "uuid", value: "00000000000000000000000000000001" },
    { kind: "uuid", value: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" },
    { kind: "uuid", value: "00000000-0000-0000-0000-00000000000g" },
    { kind: "uuid", value: "00000000-0000-0000-0000-000000000001\n" },
  ];
  for (const id of invalid) expect(Schema.decodeUnknownExit(CanonicalId)(id)._tag).toBe("Failure");
});

test("native document and row projections reject typed IDs instead of aliasing them into strings", () => {
  const document = Schema.decodeSync(CanonicalDocument)({
    id: { kind: "uint", value: "18446744073709551615" },
    revision: 1,
    roles: { title: "", text: "typed" },
    attributes: {},
  });
  expect(() => canonicalToNativeDocument(document)).toThrow("requires a string ID");
  expect(() => canonicalToQueryRow({ ...document, vectorSummary: null }, 1)).toThrow(
    "requires a string ID",
  );
});

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
    { id: "one", revision: 1, roles: { text: "body" }, attributes: {} },
    { id: "one", roles: { title: "", text: "body" }, attributes: {} },
    { revision: 1, roles: { title: "", text: "body" }, attributes: {} },
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
