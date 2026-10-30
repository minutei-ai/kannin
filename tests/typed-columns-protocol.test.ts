import { expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import { decodeRoot, decodeRootForMigration, encodeRoot } from "../src/manifest";
import {
  Filter,
  Log,
  Metadata,
  NamespaceColumns,
  Root,
  StoredRoot,
  TypedDeclaration,
  TypedWrite,
  WriteCommand,
  hasTypedOperand,
  isTypedNamespace,
  namespaceColumnsFromNative,
  namespaceColumnsFromTyped,
  nativeSchemaFromColumns,
  normalizeTypedWrite,
  sameNamespaceColumns,
  typedColumns,
  validateTypedAttributes,
  validateTypedFilter,
  filterableNames,
} from "../src/protocol";

const declaration = Schema.decodeSync(TypedDeclaration)({
  vectorDimensions: 4,
  columns: [
    { name: "tags", type: "[string]", filterable: true },
    { name: "payload", type: "bytes", nullable: true },
    { name: "count", type: "u64", filterable: true },
    { name: "score", type: "f64", nullable: true },
  ],
});
const columns = namespaceColumnsFromTyped(declaration);
const typed = typedColumns(columns) ?? [];
const base = {
  version: 1,
  sequence: 0,
  head: null,
  documents: 0,
  titleLength: 0,
  bodyLength: 0,
  vectorEpoch: "epoch",
  vectorJobs: [],
  lastReceipt: null,
  bloomPacks: [],
  segments: [],
} as const;
const typedRoot = Schema.decodeSync(Root)({ ...base, schema: columns });
const nativeRoot = Schema.decodeSync(Root)({
  ...base,
  schema: namespaceColumnsFromNative({ filterable: ["year"], vectorFilterFields: ["year"] }),
});
const write = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeSync(TypedWrite)({
    kind: "typed",
    requestId: "request",
    idType: "string",
    declaration,
    upserts: [
      {
        id: "a",
        roles: { title: "", text: "rust" },
        attributes: { count: { u64: "18446744073709551615" }, tags: ["x"] },
      },
    ],
    deletes: [],
    ...overrides,
  });

const valid = (attributes: Record<string, unknown>) => validateTypedAttributes(typed, attributes);

const check = (filter: { field: string; op: string; value: unknown }) =>
  validateTypedFilter(typed, filter);

test("typed column limits exclude the vector and namespace marker from the attribute count", () => {
  for (const count of [1023, 1024]) {
    const declared = Schema.decodeSync(TypedDeclaration)({
      columns: Array.from({ length: count }, (_, index) => ({
        name: `column${index}`,
        type: "u64" as const,
      })),
    });
    const schema = Schema.decodeSync(NamespaceColumns)(namespaceColumnsFromTyped(declared));
    expect(schema.columns).toHaveLength(count + 2);
    const root = Schema.decodeSync(Root)({ ...base, schema });
    expect(decodeRoot(encodeRoot(root)).schema?.columns).toHaveLength(count + 2);
  }
  expect(() =>
    Schema.decodeSync(TypedDeclaration)({
      columns: Array.from({ length: 1025 }, (_, index) => ({
        name: `column${index}`,
        type: "u64" as const,
      })),
    }),
  ).toThrow();
});

test("typed declarations normalize order once, make every flag explicit and compare in full", () => {
  expect(columns.columns.map((column) => column.source)).toEqual([
    "native-vector",
    "typed-namespace",
    "attribute",
    "attribute",
    "attribute",
    "attribute",
  ]);
  expect(typed.map((column) => column.name)).toEqual(["count", "payload", "score", "tags"]);
  expect(typed.find((column) => column.name === "payload")).toEqual({
    source: "attribute",
    name: "payload",
    value: "typed",
    type: "bytes",
    filterable: false,
    nullable: true,
  });
  const reordered = namespaceColumnsFromTyped({
    ...declaration,
    columns: declaration.columns.toReversed(),
  });
  expect(sameNamespaceColumns(columns, reordered)).toBe(true);
  expect(
    sameNamespaceColumns(
      columns,
      namespaceColumnsFromTyped({
        ...declaration,
        columns: declaration.columns.map((column) =>
          Object.assign({}, column, column.name === "score" && { nullable: false }),
        ),
      }),
    ),
  ).toBe(false);
  expect(
    sameNamespaceColumns(
      columns,
      namespaceColumnsFromTyped({ columns: declaration.columns, vectorDimensions: 5 }),
    ),
  ).toBe(false);
  expect(isTypedNamespace(columns)).toBe(true);
  expect(isTypedNamespace(nativeRoot.schema)).toBe(false);
  expect(filterableNames(columns)).toEqual(["count", "tags"]);
  expect(() => nativeSchemaFromColumns(columns)).toThrow("Typed columns");
});

test("FTS-free typed requests retain fixed receipt digest bytes", () => {
  const encode = Schema.encodeSync(Schema.fromJsonString(TypedWrite));
  const expected =
    '{"kind":"typed","requestId":"request","idType":"string","declaration":{"vectorDimensions":4,"columns":[{"name":"count","type":"u64","filterable":true,"nullable":false},{"name":"payload","type":"bytes","filterable":false,"nullable":true},{"name":"score","type":"f64","filterable":false,"nullable":true},{"name":"tags","type":"[string]","filterable":true,"nullable":false}]},"upserts":[{"id":"a","roles":{"title":"","text":"rust"},"attributes":{"count":{"u64":"18446744073709551615"},"tags":["x"]}}],"deletes":[]}';
  const withoutDeclaration =
    '{"kind":"typed","requestId":"request","idType":"string","upserts":[{"id":"a","roles":{"title":"","text":"rust"},"attributes":{"count":{"u64":"18446744073709551615"},"tags":["x"]}}],"deletes":[]}';
  expect(encode(normalizeTypedWrite(write()))).toBe(expected);
  expect(encode(normalizeTypedWrite(Struct.omit(write(), ["declaration"])))).toBe(
    withoutDeclaration,
  );
});

test("reordered declarations yield one request digest input", () => {
  const encode = Schema.encodeSync(Schema.fromJsonString(TypedWrite));
  const forward = encode(normalizeTypedWrite(write()));
  const reversed = encode(
    normalizeTypedWrite(
      write({ declaration: { ...declaration, columns: declaration.columns.toReversed() } }),
    ),
  );
  expect(reversed).toBe(forward);
  expect(forward).toContain('"nullable":false');
});

test("typed request digests ignore attribute key order with and without declarations", () => {
  const encode = Schema.encodeSync(Schema.fromJsonString(TypedWrite));
  const request = write();
  const reordered = {
    ...request,
    upserts: request.upserts.map((document) => ({
      ...document,
      attributes: Object.fromEntries(Object.entries(document.attributes).toReversed()),
    })),
  };
  for (const input of [request, reordered]) {
    expect(encode(normalizeTypedWrite(input))).toBe(encode(normalizeTypedWrite(request)));
    expect(encode(normalizeTypedWrite(Struct.omit(input, ["declaration"])))).toBe(
      encode(normalizeTypedWrite(Struct.omit(request, ["declaration"]))),
    );
  }
});

test("declarations reject duplicates, filterable bytes, byte arrays, unknown types and flags", () => {
  const decode = Schema.decodeUnknownSync(TypedDeclaration, { onExcessProperty: "error" });
  for (const invalid of [
    {
      columns: [
        { name: "a", type: "u64" },
        { name: "a", type: "i64" },
      ],
    },
    { columns: [{ name: "a", type: "bytes", filterable: true }] },
    { columns: [{ name: "a", type: "[bytes]" }] },
    { columns: [{ name: "a", type: "decimal" }] },
    { columns: [{ name: "a", type: "u64", fullText: true }] },
    { columns: [{ name: "a", type: "u64", vector: true }] },
    { columns: [{ name: "a", type: "u64", drop: true }] },
    { columns: [{ name: "a", type: "u64" }], inference: true },
  ])
    expect(() => decode(invalid)).toThrow();
  expect(() =>
    decode({
      columns: Array.from({ length: 65 }, (_, index) => ({
        name: `c${index}`,
        type: "u64",
        filterable: true,
      })),
    }),
  ).toThrow();
});

test("typed attributes are validated against exact declared types without coercion", () => {
  expect(
    valid({ count: { u64: "18446744073709551615" }, tags: ["a"], score: null }),
  ).toBeUndefined();
  expect(valid({ tags: [], payload: { bytes: "AAEC" } })).toBeUndefined();
  expect(valid({})).toBeUndefined();
  expect(valid({ count: { i64: "1" } })).toContain("count");
  expect(valid({ count: null })).toContain("count");
  expect(valid({ count: 1 })).toContain("count");
  expect(valid({ tags: [{ u64: "1" }] })).toContain("tags");
  expect(valid({ tags: "a" })).toContain("tags");
  expect(valid({ payload: "AAEC" })).toContain("payload");
  expect(valid({ undeclared: "a" })).toContain("Undeclared");
});

test("typed cells reject malformed exact tags and keep large numbers as text", () => {
  const decode = Schema.decodeUnknownSync(TypedWrite, { onExcessProperty: "error" });
  const attributes = (value: unknown) =>
    decode({
      ...write(),
      upserts: [{ id: "a", roles: { title: "", text: "" }, attributes: { count: value } }],
    });
  expect(attributes({ u64: "18446744073709551615" }).upserts[0]?.attributes.count).toEqual({
    u64: "18446744073709551615",
  });
  for (const invalid of [
    1,
    { u64: "18446744073709551616" },
    { u64: "01" },
    { f64: "7ff0000000000000" },
    { u64: "1", extra: 1 },
  ])
    expect(() => attributes(invalid)).toThrow();
});

test("typed filters validate declarations, operators and operand kinds before query", () => {
  expect(check({ field: "count", op: "eq", value: { u64: "1" } })).toBeUndefined();
  expect(check({ field: "count", op: "gte", value: { u64: "1" } })).toBeUndefined();
  expect(check({ field: "count", op: "in", value: [{ u64: "1" }, { u64: "2" }] })).toBeUndefined();
  expect(check({ field: "tags", op: "contains", value: "x" })).toBeUndefined();
  expect(check({ field: "tags", op: "containsAny", value: ["x", "y"] })).toBeUndefined();
  expect(check({ field: "count", op: "exists", value: false })).toBeUndefined();
  expect(check({ field: "missing", op: "eq", value: "x" })).toContain("not filterable");
  expect(check({ field: "payload", op: "exists", value: true })).toContain("not filterable");
  expect(check({ field: "score", op: "eq", value: { f64: "3ff0000000000000" } })).toContain(
    "not filterable",
  );
  expect(check({ field: "count", op: "eq", value: 1 })).toContain("incompatible");
  expect(check({ field: "count", op: "eq", value: { i64: "1" } })).toContain("incompatible");
  expect(check({ field: "count", op: "contains", value: { u64: "1" } })).toContain("incompatible");
  expect(check({ field: "tags", op: "gt", value: "x" })).toContain("incompatible");
  expect(check({ field: "tags", op: "contains", value: { u64: "1" } })).toContain("incompatible");
});

test("filter operands carry typed tags without bare-number coercion and legacy detection is exact", () => {
  const decode = Schema.decodeUnknownSync(Filter);
  expect(decode({ field: "count", op: "eq", value: { u64: "1" } })).toEqual({
    field: "count",
    op: "eq",
    value: { u64: "1" },
  });
  expect(decode({ field: "count", op: "in", value: [{ i64: "-1" }] }).value).toEqual([
    { i64: "-1" },
  ]);
  expect(() => decode({ field: "count", op: "eq", value: { u64: 1 } })).toThrow();
  expect(hasTypedOperand({ u64: "1" })).toBe(true);
  expect(hasTypedOperand([{ u64: "1" }])).toBe(true);
  for (const legacy of ["x", 1, true, null, ["x", 1]]) expect(hasTypedOperand(legacy)).toBe(false);
});

test("typed and legacy declarations cannot mix and typed columns stay sorted", () => {
  const decode = Schema.decodeUnknownSync(NamespaceColumns, { onExcessProperty: "error" });
  const [vector, marker, ...attributes] = columns.columns;
  const legacy = { source: "attribute", name: "aaa", value: "legacy-untyped" };
  expect(() => decode({ columns: [vector, marker, legacy, ...attributes] })).toThrow();
  expect(() => decode({ columns: [vector, marker, ...attributes.toReversed()] })).toThrow();
  expect(() => decode({ columns: [vector, ...attributes] })).toThrow();
  expect(() => decode({ columns: [vector, marker, marker, ...attributes] })).toThrow();
  expect(() => decode({ columns: [vector, ...attributes, marker] })).toThrow();
  expect(() =>
    decode({
      columns: [
        vector,
        {
          source: "attribute",
          name: "a",
          value: "typed",
          type: "bytes",
          filterable: true,
          nullable: false,
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    decode({
      columns: [
        vector,
        marker,
        ...attributes.map((column) => Object.assign({}, column, { fullText: true })),
      ],
    }),
  ).toThrow();
  expect(decode(columns)).toEqual(columns);
});

test("Log 3 carries typed mutations while Log 2 keeps the canonical envelope", () => {
  const fields = {
    sequence: 1,
    previous: null,
    digest: "digest",
    vectorEpoch: "epoch",
    vectorDeletes: [],
  };
  const encoded = Schema.encodeSync(Schema.fromJsonString(Log))({
    ...fields,
    version: 3,
    write: normalizeTypedWrite(write()),
  });
  const decoded = Schema.decodeSync(Schema.fromJsonString(Log))(encoded);
  expect(decoded.version).toBe(3);
  expect(decoded.write).toEqual(normalizeTypedWrite(write()));
  expect(() =>
    Schema.decodeSync(Schema.fromJsonString(Log))(encoded.replace('"version":3', '"version":2')),
  ).toThrow();
  const canonical = {
    ...fields,
    version: 2,
    write: {
      kind: "canonical",
      requestId: "request",
      idType: "string",
      upserts: [{ id: "a", roles: { title: "", text: "rust" }, attributes: { year: 2024 } }],
      deletes: [],
    },
  };
  const decodeLog = Schema.decodeSync(Schema.fromJsonString(Log), {
    onExcessProperty: "error",
  });
  const canonicalLog = decodeLog(JSON.stringify(canonical));
  expect(canonicalLog.version).toBe(2);
  const canonicalWire = Schema.encodeSync(Schema.fromJsonString(Log))(canonicalLog);
  expect(canonicalWire).toContain('"kind":"canonical"');
  expect(decodeLog(canonicalWire)).toEqual(canonicalLog);
  expect(() =>
    Schema.decodeUnknownSync(WriteCommand, { onExcessProperty: "error" })({
      ...write(),
      kind: "canonical",
    }),
  ).toThrow();
});

test("Root 8 declares typed columns and Root 7 migrates by envelope only", () => {
  const wire = encodeRoot(typedRoot);
  expect(wire).toContain('"version":8');
  expect(decodeRoot(wire)).toEqual(typedRoot);
  expect(decodeRoot(wire).schema).toEqual(columns);
  const stored = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(wire);
  for (const version of [6, 7]) {
    const oldReader = JSON.stringify({ ...Struct.omit(stored, ["idType"]), version });
    expect(() => decodeRoot(oldReader)).toThrow();
    expect(() => decodeRootForMigration(oldReader)).toThrow();
  }

  const native = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(encodeRoot(nativeRoot));
  const root7 = JSON.stringify({ ...native, version: 7 });
  expect(() => decodeRoot(root7)).toThrow();
  const migrated = decodeRootForMigration(root7);
  expect(migrated).toEqual({ kind: "schema", sourceVersion: 7, root: nativeRoot });
  if (migrated.kind !== "schema") throw new Error("Root 7 must use envelope-only migration");
  expect(encodeRoot(migrated.root)).toBe(encodeRoot(nativeRoot));
  expect(decodeRootForMigration(encodeRoot(nativeRoot))).toEqual({
    kind: "current",
    root: nativeRoot,
  });
  expect(() => decodeRoot(JSON.stringify({ ...native, version: 8, extra: true }))).toThrow();
});

test("metadata exposes canonical typed declarations without pretending to have no schema", () => {
  const cache = Object.fromEntries(
    Object.keys(Metadata.fields.cache.fields).map((name) => [name, 0]),
  );
  const common = {
    sequence: 1,
    documents: 1,
    segments: 1,
    manifestEncodedBytes: 1,
    wasmMemoryBytes: 1,
    vectorOutbox: 0,
    cache,
  };
  const metadata = Schema.decodeUnknownSync(Metadata)({ ...common, schema: null, columns });
  expect(metadata.columns).toEqual(columns);
  expect(Schema.decodeUnknownSync(Metadata)({ ...common, schema: null }).columns).toBeUndefined();
});

test("an empty typed declaration keeps typed mode through an explicit persisted discriminant", () => {
  const empty = namespaceColumnsFromTyped(Schema.decodeSync(TypedDeclaration)({ columns: [] }));
  expect(empty.columns).toEqual([{ source: "native-vector" }, { source: "typed-namespace" }]);
  expect(isTypedNamespace(empty)).toBe(true);
  expect(typedColumns(empty)).toEqual([]);
  expect(isTypedNamespace({ columns: [{ source: "native-vector" }] })).toBe(false);
  expect(typedColumns(undefined)).toBeUndefined();
  expect(sameNamespaceColumns(empty, { columns: [{ source: "native-vector" }] })).toBe(false);
  expect(filterableNames(empty)).toEqual([]);
  const emptyRoot = Schema.decodeSync(Root)({ ...base, schema: empty });
  const wire = encodeRoot(emptyRoot);
  expect(decodeRoot(wire).schema).toEqual(empty);
  expect(isTypedNamespace(decodeRoot(wire).schema)).toBe(true);
  expect(decodeRootForMigration(wire)).toEqual({ kind: "current", root: emptyRoot });
  const stored = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(wire);
  for (const version of [6, 7])
    expect(() =>
      decodeRootForMigration(JSON.stringify({ ...Struct.omit(stored, ["idType"]), version })),
    ).toThrow();
  expect(() =>
    Schema.decodeSync(NamespaceColumns)({
      columns: [{ source: "native-vector" }, ...typed],
    }),
  ).toThrow();
});
