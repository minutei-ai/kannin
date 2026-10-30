import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { namespaceColumnsFromTyped, sameNamespaceColumns } from "../src/protocol";
import { decodePublicAttributes, encodePublicAttributes } from "../src/public-cell";
import { decodePublicJson, encodePublicJson } from "../src/public-json";
import { decodePublicSchema, encodePublicSchema } from "../src/public-schema";

const decode = (input: unknown) => Effect.runSync(decodePublicSchema(input));
const rejected = <A, E>(effect: Effect.Effect<A, E>) => Exit.isFailure(Effect.runSyncExit(effect));

function failureOf<A, E>(effect: Effect.Effect<A, E>) {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("Expected a declared public schema failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("Public schema lost its declared failure");
  return failure.value;
}

const attributes = (count: number, declaration: unknown) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`a${index}`, declaration]));

test("public attributes default to nullable filterable canonical columns without vector dimensions", () => {
  const declaration = decode({
    score: { type: "float" },
    count: { type: "int", filterable: true },
    note: { type: "string", filterable: false },
    flag: { type: "bool" },
    owner: { type: "uuid" },
    total: { type: "uint" },
  });
  expect(declaration).toEqual({
    columns: [
      { name: "count", type: "i64", filterable: true, nullable: true },
      { name: "flag", type: "bool", filterable: true, nullable: true },
      { name: "note", type: "string", filterable: false, nullable: true },
      { name: "owner", type: "uuid", filterable: true, nullable: true },
      { name: "score", type: "f64", filterable: true, nullable: true },
      { name: "total", type: "u64", filterable: true, nullable: true },
    ],
  });
  expect(Object.hasOwn(declaration, "vectorDimensions")).toBe(false);
  expect(decode({})).toEqual({ columns: [] });
});

test("public array spellings map to canonical arrays and internal spellings are rejected", () => {
  const cases = [
    ["[]string", "[string]"],
    ["[]int", "[i64]"],
    ["[]uint", "[u64]"],
    ["[]float", "[f64]"],
    ["[]bool", "[bool]"],
    ["[]uuid", "[uuid]"],
  ] as const;
  for (const [spelling, canonical] of cases)
    expect(decode({ values: { type: spelling } }).columns).toEqual([
      { name: "values", type: canonical, filterable: true, nullable: true },
    ]);
  for (const internal of [
    "i64",
    "u64",
    "f64",
    "[string]",
    "[i64]",
    "[u64]",
    "[f64]",
    "[bool]",
    "[uuid]",
    "[int]",
    "[uint]",
    "[float]",
    "datetime_ms",
    "[datetime_ms]",
    "[]bytes",
    "[]",
    "STRING",
    "",
  ])
    expect(rejected(decodePublicSchema({ values: { type: internal } }))).toBe(true);
});

test("bytes attributes are never filterable", () => {
  const expected = [{ name: "payload", type: "bytes", filterable: false, nullable: true }];
  expect(decode({ payload: { type: "bytes" } }).columns).toEqual(expected);
  expect(decode({ payload: { type: "bytes", filterable: false } }).columns).toEqual(expected);
  expect(
    failureOf(decodePublicSchema({ payload: { type: "bytes", filterable: true } })),
  ).toMatchObject({ _tag: "PublicSchemaRejection", field: "payload", reason: "bytes-filterable" });
});

test("title and text stay ordinary named attributes", () => {
  const declaration = decode({ text: { type: "string" }, title: { type: "string" } });
  expect(declaration.columns).toEqual([
    { name: "text", type: "string", filterable: true, nullable: true },
    { name: "title", type: "string", filterable: true, nullable: true },
  ]);
});

test("attribute ordering is canonical regardless of input order", () => {
  const forward = decode({ a: { type: "int" }, b: { type: "int" }, c: { type: "int" } });
  const reverse = decode({ c: { type: "int" }, b: { type: "int" }, a: { type: "int" } });
  expect(reverse).toEqual(forward);
  expect(forward.columns.map((column) => column.name)).toEqual(["a", "b", "c"]);
  const astral = "\u{10000}";
  const bmp = "￿";
  const mixed = decode({ [astral]: { type: "int" }, [bmp]: { type: "int" }, z: { type: "int" } });
  expect(mixed.columns.map((column) => column.name)).toEqual(["z", bmp, astral]);
  expect(
    sameNamespaceColumns(
      namespaceColumnsFromTyped(forward),
      namespaceColumnsFromTyped({
        columns: [
          { name: "c", type: "i64", filterable: true, nullable: true },
          { name: "a", type: "i64", filterable: true, nullable: true },
          { name: "b", type: "i64", filterable: true, nullable: true },
        ],
      }),
    ),
  ).toBe(true);
});

