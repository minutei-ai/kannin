import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { decodePublicJson } from "../src/public-json";
import { decodePublicColumns, decodePublicRows } from "../src/public-rows";
import { decodePublicSchema } from "../src/public-schema";

const declaration = Effect.runSync(
  decodePublicSchema({
    title: { type: "string" },
    text: { type: "string" },
    count: { type: "int" },
    total: { type: "uint" },
    score: { type: "float" },
    owner: { type: "uuid" },
    payload: { type: "bytes" },
    tags: { type: "[]string" },
    flag: { type: "bool" },
    vector: { type: "string" },
  }),
);

const owner = "123e4567-e89b-12d3-a456-426614174000";
const wire = (text: string) => decodePublicJson(text);
const rows = (policy: unknown, text: string, declared: unknown = declaration) =>
  Effect.runSync(
    wire(text).pipe(Effect.flatMap((input) => decodePublicRows(policy, declared, input))),
  );
const columns = (policy: unknown, text: string, declared: unknown = declaration) =>
  Effect.runSync(
    wire(text).pipe(Effect.flatMap((input) => decodePublicColumns(policy, declared, input))),
  );
const rejectedRows = (policy: unknown, text: string, declared: unknown = declaration) =>
  Exit.isFailure(
    Effect.runSyncExit(
      wire(text).pipe(Effect.flatMap((input) => decodePublicRows(policy, declared, input))),
    ),
  );
const rejectedColumns = (policy: unknown, text: string, declared: unknown = declaration) =>
  Exit.isFailure(
    Effect.runSyncExit(
      wire(text).pipe(Effect.flatMap((input) => decodePublicColumns(policy, declared, input))),
    ),
  );

