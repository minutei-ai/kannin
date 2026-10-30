import { Effect, Schema } from "effect";
import type { Cause } from "effect";
import type { TypedColumnType } from "./protocol";
import {
  NativeJsonNumeric,
  PublicAttributesInput,
  PublicAttributesRejection,
  PublicCellAliasType,
  PublicCellRejection,
  PublicCellType,
  TypedCell,
  TypedAttributes,
  TypedDeclaration,
} from "./protocol";

type ColumnType = typeof TypedColumnType.Type;
type ElementKind = "string" | "bool" | "i64" | "u64" | "f64" | "uuid" | "bytes" | "datetime_ms";
type SupportedKind = Exclude<ElementKind, "datetime_ms">;
type Element = Exclude<typeof TypedCell.Type, null | ReadonlyArray<unknown>>;
type WireScalar = string | boolean | ReturnType<typeof JSON.rawJSON>;
type DecodeFailure = Schema.SchemaError | PublicCellRejection;
type EncodeFailure = PublicCellRejection | Cause.UnknownError;

export type PublicCellWire = null | WireScalar | ReadonlyArray<WireScalar>;

export interface PublicCellOptions {
  readonly nullable: boolean;
}

const ALIASES: Record<typeof PublicCellAliasType.Type, ColumnType> = {
  int: "i64",
  uint: "u64",
  float: "f64",
  datetime: "datetime_ms",
  "[]string": "[string]",
  "[]bool": "[bool]",
  "[]int": "[i64]",
  "[]uint": "[u64]",
  "[]float": "[f64]",
  "[]uuid": "[uuid]",
  "[]datetime": "[datetime_ms]",
};

interface Shape {
  readonly array: boolean;
  readonly element: ElementKind;
}

const SHAPES: Record<ColumnType, Shape> = {
  string: { array: false, element: "string" },
  bool: { array: false, element: "bool" },
  i64: { array: false, element: "i64" },
  u64: { array: false, element: "u64" },
  f64: { array: false, element: "f64" },
  uuid: { array: false, element: "uuid" },
  datetime_ms: { array: false, element: "datetime_ms" },
  bytes: { array: false, element: "bytes" },
  "[string]": { array: true, element: "string" },
  "[bool]": { array: true, element: "bool" },
  "[i64]": { array: true, element: "i64" },
  "[u64]": { array: true, element: "u64" },
  "[f64]": { array: true, element: "f64" },
  "[uuid]": { array: true, element: "uuid" },
  "[datetime_ms]": { array: true, element: "datetime_ms" },
};

const isAlias = Schema.is(PublicCellAliasType);
const isArrayCell = (
  cell: typeof TypedCell.Type,
): cell is Extract<typeof TypedCell.Type, ReadonlyArray<unknown>> => Array.isArray(cell);
const isSupported = (kind: ElementKind): kind is SupportedKind => kind !== "datetime_ms";
const WireArray = Schema.Array(Schema.Unknown).check(Schema.isMaxLength(4096));
const decodeTypedCell = Schema.decodeUnknownEffect(TypedCell, { onExcessProperty: "error" });
const decodeNumeric = Schema.decodeUnknownEffect(NativeJsonNumeric);
const decodeWireString = Schema.decodeUnknownEffect(Schema.String);
const decodeWireBoolean = Schema.decodeUnknownEffect(Schema.Boolean);
const decodeWireArray = Schema.decodeUnknownEffect(WireArray);
const rawNumber = (text: string) => Effect.try(() => JSON.rawJSON(text));

const reject = (reason: PublicCellRejection["reason"], declared: ColumnType) =>
  Effect.fail(new PublicCellRejection({ reason, declared }));

function resolveType(input: typeof PublicCellType.Type): ColumnType {
  if (isAlias(input)) return ALIASES[input];
  return input;
}

const resolveShape = Effect.fn("kannin.public.resolveCellType")(function* (declared: unknown) {
  const type = resolveType(yield* Schema.decodeUnknownEffect(PublicCellType)(declared));
  const shape = SHAPES[type];
  if (!isSupported(shape.element)) return yield* reject("unsupported-datetime", type);
  return { type, array: shape.array, element: shape.element };
});

function floatBits(
  lexeme: string,
  declared: ColumnType,
): Effect.Effect<string, PublicCellRejection> {
  const value = Number(lexeme);
  if (!Number.isFinite(value)) return reject("non-finite-float", declared);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return Effect.succeed(view.getBigUint64(0).toString(16).padStart(16, "0"));
}

function floatLexeme(bits: string): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  const value = view.getFloat64(0);
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

const DECODERS: Record<
  SupportedKind,
  (input: unknown, declared: ColumnType) => Effect.Effect<unknown, DecodeFailure>
> = {
  string: (input) => decodeWireString(input),
  bool: (input) => decodeWireBoolean(input),
  i64: (input) => decodeNumeric(input).pipe(Effect.map((numeric) => ({ i64: numeric.rawJSON }))),
  u64: (input) => decodeNumeric(input).pipe(Effect.map((numeric) => ({ u64: numeric.rawJSON }))),
  f64: (input, declared) =>
    decodeNumeric(input).pipe(
      Effect.flatMap((numeric) => floatBits(numeric.rawJSON, declared)),
      Effect.map((f64) => ({ f64 })),
    ),
  uuid: (input) => decodeWireString(input).pipe(Effect.map((uuid) => ({ uuid }))),
  bytes: (input) => decodeWireString(input).pipe(Effect.map((bytes) => ({ bytes }))),
};