test("reserved id, vector types and unsupported engine options are rejected explicitly", () => {
  expect(failureOf(decodePublicSchema({ id: { type: "uint" } }))).toMatchObject({
    _tag: "PublicSchemaRejection",
    field: "id",
    reason: "reserved-id",
  });
  for (const type of ["[1536]f32", "[3]f16", "[10752]f32", "[3]i8", "[][4]f32", "{}f16"])
    expect(failureOf(decodePublicSchema({ vector: { type } }))).toMatchObject({
      _tag: "PublicSchemaRejection",
      field: "vector",
      reason: "unsupported-vector",
    });
  for (const option of ["full_text_search", "ann", "embed", "regex", "glob", "fuzzy", "sparse_knn"])
    expect(
      failureOf(decodePublicSchema({ body: { type: "string", [option]: true } })),
    ).toMatchObject({
      _tag: "PublicSchemaRejection",
      field: "body",
      reason: "unsupported-option",
    });
  expect(
    failureOf(
      decodePublicSchema({ body: { type: "string", full_text_search: { stemming: true } } }),
    ),
  ).toMatchObject({ reason: "unsupported-option" });
});

test("datetime declarations reject as unsupported without timezone assumptions", () => {
  for (const type of ["datetime", "[]datetime"])
    expect(failureOf(decodePublicSchema({ when: { type } }))).toMatchObject({
      _tag: "PublicSchemaRejection",
      field: "when",
      reason: "unsupported-datetime",
    });
});

test("missing, unknown and malformed declarations reject without inference", () => {
  for (const declared of [
    {},
    { filterable: true },
    { type: "unknown" },
    { type: null },
    { type: 1 },
    { type: "string", ignored: true },
    { type: "string", filterable: "yes" },
    { type: "string", filterable: null },
    "string",
    null,
    [],
    ["string"],
    true,
    1,
  ])
    expect(rejected(decodePublicSchema({ field: declared }))).toBe(true);
  for (const input of [null, [], "string", 1, true, undefined, [{ name: { type: "string" } }]])
    expect(rejected(decodePublicSchema(input))).toBe(true);
});

test("current column and filterable bounds are enforced without silent increases", () => {
  expect(decode(attributes(1024, { type: "int", filterable: false })).columns).toHaveLength(1024);
  expect(rejected(decodePublicSchema(attributes(1025, { type: "int", filterable: false })))).toBe(
    true,
  );
  expect(decode(attributes(64, { type: "int" })).columns).toHaveLength(64);
  expect(rejected(decodePublicSchema(attributes(65, { type: "int" })))).toBe(true);
  expect(
    decode({ ...attributes(64, { type: "int" }), extra: { type: "int", filterable: false } })
      .columns,
  ).toHaveLength(65);
});

test("attribute names follow the current field name policy", () => {
  for (const name of ["", "$reserved", "a".repeat(129), "é".repeat(65)])
    expect(rejected(decodePublicSchema({ [name]: { type: "int" } }))).toBe(true);
  expect(decode({ [`a${"b".repeat(127)}`]: { type: "int" } }).columns).toHaveLength(1);
});

test("prototype-related attribute names remain ordinary own properties", () => {
  const schema: unknown = JSON.parse(
    '{"__proto__":{"type":"string"},"constructor":{"type":"string"},"prototype":{"type":"bool"}}',
  );
  const declaration = decode(schema);
  expect(declaration.columns.map((column) => column.name)).toEqual([
    "__proto__",
    "constructor",
    "prototype",
  ]);
  const text = '{"__proto__":"value","constructor":"owned","prototype":true}';
  const cells = Effect.runSync(
    decodePublicJson(text).pipe(
      Effect.flatMap((wire) => decodePublicAttributes(declaration, wire)),
    ),
  );
  expect(Object.hasOwn(cells, "__proto__")).toBe(true);
  expect(cells["__proto__"]).toBe("value");
  expect(Object.getPrototypeOf(cells)).toBe(Object.prototype);
  expect(
    Effect.runSync(
      encodePublicAttributes(declaration, cells).pipe(Effect.flatMap(encodePublicJson)),
    ),
  ).toBe(text);
  expect(Effect.runSync(encodePublicSchema(declaration))).toEqual(schema);
});

