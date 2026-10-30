import { Effect, Schema } from "effect";
import {
  compareFieldNames,
  PublicSchema,
  PublicSchemaAttribute,
  PublicSchemaInput,
  PublicSchemaOptions,
  PublicSchemaRejection,
  PublicSchemaUnsupportedOption,
  PublicSchemaVectorType,
  TypedDeclaration,
} from "./protocol";
import { normalizePublicCellType, publicCellSpelling } from "./public-cell";

type Column = (typeof TypedDeclaration.Type)["columns"][number];

const RESERVED_ID = "id";
const isUnsupportedOption = Schema.is(PublicSchemaUnsupportedOption);
const isVectorType = Schema.is(PublicSchemaVectorType);
const decodeInput = Schema.decodeUnknownEffect(PublicSchemaInput, { onExcessProperty: "error" });
const decodeOptions = Schema.decodeUnknownEffect(PublicSchemaOptions);
const decodeAttribute = Schema.decodeUnknownEffect(PublicSchemaAttribute, {
  onExcessProperty: "error",
});
const decodeDeclaration = Schema.decodeUnknownEffect(TypedDeclaration, {
  onExcessProperty: "error",
});
const decodeProjection = Schema.decodeUnknownEffect(PublicSchema, { onExcessProperty: "error" });

const reject = (field: string, reason: PublicSchemaRejection["reason"]) =>
  Effect.fail(new PublicSchemaRejection({ field, reason }));

const isDatetime = (type: Column["type"]) => type === "datetime_ms" || type === "[datetime_ms]";

const declareAttribute = Effect.fn("kannin.public.declareSchemaAttribute")(function* (
  name: string,
  declared: unknown,
) {
  if (name === RESERVED_ID) return yield* reject(name, "reserved-id");
  const options = yield* decodeOptions(declared);
  if (Object.keys(options).some(isUnsupportedOption))
    return yield* reject(name, "unsupported-option");
  if (isVectorType(options["type"])) return yield* reject(name, "unsupported-vector");
  const attribute = yield* decodeAttribute(options);
  const type = normalizePublicCellType(attribute.type);
  if (isDatetime(type)) return yield* reject(name, "unsupported-datetime");
  if (type === "bytes") {
    if (attribute.filterable === true) return yield* reject(name, "bytes-filterable");
    return { name, type, filterable: false, nullable: true } satisfies Column;
  }
  return { name, type, filterable: attribute.filterable ?? true, nullable: true } satisfies Column;
});

export const decodePublicSchema = Effect.fn("kannin.public.decodeSchema")(function* (
  input: unknown,
) {
  const attributes = yield* decodeInput(input);
  const columns = yield* Effect.forEach(Object.entries(attributes), ([name, declared]) =>
    declareAttribute(name, declared),
  );
  return yield* Schema.decodeEffect(TypedDeclaration, { onExcessProperty: "error" })({
    columns: columns.toSorted((left, right) => compareFieldNames(left.name, right.name)),
  });
});

const projectColumn = Effect.fn("kannin.public.projectSchemaColumn")(function* (column: Column) {
  if (column.name === RESERVED_ID) return yield* reject(column.name, "reserved-id");
  if (column.nullable !== true) return yield* reject(column.name, "non-nullable");
  if (isDatetime(column.type)) return yield* reject(column.name, "unsupported-datetime");
  return [
    column.name,
    { type: publicCellSpelling(column.type), filterable: column.filterable === true },
  ] as const;
});

export const encodePublicSchema = Effect.fn("kannin.public.encodeSchema")(function* (
  declaration: unknown,
) {
  const decoded = yield* decodeDeclaration(declaration);
  if (decoded.vectorDimensions !== undefined)
    return yield* new PublicSchemaRejection({ reason: "vector-dimensions" });
  const entries = yield* Effect.forEach(decoded.columns, (column) => projectColumn(column));
  return yield* decodeProjection(Object.fromEntries(entries));
});