function failureOf<A, E>(effect: Effect.Effect<A, E>) {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("Expected a declared public rows failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("Public rows lost its declared failure");
  return failure.value;
}

const failureOfRows = (policy: unknown, text: string, declared: unknown = declaration) =>
  failureOf(wire(text).pipe(Effect.flatMap((input) => decodePublicRows(policy, declared, input))));
const failureOfColumns = (policy: unknown, text: string, declared: unknown = declaration) =>
  failureOf(
    wire(text).pipe(Effect.flatMap((input) => decodePublicColumns(policy, declared, input))),
  );

const repeated = (item: string, count: number) => Array.from({ length: count }, () => item);
const emptyRoles = { title: "", text: "" };
const batchIds = (count: number) =>
  JSON.stringify(Array.from({ length: count }, (_, index) => `id${index}`));
const rowBatch = (count: number) =>
  JSON.stringify(Array.from({ length: count }, (_, index) => ({ id: `id${index}` })));
const nulls = (count: number) => JSON.stringify(Array.from({ length: count }, () => null));
const arrayCell = (count: number) => JSON.stringify(repeated("x", count));

test("rows and columns decode to identical canonical documents with exact cells", () => {
  const rowText = `[
    {"id":"alpha","title":"T","text":"body","count":-9223372036854775808,"total":18446744073709551615,"score":-0,"owner":"${owner}","tags":["a","b"]},
    {"id":"beta","title":null,"text":"second","count":9007199254740993,"total":null,"score":0.1,"owner":null,"tags":null}
  ]`;
  const columnText = `{
    "id":["alpha","beta"],
    "title":["T",null],
    "text":["body","second"],
    "count":[-9223372036854775808,9007199254740993],
    "total":[18446744073709551615,null],
    "score":[-0,0.1],
    "owner":["${owner}",null],
    "tags":[["a","b"],null]
  }`;
  const fromRows = rows("string", rowText);
  expect(columns("string", columnText)).toEqual(fromRows);
  expect(fromRows).toEqual([
    {
      id: "alpha",
      roles: emptyRoles,
      attributes: {
        title: "T",
        text: "body",
        count: { i64: "-9223372036854775808" },
        total: { u64: "18446744073709551615" },
        score: { f64: "8000000000000000" },
        owner: { uuid: owner },
        tags: ["a", "b"],
      },
    },
    {
      id: "beta",
      roles: emptyRoles,
      attributes: {
        title: null,
        text: "second",
        count: { i64: "9007199254740993" },
        total: null,
        score: { f64: "3fb999999999999a" },
        owner: null,
        tags: null,
      },
    },
  ]);
});

test("named title and text attributes stay isolated and roles are always empty", () => {
  const [document] = rows("string", '[{"id":"a","title":"Heading","text":"Body"}]');
  expect(document?.roles).toEqual(emptyRoles);
  expect(document?.attributes).toEqual({ title: "Heading", text: "Body" });
  expect(Object.hasOwn(document ?? {}, "vector")).toBe(false);
  const [bare] = rows("string", '[{"id":"a"}]');
  expect(bare).toEqual({ id: "a", roles: emptyRoles, attributes: {} });
});

test("null is retained and absent attributes stay absent", () => {
  const [document] = rows("string", '[{"id":"a","count":null}]');
  expect(document?.attributes).toEqual({ count: null });
  expect(Object.hasOwn(document?.attributes ?? {}, "title")).toBe(false);
  const [fromColumns] = columns("string", '{"id":["a"],"count":[null]}');
  expect(fromColumns?.attributes).toEqual({ count: null });
  expect(Object.hasOwn(fromColumns?.attributes ?? {}, "title")).toBe(false);
});

test("vector is an ordinary string attribute and never inferred by shape", () => {
  const [document] = rows("string", '[{"id":"a","vector":"plain"}]');
  expect(document?.attributes).toEqual({ vector: "plain" });
  expect(Object.hasOwn(document ?? {}, "vector")).toBe(false);
  expect(rejectedRows("string", '[{"id":"a","vector":[0.1,0.2]}]')).toBe(true);
  expect(rejectedColumns("string", '{"id":["a"],"vector":[[0.1,0.2]]}')).toBe(true);
});

test("string, uint and uuid ID policies decode exact canonical IDs", () => {
  expect(rows("string", '[{"id":"a"},{"id":"18446744073709551615"}]').map((d) => d.id)).toEqual([
    "a",
    "18446744073709551615",
  ]);
  expect(
    rows("uint", '[{"id":0},{"id":9007199254740993},{"id":18446744073709551615}]').map((d) => d.id),
  ).toEqual([
    { kind: "uint", value: "0" },
    { kind: "uint", value: "9007199254740993" },
    { kind: "uint", value: "18446744073709551615" },
  ]);
  expect(
    columns("uint", '{"id":[9007199254740993,18446744073709551615]}').map((d) => d.id),
  ).toEqual([
    { kind: "uint", value: "9007199254740993" },
    { kind: "uint", value: "18446744073709551615" },
  ]);
  expect(rows("uuid", `[{"id":"${owner}"}]`).map((d) => d.id)).toEqual([
    { kind: "uuid", value: owner },
  ]);
  expect(columns("uuid", `{"id":["${owner}"]}`).map((d) => d.id)).toEqual([
    { kind: "uuid", value: owner },
  ]);
});

test("integer attributes keep exact endpoints beyond 2^53", () => {
  const [document] = rows(
    "string",
    '[{"id":"a","count":9223372036854775807,"total":9223372036854775808,"score":1e0}]',
  );
  expect(document?.attributes).toEqual({
    count: { i64: "9223372036854775807" },
    total: { u64: "9223372036854775808" },
    score: { f64: "3ff0000000000000" },
  });
  expect(rejectedRows("string", '[{"id":"a","count":9223372036854775808}]')).toBe(true);
  expect(rejectedRows("string", '[{"id":"a","total":18446744073709551616}]')).toBe(true);
  expect(rejectedRows("string", '[{"id":"a","total":-1}]')).toBe(true);
  expect(rejectedRows("string", '[{"id":"a","count":1.5}]')).toBe(true);
  expect(rejectedRows("string", '[{"id":"a","score":1e999}]')).toBe(true);
});

test("IDs reject coercion, unsafe JavaScript numbers and the wrong policy", () => {
  expect(rejectedRows("uint", '[{"id":"1"}]')).toBe(true);
  expect(rejectedRows("uint", '[{"id":-1}]')).toBe(true);
  expect(rejectedRows("uint", '[{"id":1.5}]')).toBe(true);
  expect(rejectedRows("uint", '[{"id":18446744073709551616}]')).toBe(true);
  expect(rejectedRows("string", '[{"id":1}]')).toBe(true);
  expect(rejectedRows("string", '[{"id":null}]')).toBe(true);
  expect(rejectedRows("uuid", '[{"id":"not-a-uuid"}]')).toBe(true);
  expect(rejectedRows("uuid", '[{"id":"a"}]')).toBe(true);
  expect(rejectedRows("string", `[{"id":"${"a".repeat(65)}"}]`)).toBe(true);
  expect(rejectedColumns("uint", '{"id":["1"]}')).toBe(true);
  expect(rejectedColumns("string", '{"id":[1]}')).toBe(true);
  expect(rejectedColumns("string", '{"id":[null]}')).toBe(true);
  for (const policy of ["integer", "UINT", "", null, undefined, 1, { type: "uint" }]) {
    expect(rejectedRows(policy, "[]")).toBe(true);
    expect(rejectedColumns(policy, '{"id":[]}')).toBe(true);
  }
  const unsafe = [{ id: Number.MAX_SAFE_INTEGER + 2 }, { id: 2n ** 64n - 1n }, { id: 1 }];
  for (const row of unsafe) {
    expect(Exit.isFailure(Effect.runSyncExit(decodePublicRows("uint", declaration, [row])))).toBe(
      true,
    );
  }
  expect(
    Exit.isFailure(Effect.runSyncExit(decodePublicColumns("uint", declaration, { id: [1] }))),
  ).toBe(true);
  expect(
    Exit.isFailure(
      Effect.runSyncExit(decodePublicRows("string", declaration, [{ id: "a", count: 1 }])),
    ),
  ).toBe(true);
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodePublicRows("string", declaration, [{ id: "a", count: { i64: "1" } }]),
      ),
    ),
  ).toBe(true);
});