test("a parsed object has already lost duplicate keys so the last declaration wins", () => {
  const parsed: unknown = JSON.parse('{"a":{"type":"int"},"a":{"type":"string"}}');
  expect(decode(parsed).columns).toEqual([
    { name: "a", type: "string", filterable: true, nullable: true },
  ]);
});

test("exact public cells decode and encode through a public schema declaration", () => {
  const declaration = decode({
    big: { type: "uint" },
    ids: { type: "[]uuid" },
    note: { type: "string" },
    payload: { type: "bytes" },
    ratio: { type: "float" },
    signed: { type: "int" },
    unset: { type: "bool" },
  });
  const text =
    '{"big":18446744073709551615,"ids":["00000000-0000-4000-8000-000000000000"],"note":null,"payload":"AP8=","ratio":-0,"signed":-9223372036854775808}';
  const cells = Effect.runSync(
    decodePublicJson(text).pipe(
      Effect.flatMap((wire) => decodePublicAttributes(declaration, wire)),
    ),
  );
  expect(cells).toEqual({
    big: { u64: "18446744073709551615" },
    ids: [{ uuid: "00000000-0000-4000-8000-000000000000" }],
    note: null,
    payload: { bytes: "AP8=" },
    ratio: { f64: "8000000000000000" },
    signed: { i64: "-9223372036854775808" },
  });
  expect(Object.hasOwn(cells, "unset")).toBe(false);
  expect(
    Effect.runSync(
      encodePublicAttributes(declaration, cells).pipe(Effect.flatMap(encodePublicJson)),
    ),
  ).toBe(text);
  expect(rejected(decodePublicAttributes(declaration, { big: { u64: "1" } }))).toBe(true);
  expect(rejected(decodePublicAttributes(declaration, { extra: "value" }))).toBe(true);
});

test("supported public declarations roundtrip through the schema projection", () => {
  const input = {
    big: { type: "uint", filterable: false },
    flags: { type: "[]bool", filterable: true },
    note: { type: "string", filterable: true },
    payload: { type: "bytes", filterable: false },
    ratio: { type: "float", filterable: true },
    signed: { type: "int", filterable: false },
    tags: { type: "[]string", filterable: true },
  };
  const declaration = decode(input);
  expect(Effect.runSync(encodePublicSchema(declaration))).toEqual(input);
  expect(decode(Effect.runSync(encodePublicSchema(declaration)))).toEqual(declaration);
  expect(Effect.runSync(encodePublicSchema({ columns: [] }))).toEqual({});
  expect(
    Effect.runSync(
      encodePublicSchema({
        columns: [{ name: "count", type: "i64", nullable: true }],
      }),
    ),
  ).toEqual({ count: { type: "int", filterable: false } });
});

test("schema projection rejects declarations without exact public semantics", () => {
  expect(
    failureOf(encodePublicSchema({ columns: [{ name: "count", type: "i64" }] })),
  ).toMatchObject({ _tag: "PublicSchemaRejection", field: "count", reason: "non-nullable" });
  expect(
    failureOf(encodePublicSchema({ columns: [{ name: "count", type: "i64", nullable: false }] })),
  ).toMatchObject({ reason: "non-nullable" });
  for (const type of ["datetime_ms", "[datetime_ms]"])
    expect(
      failureOf(encodePublicSchema({ columns: [{ name: "when", type, nullable: true }] })),
    ).toMatchObject({ field: "when", reason: "unsupported-datetime" });
  expect(
    failureOf(encodePublicSchema({ columns: [{ name: "id", type: "string", nullable: true }] })),
  ).toMatchObject({ field: "id", reason: "reserved-id" });
  expect(failureOf(encodePublicSchema({ vectorDimensions: 8, columns: [] }))).toMatchObject({
    _tag: "PublicSchemaRejection",
    reason: "vector-dimensions",
  });
  for (const invalid of [
    null,
    { columns: [{ name: "count", type: "int", nullable: true }] },
    { columns: [{ name: "count", type: "i64", nullable: true, ignored: true }] },
    { columns: [{ name: "payload", type: "bytes", filterable: true, nullable: true }] },
  ])
    expect(rejected(encodePublicSchema(invalid))).toBe(true);
});
