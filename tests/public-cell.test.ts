import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { Float64BitsText, TypedCell } from "../src/protocol";
import {
  decodePublicAttributes,
  decodePublicCell,
  encodePublicAttributes,
  encodePublicCell,
} from "../src/public-cell";
import { decodePublicJson, encodePublicJson } from "../src/public-json";

const strict = { nullable: false };
const permissive = { nullable: true };

const decodeText = (declared: unknown, text: string, options = strict) =>
  decodePublicJson(text).pipe(Effect.flatMap((wire) => decodePublicCell(declared, wire, options)));

const decode = (declared: unknown, text: string, options = strict) =>
  Effect.runSync(decodeText(declared, text, options));

const roundtrip = (declared: unknown, text: string, options = strict) =>
  Effect.runSync(
    decodeText(declared, text, options).pipe(
      Effect.flatMap((cell) => encodePublicCell(declared, cell, options)),
      Effect.flatMap(encodePublicJson),
    ),
  );

const rejected = <A, E>(effect: Effect.Effect<A, E>) => Exit.isFailure(Effect.runSyncExit(effect));

function failureOf<A, E>(effect: Effect.Effect<A, E>) {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("Expected a declared public cell failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("Public cell lost its declared failure");
  return failure.value;
}

const bitsView = new DataView(new ArrayBuffer(8));
const bitsOf = (value: number) => {
  bitsView.setFloat64(0, value);
  return bitsView.getBigUint64(0).toString(16).padStart(16, "0");
};

const repeated = (item: string, count: number) =>
  `[${Array.from({ length: count }, () => item).join(",")}]`;

test("attribute maps preserve exact cells, explicit null and absent columns", () => {
  const declaration = {
    columns: [
      { name: "count", type: "u64" },
      { name: "note", type: "string", nullable: true },
      { name: "missing", type: "bool", nullable: true },
      { name: "payload", type: "bytes" },
    ],
  };
  const text = '{"count":18446744073709551615,"note":null,"payload":"AP8="}';
  const attributes = Effect.runSync(
    decodePublicJson(text).pipe(
      Effect.flatMap((wire) => decodePublicAttributes(declaration, wire)),
    ),
  );
  expect(attributes).toEqual({
    count: { u64: "18446744073709551615" },
    note: null,
    payload: { bytes: "AP8=" },
  });
  expect(Object.hasOwn(attributes, "missing")).toBe(false);
  expect(
    Effect.runSync(
      encodePublicAttributes(declaration, attributes).pipe(Effect.flatMap(encodePublicJson)),
    ),
  ).toBe(text);
  expect(Effect.runSync(decodePublicAttributes(declaration, {}))).toEqual({});
  expect(Effect.runSync(encodePublicAttributes(declaration, {}))).toEqual({});
});

test("attribute maps reject undeclared fields and validate declarations and cells", () => {
  const declaration = { columns: [{ name: "count", type: "u64" }] };
  const undeclared = {
    _tag: "PublicAttributesRejection",
    field: "extra",
    reason: "undeclared-attribute",
  };
  expect(failureOf(decodePublicAttributes(declaration, { extra: "value" }))).toMatchObject(
    undeclared,
  );
  expect(failureOf(encodePublicAttributes(declaration, { extra: "value" }))).toMatchObject(
    undeclared,
  );
  for (const input of [null, [], true, "value", { count: null }, { count: "1" }]) {
    expect(rejected(decodePublicAttributes(declaration, input))).toBe(true);
    expect(rejected(encodePublicAttributes(declaration, input))).toBe(true);
  }
  for (const invalid of [
    { columns: [{ name: "count", type: "u64", ignored: true }] },
    { columns: [{ name: "count", type: "u64" }], ignored: true },
    {
      columns: [
        { name: "count", type: "u64" },
        { name: "count", type: "u64" },
      ],
    },
    { columns: [{ name: "$reserved", type: "string" }] },
  ]) {
    expect(rejected(decodePublicAttributes(invalid, {}))).toBe(true);
    expect(rejected(encodePublicAttributes(invalid, {}))).toBe(true);
  }
  expect(rejected(decodePublicAttributes(declaration, { count: { u64: "1" } }))).toBe(true);
  expect(rejected(encodePublicAttributes(declaration, { count: JSON.rawJSON("1") }))).toBe(true);
  expect(
    rejected(encodePublicAttributes(declaration, { count: { u64: "1", ignored: true } })),
  ).toBe(true);
});

test("signed and unsigned integers keep exact endpoints from raw numeric tokens", () => {
  for (const value of [
    "-9223372036854775808",
    "-9007199254740993",
    "-1",
    "0",
    "9007199254740993",
    "9223372036854775807",
  ]) {
    expect(decode("i64", value)).toEqual({ i64: value });
    expect(roundtrip("i64", value)).toBe(value);
  }
  for (const value of ["0", "9007199254740993", "9223372036854775808", "18446744073709551615"]) {
    expect(decode("u64", value)).toEqual({ u64: value });
    expect(roundtrip("u64", value)).toBe(value);
  }
  expect(decode("int", "9223372036854775807")).toEqual(decode("i64", "9223372036854775807"));
  expect(decode("uint", "18446744073709551615")).toEqual(decode("u64", "18446744073709551615"));
  expect(roundtrip("int", "-9223372036854775808")).toBe("-9223372036854775808");
  expect(roundtrip("uint", "18446744073709551615")).toBe("18446744073709551615");
});

test("integer decoding rejects overflow, non-integer lexemes and every non-numeric carrier", () => {
  for (const text of [
    "9223372036854775808",
    "-9223372036854775809",
    "18446744073709551616",
    "1.0",
    "1.5",
    "1e0",
    "1E3",
    "-0",
    '"1"',
    "true",
    "[]",
    '{"i64":"1"}',
    '{"u64":"1"}',
    '{"rawJSON":"1"}',
  ])
    expect(rejected(decodeText("i64", text))).toBe(true);
  for (const text of ["-1", "18446744073709551616", "1.0", "-0", '"1"', '{"u64":"1"}'])
    expect(rejected(decodeText("u64", text))).toBe(true);
  for (const wire of [
    1,
    Number("9007199254740993"),
    1n,
    -1,
    1.5,
    Number.NaN,
    undefined,
    { rawJSON: "1" },
  ]) {
    expect(rejected(decodePublicCell("i64", wire, permissive))).toBe(true);
    expect(rejected(decodePublicCell("u64", wire, permissive))).toBe(true);
    expect(rejected(decodePublicCell("f64", wire, permissive))).toBe(true);
  }
  for (const literal of ['"1"', "null", "true"])
    expect(rejected(decodePublicCell("i64", JSON.rawJSON(literal), permissive))).toBe(true);
});

test("floats map raw numeric tokens to IEEE bits and preserve signed zero and subnormals", () => {
  const cases = [
    ["0", "0000000000000000", "0"],
    ["-0", "8000000000000000", "-0"],
    ["-0.0", "8000000000000000", "-0"],
    ["0e0", "0000000000000000", "0"],
    ["5e-324", "0000000000000001", "5e-324"],
    ["-5e-324", "8000000000000001", "-5e-324"],
    ["2.2250738585072014e-308", "0010000000000000", "2.2250738585072014e-308"],
    ["1", "3ff0000000000000", "1"],
    ["0.1", "3fb999999999999a", "0.1"],
    ["1.7976931348623157e308", "7fefffffffffffff", "1.7976931348623157e+308"],
    ["-1.7976931348623157e308", "ffefffffffffffff", "-1.7976931348623157e+308"],
  ] as const;
  for (const [text, bits, canonical] of cases) {
    expect(decode("f64", text)).toEqual({ f64: bits });
    expect(roundtrip("f64", text)).toBe(canonical);
    expect(roundtrip("float", text)).toBe(canonical);
  }
  for (const text of ["123.456", "1E5", "2.5e-10", "9007199254740993"])
    expect(decode("f64", text)).toEqual({ f64: bitsOf(Number(text)) });
});

test("every sampled finite float bit pattern survives public encoding and decoding", () => {
  const patterns = Array.from(
    { length: 1024 },
    (_, index) => (BigInt(index) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn,
  )
    .map((bits) => bits.toString(16).padStart(16, "0"))
    .filter((bits) => Schema.is(Float64BitsText)(bits));
  expect(patterns.length).toBeGreaterThan(900);
  for (const bits of patterns) {
    const text = Effect.runSync(
      encodePublicCell("f64", { f64: bits }, strict).pipe(Effect.flatMap(encodePublicJson)),
    );
    expect(decode("f64", text)).toEqual({ f64: bits });
  }
});

test("float decoding and encoding reject non-finite values and non-numeric carriers", () => {
  for (const text of ["1e999", "-1e999", '"1.5"', "true", "{}", '{"f64":"0000000000000000"}'])
    expect(rejected(decodeText("f64", text))).toBe(true);
  expect(failureOf(decodeText("f64", "1e999"))).toMatchObject({
    _tag: "PublicCellRejection",
    reason: "non-finite-float",
    declared: "f64",
  });
  for (const bits of [
    "7ff0000000000000",
    "fff0000000000000",
    "7ff8000000000000",
    "ffffffffffffffff",
    "3FF0000000000000",
    "3ff000000000000",
    "0x3ff0000000000000",
  ])
    expect(rejected(encodePublicCell("f64", { f64: bits }, strict))).toBe(true);
});

test("strings and booleans decode only from their native JSON carriers", () => {
  for (const value of ["", "texto", "é😀", "18446744073709551615"]) {
    const text = JSON.stringify(value);
    expect(decode("string", text)).toBe(value);
    expect(roundtrip("string", text)).toBe(text);
  }
  expect(roundtrip("bool", "true")).toBe("true");
  expect(roundtrip("bool", "false")).toBe("false");
  for (const text of ['"\\ud800"', "1", "true", "null", '{"i64":"1"}', "[]"])
    expect(rejected(decodeText("string", text))).toBe(true);
  for (const text of ['"true"', "1", "0", "{}", "[true]"])
    expect(rejected(decodeText("bool", text))).toBe(true);
});

test("uuid and bytes validate through the canonical typed cell schemas", () => {
  const uuid = "00112233-4455-6677-8899-aabbccddeeff";
  expect(decode("uuid", JSON.stringify(uuid))).toEqual({ uuid });
  expect(roundtrip("uuid", JSON.stringify(uuid))).toBe(JSON.stringify(uuid));
  for (const text of [
    JSON.stringify(uuid.toUpperCase()),
    JSON.stringify(uuid.replaceAll("-", "")),
    JSON.stringify(`${uuid}\n`),
    "1",
    "null",
  ])
    expect(rejected(decodeText("uuid", text))).toBe(true);
  expect(decode("bytes", '"AP8="')).toEqual({ bytes: "AP8=" });
  expect(roundtrip("bytes", '"AP8="')).toBe('"AP8="');
  expect(roundtrip("bytes", '""')).toBe('""');
  for (const text of ['"AP8"', '"AP9="', '"AP8=\\n"', '"A-8="', "1", "[]"])
    expect(rejected(decodeText("bytes", text))).toBe(true);
  expect(rejected(decodePublicCell("bytes", "A".repeat(11_184_816), strict))).toBe(true);
  expect(decode("bytes", JSON.stringify("A".repeat(1024)))).toEqual({ bytes: "A".repeat(1024) });
});

test("null is accepted only when the caller permits it and missing is never null", () => {
  expect(failureOf(decodeText("string", "null"))).toMatchObject({
    _tag: "PublicCellRejection",
    reason: "null-not-allowed",
  });
  expect(failureOf(encodePublicCell("i64", null, strict))).toMatchObject({
    reason: "null-not-allowed",
  });
  for (const declared of ["string", "bool", "i64", "u64", "f64", "uuid", "bytes", "[i64]"]) {
    expect(decode(declared, "null", permissive)).toBeNull();
    expect(roundtrip(declared, "null", permissive)).toBe("null");
    expect(rejected(decodePublicCell(declared, undefined, permissive))).toBe(true);
    expect(rejected(decodePublicCell(declared, undefined, strict))).toBe(true);
    expect(rejected(encodePublicCell(declared, undefined, permissive))).toBe(true);
  }
});

test("homogeneous arrays preserve elements, order and exact numeric tokens", () => {
  const cases = [
    ["[string]", '["a","","b"]'],
    ["[bool]", "[true,false,true]"],
    ["[i64]", "[-9223372036854775808,0,9223372036854775807]"],
    ["[u64]", "[0,9007199254740993,18446744073709551615]"],
    ["[uuid]", '["00112233-4455-6677-8899-aabbccddeeff","ffffffff-ffff-ffff-ffff-ffffffffffff"]'],
    ["[]string", '["a","","b"]'],
    ["[]bool", "[true,false,true]"],
    ["[]int", "[-9223372036854775808,9223372036854775807]"],
    ["[]uint", "[18446744073709551615]"],
    ["[]uuid", '["00112233-4455-6677-8899-aabbccddeeff"]'],
  ] as const;
  for (const [declared, text] of cases) {
    expect(roundtrip(declared, text)).toBe(text);
    expect(roundtrip(declared, "[]")).toBe("[]");
    expect(Schema.is(TypedCell)(decode(declared, text))).toBe(true);
  }
  expect(decode("[i64]", "[1,2]")).toEqual([{ i64: "1" }, { i64: "2" }]);
  expect(decode("[f64]", "[-0,5e-324,1.5]")).toEqual([
    { f64: "8000000000000000" },
    { f64: "0000000000000001" },
    { f64: bitsOf(1.5) },
  ]);
  expect(roundtrip("[f64]", "[-0,5e-324,1.5]")).toBe("[-0,5e-324,1.5]");
  expect(roundtrip("[]float", "[0.1]")).toBe("[0.1]");
});

test("arrays reject mixed kinds, nesting, null elements, scalars and the 4096 element bound", () => {
  for (const [declared, text] of [
    ["[i64]", "[1,2.5]"],
    ["[i64]", '[1,"2"]'],
    ["[i64]", "[1,null]"],
    ["[i64]", "[[1]]"],
    ["[i64]", "1"],
    ["[i64]", '{"i64":"1"}'],
    ["[i64]", '[{"i64":"1"}]'],
    ["[u64]", "[-1]"],
    ["[f64]", "[1,1e999]"],
    ["[string]", '["a",1]'],
    ["[string]", '["a",null]'],
    ["[bool]", "[true,0]"],
    ["[uuid]", '["00112233-4455-6677-8899-AABBCCDDEEFF"]'],
    ["i64", "[1]"],
    ["string", '["a"]'],
  ] as const)
    expect(rejected(decodeText(declared, text, permissive))).toBe(true);
  expect(decode("[bool]", repeated("true", 4096))).toHaveLength(4096);
  expect(rejected(decodeText("[bool]", repeated("true", 4097)))).toBe(true);
  expect(rejected(decodeText("[i64]", repeated("1", 4097)))).toBe(true);
});

test("encoding validates the typed cell strictly against the declared type", () => {
  expect(Effect.runSync(encodePublicCell("bytes", { bytes: "AP8=" }, strict))).toBe("AP8=");
  expect(failureOf(encodePublicCell("i64", { u64: "1" }, strict))).toMatchObject({
    _tag: "PublicCellRejection",
    reason: "type-mismatch",
    declared: "i64",
  });
  for (const [declared, cell] of [
    ["string", true],
    ["bool", "true"],
    ["i64", "1"],
    ["u64", { i64: "1" }],
    ["f64", { i64: "1" }],
    ["uuid", { bytes: "AP8=" }],
    ["bytes", { uuid: "00112233-4455-6677-8899-aabbccddeeff" }],
    ["i64", [{ i64: "1" }]],
    ["[i64]", { i64: "1" }],
    ["[i64]", [{ u64: "1" }]],
    ["[string]", [true]],
  ] as const)
    expect(failureOf(encodePublicCell(declared, cell, strict))).toMatchObject({
      reason: "type-mismatch",
    });
  for (const cell of [
    { i64: "1", extra: true },
    { i64: "01" },
    { i64: 1 },
    { i64: "9223372036854775808" },
    { u64: "-1" },
    [{ i64: "1" }, { u64: "1" }],
    [{ bytes: "AP8=" }],
    [null],
    1,
    {},
    undefined,
  ])
    expect(rejected(encodePublicCell("i64", cell, permissive))).toBe(true);
  expect(
    Effect.runSync(encodePublicCell("[i64]", [{ i64: "1" }, { i64: "-2" }], strict)),
  ).toHaveLength(2);
  expect(
    Effect.runSync(
      encodePublicCell("[u64]", [{ u64: "18446744073709551615" }], strict).pipe(
        Effect.flatMap(encodePublicJson),
      ),
    ),
  ).toBe("[18446744073709551615]");
});

test("datetime declarations are rejected until exact temporal semantics are pinned", () => {
  for (const declared of ["datetime_ms", "[datetime_ms]", "datetime", "[]datetime"]) {
    for (const text of ['"2024-01-01T00:00:00Z"', '"2024-01-01T00:00:00"', "1700000000000", "[]"])
      expect(failureOf(decodeText(declared, text, permissive))).toMatchObject({
        _tag: "PublicCellRejection",
        reason: "unsupported-datetime",
      });
    expect(failureOf(decodePublicCell(declared, null, permissive))).toMatchObject({
      reason: "unsupported-datetime",
    });
    expect(failureOf(encodePublicCell(declared, { datetime_ms: "0" }, permissive))).toMatchObject({
      reason: "unsupported-datetime",
    });
  }
});

test("declared types are validated and bytes arrays are not a public cell type", () => {
  for (const declared of [
    "[bytes]",
    "[]bytes",
    "[int]",
    "[uint]",
    "[float]",
    "[datetime]",
    "integer",
    "Int",
    "I64",
    "[[i64]]",
    "[]",
    "",
    "vector",
    null,
    undefined,
    1,
    { type: "i64" },
  ]) {
    expect(rejected(decodePublicCell(declared, JSON.rawJSON("1"), permissive))).toBe(true);
    expect(rejected(encodePublicCell(declared, null, permissive))).toBe(true);
  }
});

test("public cells run through native raw JSON in workerd", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./public-cell-worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!built.success) throw new AggregateError(built.logs);
  const script = built.outputs[0];
  if (script === undefined) throw new Error("Missing public cell worker fixture");
  const worker = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    inspectorPort: 0,
    workers: [
      {
        config: {
          name: "public-cell",
          compatibilityDate: "2026-10-01",
          manifest: {
            modules: { "worker.js": { type: "esm", contents: await script.text() } },
            mainModule: "worker.js",
          },
        },
      },
    ],
  });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  const origin = await worker.ready;
  const send = (type: string, body: string, nullable = false) =>
    worker.dispatchFetch(
      new URL(`?type=${encodeURIComponent(type)}&nullable=${String(nullable)}`, origin),
      { method: "POST", body },
    );
  for (const [type, body, cell, wire] of [
    ["i64", "-9223372036854775808", { i64: "-9223372036854775808" }, "-9223372036854775808"],
    ["uint", "18446744073709551615", { u64: "18446744073709551615" }, "18446744073709551615"],
    ["f64", "-0", { f64: "8000000000000000" }, "-0"],
    ["f64", "5e-324", { f64: "0000000000000001" }, "5e-324"],
    [
      "[]uint",
      "[0,9007199254740993]",
      [{ u64: "0" }, { u64: "9007199254740993" }],
      "[0,9007199254740993]",
    ],
    ["bytes", '"AP8="', { bytes: "AP8=" }, '"AP8="'],
  ] as const) {
    const response = await send(type, body);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ cell, wire }));
  }
  const nullResponse = await send("string", "null", true);
  expect(await nullResponse.text()).toBe(JSON.stringify({ cell: null, wire: "null" }));
  const attributeText = '{"count":18446744073709551615,"note":null}';
  const attributeResponse = await worker.dispatchFetch(new URL("?attributes=true", origin), {
    method: "POST",
    body: attributeText,
  });
  expect(attributeResponse.status).toBe(200);
  expect(await attributeResponse.text()).toBe(
    JSON.stringify({
      cell: { count: { u64: "18446744073709551615" }, note: null },
      wire: attributeText,
    }),
  );
  const undeclaredResponse = await worker.dispatchFetch(new URL("?attributes=true", origin), {
    method: "POST",
    body: '{"unknown":1}',
  });
  expect(undeclaredResponse.status).toBe(422);
  const schemaResponse = await worker.dispatchFetch(new URL("?schema=true", origin), {
    method: "POST",
    body: JSON.stringify({
      payload: { type: "bytes" },
      note: { type: "string", filterable: false },
      count: { type: "uint" },
    }),
  });
  expect(schemaResponse.status).toBe(200);
  expect(await schemaResponse.json()).toEqual({
    declaration: {
      columns: [
        { name: "count", type: "u64", filterable: true, nullable: true },
        { name: "note", type: "string", filterable: false, nullable: true },
        { name: "payload", type: "bytes", filterable: false, nullable: true },
      ],
    },
    schema: {
      count: { type: "uint", filterable: true },
      note: { type: "string", filterable: false },
      payload: { type: "bytes", filterable: false },
    },
  });
  const unsupportedSchema = await worker.dispatchFetch(new URL("?schema=true", origin), {
    method: "POST",
    body: '{"text":{"type":"string","full_text_search":true}}',
  });
  expect(unsupportedSchema.status).toBe(422);
  const documents = [
    {
      id: { kind: "uint", value: "18446744073709551615" },
      roles: { title: "", text: "" },
      attributes: {
        title: "Named title",
        text: "Named text",
        count: { i64: "-9223372036854775808" },
        note: null,
      },
    },
  ];
  for (const [mode, body] of [
    [
      "rows",
      '[{"id":18446744073709551615,"title":"Named title","text":"Named text","count":-9223372036854775808,"note":null}]',
    ],
    [
      "columns",
      '{"id":[18446744073709551615],"title":["Named title"],"text":["Named text"],"count":[-9223372036854775808],"note":[null]}',
    ],
  ] as const) {
    const response = await worker.dispatchFetch(new URL(`?${mode}=true`, origin), {
      method: "POST",
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(documents);
  }
  const unequalColumns = await worker.dispatchFetch(new URL("?columns=true", origin), {
    method: "POST",
    body: '{"id":[1],"count":[]}',
  });
  expect(unequalColumns.status).toBe(422);
  for (const [type, body] of [
    ["i64", "9223372036854775808"],
    ["i64", "1.0"],
    ["f64", "1e999"],
    ["string", "null"],
    ["datetime_ms", "1700000000000"],
    ["datetime", '"2024-01-01T00:00:00Z"'],
  ] as const)
    expect((await send(type, body)).status).toBe(422);
});