test("missing id is distinct from null and reports its row", () => {
  expect(failureOfRows("string", '[{"id":"a"},{"title":"x"}]')).toMatchObject({
    _tag: "PublicRowsRejection",
    reason: "missing-id",
    row: 1,
  });
  expect(failureOfColumns("string", '{"title":["x"]}')).toMatchObject({
    _tag: "PublicRowsRejection",
    reason: "missing-id",
  });
  const nullId = failureOfRows("string", '[{"id":null}]');
  expect(nullId).not.toMatchObject({ _tag: "PublicRowsRejection" });
});

test("row and column containers must have the exact public shape", () => {
  for (const text of ["null", "{}", '"x"', "1", "true", "[null]", "[[]]", '["a"]', "[1]"])
    expect(rejectedRows("string", text)).toBe(true);
  for (const text of [
    "null",
    "[]",
    '"x"',
    "1",
    '{"id":"a"}',
    '{"id":["a"],"title":"x"}',
    '{"id":["a"],"title":{}}',
  ])
    expect(rejectedColumns("string", text)).toBe(true);
});

test("undeclared attributes are rejected in rows and columns without stripping", () => {
  const undeclared = { _tag: "PublicAttributesRejection", field: "extra" };
  expect(failureOfRows("string", '[{"id":"a","extra":1}]')).toMatchObject(undeclared);
  expect(failureOfColumns("string", '{"id":["a"],"extra":[1]}')).toMatchObject(undeclared);
  expect(failureOfColumns("string", '{"id":[],"extra":[]}')).toMatchObject(undeclared);
});

test("unequal column lengths are rejected before any cell decoding", () => {
  expect(failureOfColumns("string", '{"id":["a","b"],"count":[1]}')).toMatchObject({
    _tag: "PublicRowsRejection",
    reason: "unequal-columns",
    field: "count",
  });
  expect(failureOfColumns("string", '{"id":["a"],"count":[1,2]}')).toMatchObject({
    reason: "unequal-columns",
    field: "count",
  });
  expect(failureOfColumns("string", '{"id":[],"count":[null]}')).toMatchObject({
    reason: "unequal-columns",
  });
});