const mismatch = (declared: ColumnType): Effect.Effect<WireScalar, EncodeFailure> =>
  reject("type-mismatch", declared);

const ENCODERS: Record<
  SupportedKind,
  (cell: Element, declared: ColumnType) => Effect.Effect<WireScalar, EncodeFailure>
> = {
  string: (cell, declared) => {
    if (typeof cell === "string") return Effect.succeed(cell);
    return mismatch(declared);
  },
  bool: (cell, declared) => {
    if (typeof cell === "boolean") return Effect.succeed(cell);
    return mismatch(declared);
  },
  i64: (cell, declared) => {
    if (typeof cell === "object" && "i64" in cell) return rawNumber(cell.i64);
    return mismatch(declared);
  },
  u64: (cell, declared) => {
    if (typeof cell === "object" && "u64" in cell) return rawNumber(cell.u64);
    return mismatch(declared);
  },
  f64: (cell, declared) => {
    if (typeof cell === "object" && "f64" in cell) return rawNumber(floatLexeme(cell.f64));
    return mismatch(declared);
  },
  uuid: (cell, declared) => {
    if (typeof cell === "object" && "uuid" in cell) return Effect.succeed(cell.uuid);
    return mismatch(declared);
  },
  bytes: (cell, declared) => {
    if (typeof cell === "object" && "bytes" in cell) return Effect.succeed(cell.bytes);
    return mismatch(declared);
  },
};

export const decodePublicCell = Effect.fn("kannin.public.decodeCell")(function* (
  declared: unknown,
  input: unknown,
  options: PublicCellOptions,
) {
  const shape = yield* resolveShape(declared);
  if (input === null) {
    if (!options.nullable) return yield* reject("null-not-allowed", shape.type);
    return yield* decodeTypedCell(null);
  }
  const decodeElement = DECODERS[shape.element];
  if (!shape.array) {
    const candidate = yield* decodeElement(input, shape.type);
    return yield* decodeTypedCell(candidate);
  }
  const items = yield* decodeWireArray(input);
  const candidates = yield* Effect.forEach(items, (item) => decodeElement(item, shape.type));
  return yield* decodeTypedCell(candidates);
});

export const encodePublicCell = Effect.fn("kannin.public.encodeCell")(function* (
  declared: unknown,
  cell: unknown,
  options: PublicCellOptions,
) {
  const shape = yield* resolveShape(declared);
  const typed = yield* decodeTypedCell(cell);
  if (typed === null) {
    if (!options.nullable) return yield* reject("null-not-allowed", shape.type);
    return null;
  }
  const encodeElement = ENCODERS[shape.element];
  if (!isArrayCell(typed)) {
    if (shape.array) return yield* reject("type-mismatch", shape.type);
    return yield* encodeElement(typed, shape.type);
  }
  if (!shape.array) return yield* reject("type-mismatch", shape.type);
  const items: ReadonlyArray<Element> = typed;
  return yield* Effect.forEach(items, (item) => encodeElement(item, shape.type));
});

const declaredColumns = (declaration: unknown) =>
  Schema.decodeUnknownEffect(TypedDeclaration, { onExcessProperty: "error" })(declaration).pipe(
    Effect.map(
      (decoded) => new Map(decoded.columns.map((column) => [column.name, column] as const)),
    ),
  );

export const decodePublicAttributes = Effect.fn("kannin.public.decodeAttributes")(function* (
  declaration: unknown,
  input: unknown,
) {
  const columns = yield* declaredColumns(declaration);
  const attributes = yield* Schema.decodeUnknownEffect(PublicAttributesInput)(input);
  const entries = yield* Effect.forEach(Object.entries(attributes), ([name, value]) =>
    Effect.gen(function* () {
      const column = columns.get(name);
      if (column === undefined)
        return yield* new PublicAttributesRejection({
          field: name,
          reason: "undeclared-attribute",
        });
      const cell = yield* decodePublicCell(column.type, value, {
        nullable: column.nullable === true,
      });
      return [name, cell] as const;
    }),
  );
  return yield* Schema.decodeEffect(TypedAttributes, { onExcessProperty: "error" })(
    Object.fromEntries(entries),
  );
});

export const encodePublicAttributes = Effect.fn("kannin.public.encodeAttributes")(function* (
  declaration: unknown,
  input: unknown,
) {
  const columns = yield* declaredColumns(declaration);
  const attributes = yield* Schema.decodeUnknownEffect(TypedAttributes, {
    onExcessProperty: "error",
  })(input);
  const entries = yield* Effect.forEach(Object.entries(attributes), ([name, cell]) =>
    Effect.gen(function* () {
      const column = columns.get(name);
      if (column === undefined)
        return yield* new PublicAttributesRejection({
          field: name,
          reason: "undeclared-attribute",
        });
      const value = yield* encodePublicCell(column.type, cell, {
        nullable: column.nullable === true,
      });
      return [name, value] as const;
    }),
  );
  return Object.fromEntries(entries);
});