test("illegal cell types are rejected with their native causes", () => {
  for (const text of [
    '[{"id":"a","count":"1"}]',
    '[{"id":"a","count":true}]',
    '[{"id":"a","title":1}]',
    '[{"id":"a","flag":"true"}]',
    '[{"id":"a","tags":"x"}]',
    '[{"id":"a","tags":[1]}]',
    '[{"id":"a","tags":[null]}]',
    '[{"id":"a","owner":"NOT-A-UUID"}]',
    '[{"id":"a","payload":"@@"}]',
    '[{"id":"a","score":"1.5"}]',
    '[{"id":"a","title":{"x":1}}]',
  ])
    expect(rejectedRows("string", text)).toBe(true);
  expect(rejectedColumns("string", '{"id":["a"],"count":["1"]}')).toBe(true);
  expect(failureOfRows("string", '[{"id":"a","count":"1"}]')).toMatchObject({
    _tag: "SchemaError",
  });
});

test("unsupported and non-public declarations are rejected at the boundary", () => {
  const invalid: ReadonlyArray<unknown> = [
    { vectorDimensions: 4, columns: [{ name: "a", type: "string", nullable: true }] },
    { columns: [{ name: "id", type: "string", nullable: true }] },
    { columns: [{ name: "a", type: "string" }] },
    { columns: [{ name: "a", type: "string", nullable: false }] },
    { columns: [{ name: "a", type: "datetime_ms", nullable: true }] },
    { columns: [{ name: "a", type: "bytes", filterable: true, nullable: true }] },
    { columns: [{ name: "a", type: "string", nullable: true, extra: true }] },
    {
      columns: [
        { name: "a", type: "string", nullable: true },
        { name: "a", type: "bool", nullable: true },
      ],
    },
    null,
    [],
    "x",
  ];
  for (const declared of invalid) {
    expect(rejectedRows("string", "[]", declared)).toBe(true);
    expect(rejectedColumns("string", '{"id":[]}', declared)).toBe(true);
  }
  expect(failureOfRows("string", "[]", invalid[0])).toMatchObject({
    _tag: "PublicSchemaRejection",
    reason: "vector-dimensions",
  });
  expect(failureOfRows("string", "[]", invalid[1])).toMatchObject({
    _tag: "PublicSchemaRejection",
    reason: "reserved-id",
  });
});

test("empty batches are valid at the codec level", () => {
  expect(rows("string", "[]")).toEqual([]);
  expect(columns("string", '{"id":[]}')).toEqual([]);
  expect(columns("string", '{"id":[],"count":[]}')).toEqual([]);
  expect(rows("string", "[]", { columns: [] })).toEqual([]);
});

test("duplicate IDs are preserved in input order for the writer to police", () => {
  const decoded = rows("string", '[{"id":"a","count":1},{"id":"a","count":2}]');
  expect(decoded.map((d) => d.attributes)).toEqual([
    { count: { i64: "1" } },
    { count: { i64: "2" } },
  ]);
  expect(columns("string", '{"id":["a","a"],"count":[1,2]}')).toEqual(decoded);
});

test("native batch bound of 1000 is enforced for rows and columns", () => {
  expect(rows("string", rowBatch(1000))).toHaveLength(1000);
  expect(rejectedRows("string", rowBatch(1001))).toBe(true);
  expect(columns("string", `{"id":${batchIds(1000)}}`)).toHaveLength(1000);
  expect(rejectedColumns("string", `{"id":${batchIds(1001)}}`)).toBe(true);
  expect(rejectedColumns("string", `{"id":${batchIds(1000)},"count":${nulls(1001)}}`)).toBe(true);
});

test("array cells keep the 4096 element bound", () => {
  expect(
    rows("string", `[{"id":"a","tags":${arrayCell(4096)}}]`)[0]?.attributes["tags"],
  ).toHaveLength(4096);
  expect(rejectedRows("string", `[{"id":"a","tags":${arrayCell(4097)}}]`)).toBe(true);
  expect(rejectedColumns("string", `{"id":["a"],"tags":[${arrayCell(4097)}]}`)).toBe(true);
});
