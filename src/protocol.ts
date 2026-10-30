import { Effect, Schema, SchemaGetter, SchemaIssue, Struct } from "effect";

const textEncoder = new TextEncoder();
const Unicode = Schema.String.check(
  Schema.makeFilter((text) => text.isWellFormed() || "Expected well-formed Unicode"),
);
export const DistanceMetric = Schema.Literals(["cosine_distance", "euclidean_squared"]);
export const VectorDistanceHits = Schema.Array(
  Schema.Tuple([
    Unicode.check(
      Schema.makeFilter(
        (key) =>
          (key.length > 0 && textEncoder.encode(key).byteLength <= 512) ||
          "Vector candidate key exceeds its byte budget",
      ),
    ),
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ]),
).check(Schema.isMaxLength(10_000));
const AnalysisLanguage = Schema.Literals([
  "arabic",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "greek",
  "hungarian",
  "italian",
  "norwegian",
  "portuguese",
  "romanian",
  "russian",
  "spanish",
  "swedish",
  "tamil",
  "turkish",
]);
export const WordV4Config = Schema.Struct({
  max_token_length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 255 })),
  case_sensitive: Schema.Boolean,
  stopwords: Schema.NullOr(
    AnalysisLanguage.check(
      Schema.makeFilter(
        (language) =>
          !["arabic", "greek", "romanian", "tamil", "turkish"].includes(language) ||
          "Stopword removal is unavailable for this language",
      ),
    ),
  ),
  stemming: Schema.NullOr(AnalysisLanguage),
  ascii_folding: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (config) =>
      !config.case_sensitive ||
      (config.stopwords === null && config.stemming === null) ||
      "Case-sensitive analysis cannot remove stopwords or apply stemming",
  ),
);
const AnalysisOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const AnalyzedTokens = Schema.Array(
  Schema.Struct({
    text: Unicode,
    position: AnalysisOffset,
    position_length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    input_index: AnalysisOffset,
    byte_start: AnalysisOffset,
    byte_end: AnalysisOffset,
  }).check(
    Schema.makeFilter((token) => token.byte_end > token.byte_start || "Invalid token byte range"),
  ),
).check(Schema.isMaxLength(65_536));
export const Id = Unicode.check(Schema.isBetweenLength(1, 128));
export const PublicStringId = Id.check(
  Schema.makeFilter(
    (id) => textEncoder.encode(id).byteLength <= 64 || "Public string ID exceeds 64 UTF-8 bytes",
  ),
);
export const NamespacePrefix = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/));
export const NamespaceName = NamespacePrefix.check(
  Schema.makeFilter(
    (name) => (name !== "." && name !== "..") || "Namespace cannot be a URL dot segment",
  ),
);
export const Operation = Schema.Literals([
  "write",
  "query",
  "metadata",
  "hint_cache_warm",
  "vector-sync",
  "vector-rebuild",
  "rebuild",
  "compact",
  "collect",
  "migrate-root",
]);
export const Scalar = Schema.Union([Unicode, Schema.Finite, Schema.Boolean, Schema.Null]);
export const FieldName = Unicode.check(
  Schema.isBetweenLength(1, 128),
  Schema.makeFilter(
    (name) =>
      (!name.startsWith("$") && textEncoder.encode(name).byteLength <= 128) ||
      "Attribute names must fit 128 UTF-8 bytes and cannot start with $",
  ),
);
export function compareFieldNames(left: string, right: string): number {
  const cursor = { offset: 0 };
  const length = Math.min(left.length, right.length);
  while (cursor.offset < length) {
    const a = left.codePointAt(cursor.offset);
    const b = right.codePointAt(cursor.offset);
    if (a === undefined || b === undefined) break;
    if (a !== b) return a - b;
    cursor.offset += 1;
    if (a > 0xffff) cursor.offset += 1;
  }
  return left.length - right.length;
}
export const AttributeValue = Schema.Union([
  Scalar,
  Schema.Array(Scalar).check(Schema.isMaxLength(4096)),
]);
export const Attributes = Schema.Record(FieldName, AttributeValue);
const encodeAttributes = Schema.encodeSync(Schema.fromJsonString(Attributes), {
  disableChecks: true,
});
export const ConstantAttributes = Schema.Record(FieldName, Scalar).check(
  Schema.makeFilter(
    (attributes) =>
      Object.values(attributes).every(
        (value) => typeof value !== "number" || Number.isSafeInteger(value),
      ) || "Numeric constants must be safe integers",
  ),
  Schema.makeFilter(
    (attributes) =>
      textEncoder.encode(encodeAttributes(attributes)).byteLength <= 512 ||
      "Constant attributes exceed 512 bytes",
  ),
);
export const VectorFilterFields = Schema.Array(FieldName).check(
  Schema.isMaxLength(5),
  Schema.makeFilter(
    (fields) => new Set(fields).size === fields.length || "Duplicate indexed field",
  ),
);
const MIN_VECTOR_DIMENSIONS = 1;
const MAX_VECTOR_DIMENSIONS = 10_752;
export const DEFAULT_VECTOR_DIMENSIONS = 768;
const VectorDimensions = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_VECTOR_DIMENSIONS, maximum: MAX_VECTOR_DIMENSIONS }),
);
export const NamespaceSchema = Schema.Struct({
  vectorDimensions: Schema.optional(VectorDimensions),
  filterable: Schema.Array(FieldName).check(
    Schema.isMaxLength(64),
    Schema.makeFilter(
      (fields) => new Set(fields).size === fields.length || "Duplicate filterable field",
    ),
  ),
  vectorFilterFields: VectorFilterFields,
}).check(
  Schema.makeFilter(
    (schema) =>
      schema.vectorFilterFields.every((field) => schema.filterable.includes(field)) ||
      "Vector filter fields must be filterable",
  ),
);
const NativeVectorColumn = Schema.Struct({
  source: Schema.Literal("native-vector"),
  dimensions: Schema.optional(VectorDimensions),
});
const LegacyAttributeColumn = Schema.Struct({
  source: Schema.Literal("attribute"),
  name: FieldName,
  value: Schema.Literal("legacy-untyped"),
  vectorFilterOrder: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  ),
});
export const TypedColumnType = Schema.Literals([
  "string",
  "bool",
  "i64",
  "u64",
  "f64",
  "uuid",
  "datetime_ms",
  "bytes",
  "[string]",
  "[bool]",
  "[i64]",
  "[u64]",
  "[f64]",
  "[uuid]",
  "[datetime_ms]",
]);
const MAX_TYPED_COLUMNS = 1024;
const MAX_TYPED_FILTERABLE = 64;
const TypedAttributeColumn = Schema.Struct({
  source: Schema.Literal("attribute"),
  name: FieldName,
  value: Schema.Literal("typed"),
  type: TypedColumnType,
  filterable: Schema.Boolean,
  nullable: Schema.Boolean,
});
const TypedNamespaceColumn = Schema.Struct({ source: Schema.Literal("typed-namespace") });
const ColumnDeclaration = Schema.Union([
  NativeVectorColumn,
  TypedNamespaceColumn,
  LegacyAttributeColumn,
  TypedAttributeColumn,
]);
const validNamespaceColumns = (columns: ReadonlyArray<typeof ColumnDeclaration.Type>) => {
  const vector = columns[0];
  if (vector === undefined || vector.source !== "native-vector")
    return "Native vector column must lead the namespace schema";
  if (columns.some((column, index) => index > 0 && column.source === "native-vector"))
    return "Namespace schema has one native vector column";
  const names = new Set<string>();
  const orders: Array<number> = [];
  const typed: Array<typeof TypedAttributeColumn.Type> = [];
  const legacy: Array<typeof LegacyAttributeColumn.Type> = [];
  const markers = columns.filter((column) => column.source === "typed-namespace").length;
  if (markers > 1) return "Namespace schema has one typed namespace marker";
  if (markers === 1 && columns[1]?.source !== "typed-namespace")
    return "Typed namespace marker must follow the native vector column";
  for (const column of columns) {
    if (column.source !== "attribute") continue;
    if (names.has(column.name)) return "Duplicate filterable field";
    names.add(column.name);
    if (column.value === "typed") typed.push(column);
    else {
      legacy.push(column);
      if (column.vectorFilterOrder !== undefined) orders.push(column.vectorFilterOrder);
    }
  }
  if (markers === 1) {
    if (legacy.length > 0) return "Namespace schema cannot mix typed and legacy attribute columns";
    if (typed.length > MAX_TYPED_COLUMNS) return "Typed columns exceed 1024";
    if (typed.filter((column) => column.filterable).length > MAX_TYPED_FILTERABLE)
      return "Filterable typed columns exceed 64";
    for (const [index, column] of typed.entries()) {
      const previous = typed[index - 1];
      if (previous !== undefined && compareFieldNames(previous.name, column.name) >= 0)
        return "Typed columns must be sorted by name";
      if (column.type === "bytes" && column.filterable) return "Bytes columns cannot be filterable";
    }
    return true;
  }
  if (typed.length > 0) return "Typed attribute columns require the typed namespace marker";
  if (legacy.length > MAX_TYPED_FILTERABLE) return "Legacy attribute columns exceed 64";
  orders.sort((left, right) => left - right);
  return (
    orders.every((order, index) => order === index) ||
    "Vector filter order must be dense and unique"
  );
};
export const NamespaceColumns = Schema.Struct({
  columns: Schema.Array(ColumnDeclaration).check(
    Schema.isBetweenLength(1, MAX_TYPED_COLUMNS + 1),
    Schema.makeFilter(validNamespaceColumns),
  ),
});
export function namespaceColumnsFromNative(
  schema: typeof NamespaceSchema.Type,
): typeof NamespaceColumns.Type {
  const orders = new Map(schema.vectorFilterFields.map((name, index) => [name, index]));
  const columns: Array<typeof ColumnDeclaration.Type> = [{ source: "native-vector" }];
  if (schema.vectorDimensions !== undefined)
    columns[0] = { source: "native-vector", dimensions: schema.vectorDimensions };
  for (const name of schema.filterable) {
    const vectorFilterOrder = orders.get(name);
    if (vectorFilterOrder === undefined)
      columns.push({ source: "attribute", name, value: "legacy-untyped" });
    else columns.push({ source: "attribute", name, value: "legacy-untyped", vectorFilterOrder });
  }
  return { columns };
}
export function nativeSchemaFromColumns(
  schema: typeof NamespaceColumns.Type,
): typeof NamespaceSchema.Type {
  if (isTypedNamespace(schema))
    throw new TypeError("Typed columns cannot be projected as native schema");
  const attributes = schema.columns.filter((column) => column.source === "attribute");
  const legacy = attributes.flatMap((column) => {
    if (column.value === "legacy-untyped") return [column];
    return [];
  });
  const vector = schema.columns[0];
  const native = {
    filterable: legacy.map((column) => column.name),
    vectorFilterFields: legacy
      .flatMap((column) => {
        if (column.vectorFilterOrder === undefined) return [];
        return [[column.vectorFilterOrder, column.name] as const];
      })
      .sort((left, right) => left[0] - right[0])
      .map(([, name]) => name),
  };
  if (vector?.source === "native-vector" && vector.dimensions !== undefined)
    return { ...native, vectorDimensions: vector.dimensions };
  return native;
}
export type TypedColumn = typeof TypedAttributeColumn.Type;
export function typedColumns(
  schema: typeof NamespaceColumns.Type | undefined,
): ReadonlyArray<TypedColumn> | undefined {
  if (schema === undefined) return undefined;
  if (!schema.columns.some((column) => column.source === "typed-namespace")) return undefined;
  return schema.columns.flatMap((column) => {
    if (column.source === "attribute" && column.value === "typed") return [column];
    return [];
  });
}
export function isTypedNamespace(schema: typeof NamespaceColumns.Type | undefined) {
  return typedColumns(schema) !== undefined;
}
export function typedEngineColumns(columns: ReadonlyArray<TypedColumn>) {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    filterable: column.filterable,
    nullable: column.nullable,
  }));
}
export function filterableNames(schema: typeof NamespaceColumns.Type | undefined) {
  if (schema === undefined) return undefined;
  return schema.columns.flatMap((column) => {
    if (column.source !== "attribute") return [];
    if (column.value === "typed" && !column.filterable) return [];
    return [column.name];
  });
}
export function vectorFilterNames(schema: typeof NamespaceColumns.Type | undefined) {
  if (schema === undefined) return undefined;
  if (isTypedNamespace(schema)) return [];
  return nativeSchemaFromColumns(schema).vectorFilterFields;
}
export function resolvedVectorDimensions(schema: typeof NamespaceColumns.Type | undefined) {
  const vector = schema?.columns[0];
  if (vector?.source === "native-vector" && vector.dimensions !== undefined)
    return vector.dimensions;
  return DEFAULT_VECTOR_DIMENSIONS;
}
export const Vector = Schema.Array(
  Schema.Finite.check(
    Schema.isBetween({ minimum: -3.4028234663852886e38, maximum: 3.4028234663852886e38 }),
  ),
).check(
  Schema.isBetweenLength(MIN_VECTOR_DIMENSIONS, MAX_VECTOR_DIMENSIONS),
  Schema.makeFilter(
    (values) =>
      values.some((value) => Math.fround(value) !== 0) ||
      "A cosine vector must have nonzero float32 magnitude",
  ),
);
const NativeTitle = Unicode.check(Schema.isMaxLength(8192));
export const Document = Schema.Struct({
  id: Id,
  title: Schema.optional(NativeTitle),
  text: Unicode.check(Schema.isMaxLength(262144)),
  attributes: Attributes,
  vector: Schema.optional(Vector),
});
export const Write = Schema.Struct({
  schema: Schema.optional(NamespaceSchema),
  requestId: Id,
  upserts: Schema.Array(Document).check(Schema.isMaxLength(1000)),
  deletes: Schema.Array(Id).check(Schema.isMaxLength(1000)),
  reset: Schema.optional(Schema.Boolean),
});
export const StoredDocument = Document.mapFields((fields) => ({ ...fields, revision: Schema.Int }));
export const QueryDocument = StoredDocument.mapFields((fields) => ({
  ...Struct.omit(fields, ["vector"]),
  vectorSummary: Schema.NullOr(
    Schema.Tuple([
      Schema.Int.check(
        Schema.isBetween({ minimum: MIN_VECTOR_DIMENSIONS, maximum: MAX_VECTOR_DIMENSIONS }),
      ),
      Schema.Literal(true),
      Schema.Literal(true),
    ]),
  ),
}));
export const DocumentColumnId = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("native"),
    role: Schema.Literals(["title", "text", "vector"]),
  }),
  Schema.Struct({ source: Schema.Literal("attribute"), name: FieldName }),
]);
export const Int64Text = Schema.String.check(
  Schema.isPattern(/^(0|-?[1-9][0-9]{0,18})(?![\s\S])/),
  Schema.makeFilter((value) => {
    if (value.startsWith("-")) {
      const magnitude = value.slice(1);
      return (
        magnitude.length < 19 || magnitude <= "9223372036854775808" || "Value exceeds int64 range"
      );
    }
    return value.length < 19 || value <= "9223372036854775807" || "Value exceeds int64 range";
  }),
);
export const Uint64Text = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,19})(?![\s\S])/),
  Schema.makeFilter(
    (value) => value.length < 20 || value <= "18446744073709551615" || "ID exceeds uint64 range",
  ),
);
export const Float64BitsText = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!/^[0-9a-f]{16}(?![\s\S])/.test(value)) return "Expected 16 lowercase hexadecimal digits";
    return ((BigInt(`0x${value}`) >> 52n) & 0x7ffn) !== 0x7ffn || "Typed float must be finite";
  }),
);
function base64Digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}
export const BytesBase64Text = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.length % 4 !== 0 || value.length > 11_184_812)
      return "Expected padded base64 within the decoded 8 MiB bound";
    const state = { padding: 0, offset: 0 };
    if (value.endsWith("==")) state.padding = 2;
    else if (value.endsWith("=")) state.padding = 1;
    if ((value.length / 4) * 3 - state.padding > 8_388_608)
      return "Bytes exceed the decoded 8 MiB bound";
    const end = value.length - state.padding;
    while (state.offset < end) {
      if (base64Digit(value.charCodeAt(state.offset)) < 0) return "Invalid base64 alphabet";
      state.offset += 1;
    }
    if (state.padding === 2 && base64Digit(value.charCodeAt(end - 1)) % 16 !== 0)
      return "Non-canonical base64 padding bits";
    if (state.padding === 1 && base64Digit(value.charCodeAt(end - 1)) % 4 !== 0)
      return "Non-canonical base64 padding bits";
    return true;
  }),
);
export const UuidText = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/),
);
const TypedIntCell = Schema.Struct({ i64: Int64Text });
const TypedUintCell = Schema.Struct({ u64: Uint64Text });
const TypedFloatCell = Schema.Struct({ f64: Float64BitsText });
const TypedUuidCell = Schema.Struct({ uuid: UuidText });
const TypedDatetimeCell = Schema.Struct({ datetime_ms: Int64Text });
const TypedBytesCell = Schema.Struct({ bytes: BytesBase64Text });
export const TypedCellScalar = Schema.Union([
  Unicode,
  Schema.Boolean,
  TypedIntCell,
  TypedUintCell,
  TypedFloatCell,
  TypedUuidCell,
  TypedDatetimeCell,
]);
const TypedCellArray = Schema.Union([
  Schema.Array(Unicode),
  Schema.Array(Schema.Boolean),
  Schema.Array(TypedIntCell),
  Schema.Array(TypedUintCell),
  Schema.Array(TypedFloatCell),
  Schema.Array(TypedUuidCell),
  Schema.Array(TypedDatetimeCell),
]).check(Schema.isMaxLength(4096));
export const TypedCell = Schema.Union([
  Schema.Null,
  TypedCellScalar,
  TypedBytesCell,
  TypedCellArray,
]);
export const TypedAttributes = Schema.Record(FieldName, TypedCell);
export const TypedTag = Schema.Union([
  TypedIntCell,
  TypedUintCell,
  TypedFloatCell,
  TypedUuidCell,
  TypedDatetimeCell,
]);
type CellKind =
  | "null"
  | "string"
  | "bool"
  | "i64"
  | "u64"
  | "f64"
  | "uuid"
  | "datetime_ms"
  | "bytes"
  | "array"
  | "invalid";
const TAG_KINDS = ["i64", "u64", "f64", "uuid", "datetime_ms", "bytes"] as const;
function cellKind(cell: unknown): CellKind {
  if (cell === null) return "null";
  if (typeof cell === "string") return "string";
  if (typeof cell === "boolean") return "bool";
  if (Array.isArray(cell)) return "array";
  if (typeof cell !== "object") return "invalid";
  const keys = Object.keys(cell);
  const [only] = keys;
  if (keys.length !== 1) return "invalid";
  return TAG_KINDS.find((kind) => kind === only) ?? "invalid";
}
function cellConforms(type: typeof TypedColumnType.Type, cell: unknown, nullable: boolean) {
  const kind = cellKind(cell);
  if (kind === "null") return nullable;
  if (type.startsWith("[")) {
    if (kind !== "array" || !Array.isArray(cell)) return false;
    const element = type.slice(1, -1);
    return cell.every((item) => cellKind(item) === element);
  }
  return kind === type;
}
export function validateTypedAttributes(
  columns: ReadonlyArray<TypedColumn>,
  attributes: Readonly<Record<string, unknown>>,
): string | undefined {
  const declared = new Map(columns.map((column) => [column.name, column] as const));
  for (const [name, cell] of Object.entries(attributes)) {
    const column = declared.get(name);
    if (column === undefined) return `Undeclared attribute ${name}`;
    if (!cellConforms(column.type, cell, column.nullable))
      return `Attribute ${name} does not match its declared ${column.type} type`;
  }
  return undefined;
}
const ORDERED_KINDS = new Set<string>(["string", "i64", "u64", "f64", "uuid", "datetime_ms"]);
export function validateTypedFilter(
  columns: ReadonlyArray<TypedColumn>,
  filter: { readonly field: string; readonly op: string; readonly value: unknown },
): string | undefined {
  const column = columns.find((candidate) => candidate.name === filter.field);
  if (column === undefined || !column.filterable)
    return `Attribute is not filterable: ${filter.field}`;
  const array = column.type.startsWith("[");
  const element = column.type.replace(/^\[|\]$/g, "");
  const incompatible = `Filter ${filter.op} is incompatible with ${filter.field} (${column.type})`;
  const scalarOperand = (value: unknown) => cellKind(value) === element;
  const single = (value: unknown) =>
    cellConforms(column.type, value, false) || (value === null && column.nullable);
  const list = (check: (value: unknown) => boolean) =>
    Array.isArray(filter.value) && filter.value.every(check);
  const ordered = () => !array && ORDERED_KINDS.has(column.type) && scalarOperand(filter.value);
  const rules: Record<string, () => boolean> = {
    exists: () => typeof filter.value === "boolean",
    eq: () => single(filter.value),
    ne: () => single(filter.value),
    in: () => list(single),
    notIn: () => list(single),
    contains: () => array && scalarOperand(filter.value),
    notContains: () => array && scalarOperand(filter.value),
    containsAny: () => array && list(scalarOperand),
    notContainsAny: () => array && list(scalarOperand),
    gt: ordered,
    gte: ordered,
    lt: ordered,
    lte: ordered,
  };
  const rule = rules[filter.op];
  if (Object.hasOwn(rules, filter.op) && rule !== undefined && rule()) return undefined;
  return incompatible;
}
export const TypedColumnInput = Schema.Struct({
  name: FieldName,
  type: TypedColumnType,
  filterable: Schema.optional(Schema.Boolean),
  nullable: Schema.optional(Schema.Boolean),
});
export const TypedDeclaration = Schema.Struct({
  vectorDimensions: Schema.optional(VectorDimensions),
  columns: Schema.Array(TypedColumnInput).check(
    Schema.isMaxLength(MAX_TYPED_COLUMNS),
    Schema.makeFilter(
      (columns) =>
        new Set(columns.map((column) => column.name)).size === columns.length ||
        "Duplicate typed column",
    ),
    Schema.makeFilter(
      (columns) =>
        columns.filter((column) => column.filterable === true).length <= MAX_TYPED_FILTERABLE ||
        "Filterable typed columns exceed 64",
    ),
    Schema.makeFilter(
      (columns) =>
        columns.every((column) => column.type !== "bytes" || column.filterable !== true) ||
        "Bytes columns cannot be filterable",
    ),
  ),
});
export function namespaceColumnsFromTyped(
  declaration: typeof TypedDeclaration.Type,
): typeof NamespaceColumns.Type {
  const attributes = declaration.columns
    .map((column): TypedColumn => ({
      source: "attribute",
      name: column.name,
      value: "typed",
      type: column.type,
      filterable: column.filterable === true,
      nullable: column.nullable === true,
    }))
    .toSorted((left, right) => compareFieldNames(left.name, right.name));
  const vector: typeof NativeVectorColumn.Type = { source: "native-vector" };
  const marker: typeof TypedNamespaceColumn.Type = { source: "typed-namespace" };
  if (declaration.vectorDimensions !== undefined)
    return {
      columns: [{ ...vector, dimensions: declaration.vectorDimensions }, marker, ...attributes],
    };
  return { columns: [vector, marker, ...attributes] };
}
export function sameNamespaceColumns(
  left: typeof NamespaceColumns.Type,
  right: typeof NamespaceColumns.Type,
) {
  const encode = Schema.encodeSync(Schema.fromJsonString(NamespaceColumns));
  return encode(left) === encode(right);
}
export const CanonicalId = Schema.Union([
  Id,
  Schema.Struct({ kind: Schema.Literal("uint"), value: Uint64Text }),
  Schema.Struct({ kind: Schema.Literal("uuid"), value: UuidText }),
]);
export const BloomValue = Schema.Union([Schema.String, CanonicalId]);
export const IdType = Schema.Literals(["string", "uint", "uuid"]);
export function canonicalIdType(id: typeof CanonicalId.Type): typeof IdType.Type {
  if (typeof id === "string") return "string";
  return id.kind;
}
export function canonicalIdKey(id: typeof CanonicalId.Type): string {
  if (typeof id === "string") return `string:${id}`;
  return `${id.kind}:${id.value}`;
}
function canonicalIdValue(id: typeof CanonicalId.Type): string {
  if (typeof id === "string") return id;
  return id.value;
}
export function compareCanonicalIds(
  left: typeof CanonicalId.Type,
  right: typeof CanonicalId.Type,
): number {
  const a = canonicalIdType(left);
  const b = canonicalIdType(right);
  if (a !== b) {
    if (a < b) return -1;
    return 1;
  }
  const x = canonicalIdValue(left);
  const y = canonicalIdValue(right);
  if (a === "uint" && x.length !== y.length) return x.length - y.length;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}
export function sameCanonicalId(
  left: typeof CanonicalId.Type,
  right: typeof CanonicalId.Type,
): boolean {
  return compareCanonicalIds(left, right) === 0;
}
export const CanonicalDocument = Schema.Struct({
  id: CanonicalId,
  revision: StoredDocument.fields.revision,
  roles: Schema.Struct({ title: NativeTitle, text: Document.fields.text }),
  attributes: Attributes,
  vector: Document.fields.vector,
});
export const CanonicalWriteDocument = CanonicalDocument.mapFields((fields) =>
  Struct.omit(fields, ["revision"]),
);
export const CanonicalWrite = Schema.Struct({
  kind: Schema.Literal("canonical"),
  requestId: Id,
  idType: IdType,
  schema: Schema.optional(NamespaceSchema),
  upserts: Schema.Array(CanonicalWriteDocument).check(Schema.isMaxLength(1000)),
  deletes: Schema.Array(CanonicalId).check(Schema.isMaxLength(1000)),
  reset: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (write) =>
      [...write.upserts.map((document) => document.id), ...write.deletes].every(
        (id) => canonicalIdType(id) === write.idType,
      ) || "Canonical write IDs differ from declared type",
  ),
);
export const TypedWriteDocument = CanonicalWriteDocument.mapFields((fields) => ({
  ...fields,
  attributes: TypedAttributes,
}));
export const TypedWrite = Schema.Struct({
  kind: Schema.Literal("typed"),
  requestId: Id,
  idType: IdType,
  declaration: Schema.optional(TypedDeclaration),
  upserts: Schema.Array(TypedWriteDocument).check(Schema.isMaxLength(1000)),
  deletes: Schema.Array(CanonicalId).check(Schema.isMaxLength(1000)),
  reset: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (write) =>
      [...write.upserts.map((document) => document.id), ...write.deletes].every(
        (id) => canonicalIdType(id) === write.idType,
      ) || "Typed write IDs differ from declared type",
  ),
);
export const WriteCommand = Schema.Union([TypedWrite, CanonicalWrite, Write]);
export function normalizeTypedWrite(write: typeof TypedWrite.Type): typeof TypedWrite.Type {
  const upserts = write.upserts.map((document) => ({
    ...document,
    attributes: Object.fromEntries(
      Object.entries(document.attributes).toSorted(([left], [right]) =>
        compareFieldNames(left, right),
      ),
    ),
  }));
  const declaration = write.declaration;
  if (declaration === undefined) return { ...write, upserts };
  return {
    ...write,
    upserts,
    declaration: {
      ...declaration,
      columns: declaration.columns
        .map((column) => ({
          name: column.name,
          type: column.type,
          filterable: column.filterable === true,
          nullable: column.nullable === true,
        }))
        .toSorted((left, right) => compareFieldNames(left.name, right.name)),
    },
  };
}
export function hasTypedOperand(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTypedOperand);
  return typeof value === "object" && value !== null;
}
export const CanonicalDocumentMetadata = CanonicalDocument.mapFields((fields) =>
  Struct.omit(fields, ["vector"]),
);
export const CanonicalQueryDocument = CanonicalDocumentMetadata.mapFields((fields) => ({
  ...fields,
  vectorSummary: QueryDocument.fields.vectorSummary,
}));
export const TypedCanonicalDocument = CanonicalDocument.mapFields((fields) => ({
  ...fields,
  attributes: TypedAttributes,
}));
export const TypedCanonicalQueryDocument = CanonicalQueryDocument.mapFields((fields) => ({
  ...fields,
  attributes: TypedAttributes,
}));
export function nativeToCanonicalDocument(
  document: typeof Document.Type,
  revision: number,
): typeof CanonicalDocument.Type {
  return {
    id: document.id,
    revision,
    roles: { title: document.title ?? "", text: document.text },
    attributes: document.attributes,
    ...(document.vector !== undefined && { vector: document.vector }),
  };
}
export function canonicalToNativeDocument(
  document: typeof CanonicalDocument.Type,
): typeof StoredDocument.Type {
  return {
    id: nativeProjectionId(document.id),
    revision: document.revision,
    title: document.roles.title,
    text: document.roles.text,
    attributes: document.attributes,
    ...(document.vector !== undefined && { vector: document.vector }),
  };
}
export function canonicalToQueryRow(
  document: typeof CanonicalQueryDocument.Type | typeof TypedCanonicalQueryDocument.Type,
  score: number,
): typeof Row.Type {
  return {
    id: document.id,
    revision: document.revision,
    title: document.roles.title,
    text: document.roles.text,
    attributes: document.attributes,
    score,
  };
}
function nativeProjectionId(id: typeof CanonicalId.Type): typeof Id.Type {
  if (typeof id !== "string")
    throw new TypeError("Native document projection requires a string ID");
  return id;
}
export function readCanonicalColumn(
  document: typeof CanonicalDocument.Type,
  column: typeof DocumentColumnId.Type,
) {
  if (column.source === "attribute") return document.attributes[column.name];
  if (column.role === "vector") return document.vector;
  return document.roles[column.role];
}
const FilterOperand = Schema.Union([Scalar, TypedTag]);
export const Filter = Schema.Union([
  Schema.Struct({
    field: FieldName,
    op: Schema.Literals(["eq", "ne", "contains", "notContains"]),
    value: FilterOperand,
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literals(["gt", "gte", "lt", "lte"]),
    value: Schema.Union([Schema.Finite, Unicode, TypedTag]),
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literal("in"),
    value: Schema.Array(FilterOperand).check(Schema.isBetweenLength(1, 32)),
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literal("notIn"),
    value: Schema.Array(FilterOperand).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literals(["containsAny", "notContainsAny"]),
    value: Schema.Array(FilterOperand).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literal("exists"),
    value: Schema.Boolean,
  }),
]);
export const FieldBm25Parameters = Schema.Struct({
  k1: Schema.Finite.check(Schema.isGreaterThan(0)),
  b: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export const DEFAULT_FIELD_BM25 = { k1: 1.2, b: 0.75 } as const;
const SafeCount = Schema.Finite.check(
  Schema.makeFilter(
    (value) => Number.isSafeInteger(value) || "Expected a nonnegative safe integer",
  ),
  Schema.isGreaterThanOrEqualTo(0),
);
const TextColumnId = DocumentColumnId.check(
  Schema.makeFilter(
    (column) =>
      column.source === "attribute" || column.role !== "vector" || "Vector is not a text field",
  ),
);
export const FieldStatistics = Schema.Struct({
  id: TextColumnId,
  tokens: SafeCount,
  frequencies: Schema.Record(Unicode, SafeCount).check(
    Schema.makeFilter(
      (frequencies) => Object.keys(frequencies).length <= 512 || "Too many query term frequencies",
    ),
  ),
});
export const CorpusStatistics = Schema.Struct({
  documents: SafeCount,
  fields: Schema.Array(FieldStatistics).check(Schema.isMaxLength(66)),
});
export const FieldStatisticsQuery = Schema.Struct({
  fields: Schema.Array(TextColumnId).check(Schema.isBetweenLength(1, 66)),
  text: Unicode.check(Schema.isBetweenLength(1, 8192)),
  mode: Schema.Literals(["any", "all", "phrase"]),
  dead: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 }))).check(
      Schema.isMaxLength(100_000),
    ),
  ),
});
export const FieldQuery = FieldStatisticsQuery.mapFields((fields) => ({
  ...fields,
  top_k: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  filters: Schema.optional(Schema.Array(Filter).check(Schema.isMaxLength(64))),
  bm25: Schema.optional(FieldBm25Parameters),
  statistics: Schema.optional(CorpusStatistics),
}));
export const NamedTextField = Schema.Struct({
  name: FieldName,
  config: Schema.optional(WordV4Config),
});
export const FieldBuild = Schema.Struct({
  documents: Schema.Array(CanonicalDocument).check(Schema.isBetweenLength(1, 10_000)),
  text_fields: Schema.Array(NamedTextField).check(Schema.isMaxLength(64)),
  filterable: Schema.optional(Schema.Array(FieldName).check(Schema.isMaxLength(64))),
});
export const FieldRankHit = Schema.Struct({
  row: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  score: Schema.Finite,
});
const QueryFields = {
  consistency: Schema.optional(Schema.Literals(["strong", "edge-eventual"])),
  minimumSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  topK: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  filters: Schema.Array(Filter).check(Schema.isMaxLength(16)),
};
const TextFields = {
  text: Unicode.check(Schema.isBetweenLength(1, 8192)),
  match: Schema.optional(Schema.Literals(["any", "all", "phrase"])),
};
const VectorQueryFields = {
  ...QueryFields,
  topK: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
};
export const Query = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), ...TextFields, ...QueryFields }),
  Schema.Struct({ kind: Schema.Literal("vector"), vector: Vector, ...VectorQueryFields }),
  Schema.Struct({
    kind: Schema.Literal("hybrid"),
    ...TextFields,
    vector: Vector,
    ...VectorQueryFields,
  }),
]);
const RootFields = {
  collectionFence: Schema.optional(Schema.String.check(Schema.isUUID())),
  schema: Schema.optional(NamespaceSchema),
  version: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  head: Schema.Union([Schema.String, Schema.Null]),
  documents: Schema.Int,
  titleLength: Schema.Int,
  bodyLength: Schema.Int,
  vectorEpoch: Schema.String,
  vectorJobs: Schema.Array(Schema.Struct({ log: Schema.String, sequence: Schema.Int })),
  lastReceipt: Schema.Union([
    Schema.Struct({ requestId: Id, digest: Schema.String, sequence: Schema.Int }),
    Schema.Null,
  ]),
};
const LegacyInlineSegment = Schema.Struct({
  key: Schema.String,
  sequence: Schema.Int,
  headerBytes: Schema.Int,
  bytes: Schema.Int,
  count: Schema.Int,
  minimumId: Id,
  documentBloom: Schema.String,
  termBloom: Schema.String,
  dead: Schema.Array(Schema.Int),
  removedFrequencies: Schema.Record(Schema.String, Schema.Int),
  commonTerms: Schema.optional(Schema.suspend(() => LegacyCommonTerms)),
  commonProjection: Schema.optional(Schema.NullOr(Schema.suspend(() => CommonTermProjection))),
  commonLeaders: Schema.optional(Schema.suspend(() => LegacyCommonLeaders)),
  constantAttributes: Schema.optional(ConstantAttributes),
  eligibility: Schema.NullOr(Schema.suspend(() => EligibilityProjection)),
});
const BloomReference = Schema.Struct({
  packIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  row: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const LegacyPackedSegment = LegacyInlineSegment.mapFields((fields) => ({
  ...Struct.omit(fields, ["documentBloom", "termBloom"]),
  bloom: BloomReference,
}));
const PackedRootValue = Schema.Struct({
  ...RootFields,
  bloomPacks: Schema.Array(Schema.suspend(() => BloomPack)),
  segments: Schema.Array(LegacyPackedSegment),
});
const validBloomReferences = (root: {
  readonly bloomPacks: typeof PackedRootValue.Type.bloomPacks;
  readonly segments: ReadonlyArray<Pick<typeof LegacyPackedSegment.Type, "key" | "bloom">>;
}) =>
  root.segments.every(
    (segment) =>
      root.bloomPacks[segment.bloom.packIndex]?.segmentKeys[segment.bloom.row] === segment.key,
  ) || "Invalid segment Bloom reference";
export const LegacyPackedRoot = PackedRootValue.check(Schema.makeFilter(validBloomReferences));
const MetadataSegment = LegacyPackedSegment.mapFields((fields) => ({
  ...fields,
  metadataEnd: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}));
const validMetadataBoundary = (
  segment: Pick<typeof MetadataSegment.Type, "metadataEnd" | "headerBytes" | "bytes">,
) =>
  (segment.metadataEnd >= segment.headerBytes && segment.metadataEnd <= segment.bytes) ||
  "Invalid segment metadata boundary";
const CurrentMetadataSegment = MetadataSegment.mapFields((fields) => ({
  ...fields,
  minimumId: CanonicalId,
  commonTerms: Schema.optional(Schema.suspend(() => CommonTerms)),
  commonLeaders: Schema.optional(Schema.suspend(() => CommonLeaders)),
}));
export const Root = PackedRootValue.mapFields((fields) => ({
  ...fields,
  schema: Schema.optional(NamespaceColumns),
  idType: Schema.optional(IdType),
  segments: Schema.Array(CurrentMetadataSegment.check(Schema.makeFilter(validMetadataBoundary))),
})).check(
  Schema.makeFilter(validBloomReferences),
  Schema.makeFilter((root) => {
    const valid = (id: typeof CanonicalId.Type) =>
      canonicalIdType(id) === (root.idType ?? "string");
    return (
      root.segments.every(
        (segment) =>
          valid(segment.minimumId) &&
          (segment.commonLeaders ?? []).every((leader) =>
            leader.documents.every((document) => valid(document.id)),
          ) &&
          Object.values(segment.commonTerms ?? {}).every(
            (term) => term.single === undefined || valid(term.single.id),
          ),
      ) || "Root metadata ID type differs from namespace policy"
    );
  }),
);
export const UnpackedSegment = Root.fields.segments.value
  .mapFields((fields) => Struct.omit(fields, ["bloom"]))
  .check(Schema.makeFilter(validMetadataBoundary));
export const LegacyInlineRoot = Schema.Struct({
  ...RootFields,
  segments: Schema.Array(LegacyInlineSegment),
});
export const ConvertedInlineRoot = LegacyInlineRoot.mapFields((fields) => ({
  ...fields,
  segments: Schema.Array(
    fields.segments.value
      .mapFields((segment) => ({
        ...segment,
        metadataEnd: MetadataSegment.fields.metadataEnd,
      }))
      .check(Schema.makeFilter(validMetadataBoundary)),
  ),
}));
export const Snapshot = Schema.Struct({
  observedAt: Schema.Finite,
  manifest: Root,
});
export const SnapshotFrameMetadata = Schema.Struct({
  observedAt: Snapshot.fields.observedAt,
  sequence: Root.fields.sequence,
});
export const SnapshotCacheHeaders = Schema.Struct({
  "x-raio-observed-at": Schema.NumberFromString.check(Schema.isFinite()),
  "x-raio-sequence": Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
});
export const VectorRebuildSnapshot = Schema.Struct({ root: Root, fields: VectorFilterFields });
export const VectorRebuild = Schema.Struct({
  snapshot: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))),
  segment: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  row: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).check(
  Schema.makeFilter((cursor) => {
    if (cursor.snapshot === undefined)
      return (
        (cursor.segment === undefined && cursor.row === undefined) || "Cursor requires a snapshot"
      );
    return (
      (cursor.segment !== undefined && cursor.row !== undefined) || "Incomplete rebuild cursor"
    );
  }),
);
export const VectorRebuildResult = Schema.Struct({
  snapshot: Schema.Union([Schema.String, Schema.Null]),
  segment: Schema.Int,
  row: Schema.Int,
  submitted: Schema.Int,
  complete: Schema.Boolean,
});
export const Collection = Schema.Struct({
  cursor: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 4096))),
});
export const CollectionCursor = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["bloom-packs", "segments"]),
  cursor: Schema.NullOr(Schema.String.check(Schema.isBetweenLength(1, 4096))),
});
export const Retirement = Schema.Struct({
  key: Schema.String,
  etag: Schema.String,
  observedAt: Schema.Finite,
});
export const CollectionResult = Schema.Struct({
  cursor: Schema.Union([Schema.String, Schema.Null]),
  scanned: Schema.Int,
  pinned: Schema.Int,
  marked: Schema.Int,
  deleted: Schema.Int,
  expiredSnapshots: Schema.Int,
});
export const NamespacePage = Schema.Struct({
  names: Schema.Array(NamespaceName),
  cursor: Schema.Union([Schema.String, Schema.Null]),
});
const namespacePageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
export const NamespacesInput = Schema.Struct({
  page_size: Schema.optional(namespacePageSize),
  prefix: Schema.optional(Unicode),
  cursor: Schema.optional(Schema.String),
});
export const NamespacesQuery = NamespacesInput.mapFields((fields) => ({
  ...fields,
  page_size: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9]+$/)).pipe(
      Schema.decodeTo(Schema.FiniteFromString.pipe(Schema.decodeTo(namespacePageSize))),
    ),
  ),
}));
export const NamespacesPage = Schema.Struct({
  namespaces: Schema.Array(Schema.Struct({ id: NamespaceName })),
  next_cursor: Schema.optional(Schema.String),
});
export const NamespaceCatalogActivation = Schema.Struct({ version: Schema.Literal(1) });
export const NamespaceListCursor = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        version: Schema.Literal(1),
        bucket: Schema.String,
        prefix: Unicode,
        cursor: Schema.String,
      }),
    ),
  ),
);
const NativeLog = Schema.Struct({
  version: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  previous: Schema.Union([Schema.String, Schema.Null]),
  digest: Schema.String,
  vectorEpoch: Schema.String,
  vectorDeletes: Schema.Array(Schema.String),
  write: Write,
});
export const Log = Schema.Union([
  NativeLog,
  NativeLog.mapFields((fields) => ({
    ...fields,
    version: Schema.Literal(2),
    write: CanonicalWrite,
  })),
  NativeLog.mapFields((fields) => ({
    ...fields,
    version: Schema.Literal(3),
    write: TypedWrite,
  })),
]);
export const Row = Schema.Struct({
  id: CanonicalId,
  title: Schema.String,
  text: Schema.String,
  attributes: Schema.Union([Attributes, TypedAttributes]),
  revision: Schema.Int,
  score: Schema.Finite,
});
export const QueryResult = Schema.Struct({
  rows: Schema.Array(Row),
  sequence: Schema.Int,
  consistency: Schema.Literals(["strong", "edge-eventual"]),
});
export const WriteResult = Schema.Struct({
  sequence: Schema.Int,
  requestId: Id,
  vectorSync: Schema.Literal("queued"),
});
export const ErrorBody = Schema.Struct({ status: Schema.Literal("error"), error: Schema.String });
export const CacheMetrics = Schema.Struct({
  rangeCacheBytes: Schema.Int,
  rangeCacheChargedBytes: Schema.Int,
  postingCacheBytes: Schema.Int,
  directoryCacheChargedBytes: Schema.Int,
  scoreBoundCacheChargedBytes: Schema.Int,
  scoreBoundCacheEntries: Schema.Int,
  textPlanCacheChargedBytes: Schema.Int,
  textPlanCacheEntries: Schema.Int,
  textPlanCacheHits: Schema.Int,
  encodedDirectoryCacheChargedBytes: Schema.Int,
  encodedDirectoryAdmissionChargedBytes: Schema.Int,
  encodedDirectoryCacheEntries: Schema.Int,
  bloomCacheBytes: Schema.Int,
  bloomR2Reads: Schema.Int,
  bloomR2Bytes: Schema.Int,
  termCacheBytes: Schema.Int,
  overviewCacheBytes: Schema.Int,
  overviewMemoryHits: Schema.Int,
  overviewCacheApiHits: Schema.Int,
  overviewCacheApiLookups: Schema.Int,
  overviewBuilds: Schema.Int,
  correlatedReads: Schema.Int,
  correlatedHits: Schema.Int,
  correlatedBytes: Schema.Int,
  termReads: Schema.Int,
  termRequests: Schema.Int,
  termBytes: Schema.Int,
  termMemoryHits: Schema.Int,
  termWorkerCacheHits: Schema.Int,
  rangeReads: Schema.Int,
  rangeCacheTimeouts: Schema.Int,
  rangeR2FallbackReads: Schema.Int,
  rangeR2FallbackBytes: Schema.Int,
  directoryCacheTimeouts: Schema.Int,
  directoryR2FallbackReads: Schema.Int,
  directoryR2FallbackBytes: Schema.Int,
  directoryR2CacheReads: Schema.Int,
  directoryR2CacheHits: Schema.Int,
  directoryR2CacheBytes: Schema.Int,
  directoryR2CacheRejected: Schema.Int,
  directoryR2CacheTimeouts: Schema.Int,
  directoryR2CachePublications: Schema.Int,
  directoryR2CacheOriginResponses: Schema.Int,
  rangeBytes: Schema.Int,
  rangeCacheHits: Schema.Int,
  directoryCacheHits: Schema.Int,
  directoryCommonHits: Schema.Int,
  encodedDirectoryCacheHits: Schema.Int,
  workerCacheHits: Schema.Int,
  workerCacheMisses: Schema.Int,
  cacheApiHits: Schema.Int,
});
export const Metadata = Schema.Struct({
  schema: Schema.NullOr(NamespaceSchema),
  columns: Schema.optional(NamespaceColumns),
  sequence: Schema.Int,
  documents: Schema.Int,
  segments: Schema.Int,
  manifestEncodedBytes: Schema.Int,
  wasmMemoryBytes: Schema.Int,
  vectorOutbox: Schema.Int,
  cache: CacheMetrics,
});
export const Health = Schema.Struct({
  snapshotMemoryChargedBytes: Schema.Int,
  snapshotPayloadRetainedBytes: Schema.Int,
  snapshotR2Reads: Schema.Int,
  snapshotR2BodyBytes: Schema.Int,
  snapshotRevalidations: Schema.Int,
  snapshotLateRetentions: Schema.Int,
  snapshotSharedReads: Schema.Int,
  snapshotCacheDecodes: Schema.Int,
  snapshotCacheRejected: Schema.Int,
  snapshotCachePutAttempts: Schema.Int,
  snapshotCachePutBytes: Schema.Int,
  snapshotCachePutSkipped: Schema.Int,
  name: Schema.Literal("kannin"),
  version: Schema.Literal("0.1.0"),
  engine: Schema.Literals(["rust-wasm-r2", "rust-wasm-object-storage"]),
  vectors: Schema.Literal("rust-wasm-object-storage"),
  wasmMemoryBytes: Schema.Int,
  ...CacheMetrics.fields,
});
export const Receipt = Schema.Struct({
  requestId: Id,
  digest: Schema.String,
  sequence: Schema.Int,
});
export const DataRange = Schema.Struct({ offset: Schema.Int, length: Schema.Int });
export const SegmentDocument = Schema.Struct({
  id: CanonicalId,
  revision: Schema.Int,
  title_length: Schema.Int,
  body_length: Schema.Int,
  attributes: Schema.Union([Attributes, TypedAttributes]),
  data: DataRange,
  vector: Schema.Boolean,
});
export const SegmentBlock = Schema.Struct({
  first: Schema.Int,
  last: Schema.Int,
  count: Schema.Int,
  max_title_tf: Schema.Int,
  max_body_tf: Schema.Int,
  min_title_length: Schema.Int,
  min_body_length: Schema.Int,
  data: DataRange,
});
export const SegmentTerm = Schema.Struct({ df: Schema.Int, blocks: Schema.Array(SegmentBlock) });
export const SegmentTerms = Schema.Record(Schema.String, SegmentTerm);
export const PostingSpans = Schema.Array(
  Schema.Struct({ term: Schema.String, blocks: Schema.NonEmptyArray(SegmentBlock) }),
);
export const EligibleMinimum = Schema.Union([
  Schema.Null,
  Schema.Tuple([
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 })),
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 })),
  ]),
]);
const TermDocument = Schema.Struct({
  row: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 })),
  id: CanonicalId,
  data: DataRange,
});
export const TermSummary = Schema.Struct({
  single: Schema.optional(TermDocument),
  df: SegmentTerm.fields.df,
  bounds: Schema.Array(
    Schema.Tuple([
      SegmentBlock.fields.max_title_tf,
      SegmentBlock.fields.max_body_tf,
      SegmentBlock.fields.min_title_length,
      SegmentBlock.fields.min_body_length,
    ]),
  ),
});
export const TermSummaries = Schema.Record(Schema.String, TermSummary);
export const CommonLeaders = Schema.Array(
  Schema.Struct({
    field: Schema.Literals(["title", "body"]),
    terms: Schema.Array(Unicode.check(Schema.isBetweenLength(1, 64))).check(
      Schema.isBetweenLength(1, 16),
    ),
    length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 })),
    longer: Schema.Boolean,
    documents: Schema.Array(TermDocument).check(Schema.isMaxLength(16)),
  }),
).check(Schema.isMaxLength(2));
export const CommonTerms = Schema.Record(
  Schema.String.check(Schema.isMaxLength(64)),
  TermSummary.check(
    Schema.makeFilter(
      (summary) =>
        (summary.df > 1 && summary.df <= 10000 && summary.bounds.length === 1) ||
        "Invalid common-term summary",
    ),
  ),
).check(Schema.isMaxProperties(16));
const LegacyTermDocument = TermDocument.mapFields((fields) => ({ ...fields, id: Id }));
const LegacyTermSummary = TermSummary.mapFields((fields) => ({
  ...fields,
  single: Schema.optional(LegacyTermDocument),
}));
const LegacyCommonTerms = Schema.Record(CommonTerms.key, LegacyTermSummary).check(
  Schema.makeFilter((value) => Schema.is(CommonTerms)(value) || "Invalid legacy common terms"),
);
const LegacyCommonLeaders = Schema.Array(
  CommonLeaders.value.mapFields((fields) => ({
    ...fields,
    documents: Schema.Array(LegacyTermDocument).check(Schema.isMaxLength(16)),
  })),
).check(Schema.isMaxLength(2));
const CommonTermBound = TermSummary.fields.bounds.value.check(
  Schema.makeFilter(
    (bound) =>
      (bound.every((value) => value >= 0 && value <= 4294967295) &&
        (bound[0] > 0 || bound[1] > 0)) ||
      "Invalid common-term bound",
  ),
);
const CommonTermProjectionValue = Schema.Struct({
  terms: Schema.Array(CommonTerms.key).check(
    Schema.isBetweenLength(1, 16),
    Schema.makeFilter((terms) => new Set(terms).size === terms.length || "Duplicate common term"),
  ),
  partitions: Schema.Array(
    Schema.Array(Schema.NullOr(CommonTermBound)).check(Schema.isBetweenLength(1, 16)),
  ).check(Schema.isBetweenLength(1, 32)),
  independent: Schema.Array(
    Schema.Array(CommonTermBound).check(Schema.isBetweenLength(1, 128)),
  ).check(Schema.isBetweenLength(1, 16)),
}).check(
  Schema.makeFilter(
    (projection) =>
      (projection.independent.length === projection.terms.length &&
        projection.partitions.every((row) => row.length === projection.terms.length) &&
        projection.terms.every((_term, index) =>
          projection.partitions.some((row) => row[index] !== null),
        )) ||
      "Incomplete common-term projection",
  ),
);
const encodeCommonTermProjection = Schema.encodeSync(
  Schema.fromJsonString(CommonTermProjectionValue),
  { disableChecks: true },
);
const emptyCommonTermProjectionBytes = encodeCommonTermProjection({
  terms: [],
  partitions: [],
  independent: [],
}).length;
const commonTermBoundBytes = (bound: typeof CommonTermBound.Type) =>
  bound.reduce((bytes, value) => bytes + String(value).length + 1, 3);
export const CommonTermProjection = CommonTermProjectionValue.check(
  Schema.makeFilter((projection) => {
    const maximumBytes =
      emptyCommonTermProjectionBytes +
      projection.terms.reduce((bytes, term) => bytes + term.length * 6 + 3, 0) +
      projection.partitions.reduce(
        (bytes, row) =>
          bytes +
          row.reduce((total, bound) => {
            if (bound === null) return total + 5;
            return total + commonTermBoundBytes(bound);
          }, 3),
        0,
      ) +
      projection.independent.reduce(
        (bytes, row) =>
          bytes + row.reduce((total, bound) => total + commonTermBoundBytes(bound), 3),
        0,
      );
    if (maximumBytes <= 4096) return true;
    return (
      textEncoder.encode(encodeCommonTermProjection(projection)).byteLength <= 4096 ||
      "Common-term projection exceeds 4096 bytes"
    );
  }),
);
const BloomOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BloomColumn = Schema.Struct({
  offset: BloomOffset,
  length: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16 * 1024 * 1024)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  offsets: Schema.Array(BloomOffset).check(Schema.isBetweenLength(2, 65)),
}).check(
  Schema.makeFilter(
    (column) =>
      (column.offsets[0] === 0 &&
        column.offsets[column.offsets.length - 1] === column.length &&
        column.offsets.every((offset, index) => {
          const previous = column.offsets[index - 1];
          return (
            previous === undefined ||
            (offset - previous >= 8 && offset - previous <= 16 * 1024 * 1024)
          );
        })) ||
      "Invalid Bloom column offsets",
  ),
);
export const BloomPack = Schema.Struct({
  key: Schema.String.check(
    Schema.isPattern(
      /^namespaces\/[A-Za-z0-9_.-]{1,128}\/bloom-packs\/[a-f0-9]{64}(?:-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?\.bin$/,
    ),
  ),
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(32 * 1024 * 1024)),
  segmentKeys: Schema.Array(Schema.suspend(() => SegmentRange.fields.key)).check(
    Schema.isBetweenLength(1, 64),
    Schema.makeFilter((keys) => new Set(keys).size === keys.length || "Duplicate Bloom pack key"),
  ),
  document: BloomColumn,
  term: BloomColumn,
}).check(
  Schema.makeFilter(
    (pack) =>
      (pack.document.offset === 0 &&
        pack.term.offset === pack.document.length &&
        pack.term.offset + pack.term.length === pack.bytes &&
        pack.segmentKeys.every((key) =>
          key.startsWith(`${pack.key.split("/bloom-packs/")[0]}/segments/`),
        ) &&
        pack.document.offsets.length === pack.segmentKeys.length + 1 &&
        pack.term.offsets.length === pack.segmentKeys.length + 1) ||
      "Invalid Bloom pack layout",
  ),
);
const PackedStoredRoot = LegacyPackedRoot.mapFields((fields) => ({
  ...fields,
  version: Schema.Literal(4),
  commonProjections: Schema.Array(CommonTermProjection),
  commonTermDictionaries: Schema.Array(LegacyCommonTerms),
  eligibilityModels: Schema.Array(Schema.suspend(() => EligibilityProjection)),
  segments: Schema.Array(
    fields.segments.value.mapFields((segment) => ({
      ...Struct.omit(segment, ["commonProjection", "commonTerms", "eligibility"]),
      eligibilityIndex: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      commonProjectionIndex: Schema.optional(
        Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      ),
      commonTermsIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    })),
  ),
}));
const validStoredRootMetadata = (root: {
  readonly bloomPacks: typeof PackedStoredRoot.Type.bloomPacks;
  readonly segments: ReadonlyArray<
    Pick<
      (typeof PackedStoredRoot.Type.segments)[number],
      "key" | "bloom" | "commonProjectionIndex" | "commonTermsIndex" | "eligibilityIndex"
    >
  >;
  readonly commonProjections: ReadonlyArray<unknown>;
  readonly commonTermDictionaries: ReadonlyArray<unknown>;
  readonly eligibilityModels: ReadonlyArray<unknown>;
}) => {
  const packedSegmentKeys = root.bloomPacks.flatMap((pack) => pack.segmentKeys);
  return (
    (new Set(packedSegmentKeys).size === packedSegmentKeys.length &&
      root.segments.every(
        (segment) =>
          root.bloomPacks[segment.bloom.packIndex]?.segmentKeys[segment.bloom.row] ===
            segment.key &&
          (segment.commonProjectionIndex === undefined ||
            segment.commonProjectionIndex === null ||
            segment.commonProjectionIndex < root.commonProjections.length) &&
          (segment.commonTermsIndex === undefined ||
            segment.commonTermsIndex < root.commonTermDictionaries.length) &&
          (segment.eligibilityIndex === null ||
            segment.eligibilityIndex < root.eligibilityModels.length),
      )) ||
    "Invalid Root metadata reference"
  );
};
export const LegacyStoredRootV4 = PackedStoredRoot.check(
  Schema.makeFilter(validStoredRootMetadata),
);
export const LegacyStoredRootV5 = PackedStoredRoot.mapFields((fields) => ({
  ...fields,
  version: Schema.Literal(5),
  segments: Schema.Array(
    fields.segments.value
      .mapFields((segment) => ({
        ...segment,
        metadataEnd: MetadataSegment.fields.metadataEnd,
      }))
      .check(Schema.makeFilter(validMetadataBoundary)),
  ),
})).check(Schema.makeFilter(validStoredRootMetadata));
export const LegacyStoredRootV6 = LegacyStoredRootV5.mapFields((fields) => ({
  ...fields,
  version: Schema.Literal(6),
  schema: Schema.optional(NamespaceColumns),
})).check(
  Schema.makeFilter(validStoredRootMetadata),
  Schema.makeFilter(
    (root) => !isTypedNamespace(root.schema) || "Typed declarations require StoredRoot 8",
  ),
);
const StoredRootV7Value = LegacyStoredRootV6.mapFields((fields) => ({
  ...fields,
  version: Schema.Literal(7),
  idType: Schema.optional(IdType),
  commonTermDictionaries: Schema.Array(CommonTerms),
  segments: Schema.Array(
    fields.segments.value
      .mapFields((segment) => ({
        ...segment,
        minimumId: CanonicalId,
        commonLeaders: Schema.optional(CommonLeaders),
      }))
      .check(Schema.makeFilter(validMetadataBoundary)),
  ),
}));
const validStoredIdPolicy = (
  root: Pick<typeof StoredRootV7Value.Type, "idType" | "segments" | "commonTermDictionaries">,
) => {
  const valid = (id: typeof CanonicalId.Type) => canonicalIdType(id) === (root.idType ?? "string");
  return (
    (root.segments.every(
      (segment) =>
        valid(segment.minimumId) &&
        (segment.commonLeaders ?? []).every((leader) =>
          leader.documents.every((document) => valid(document.id)),
        ),
    ) &&
      root.commonTermDictionaries.every((dictionary) =>
        Object.values(dictionary).every(
          (term) => term.single === undefined || valid(term.single.id),
        ),
      )) ||
    "Stored Root metadata ID type differs from namespace policy"
  );
};
export const LegacyStoredRootV7 = StoredRootV7Value.check(
  Schema.makeFilter(validStoredRootMetadata),
  Schema.makeFilter(validStoredIdPolicy),
  Schema.makeFilter(
    (root) => !isTypedNamespace(root.schema) || "Typed declarations require StoredRoot 8",
  ),
);
export const StoredRoot = StoredRootV7Value.mapFields((fields) => ({
  ...fields,
  version: Schema.Literal(8),
})).check(Schema.makeFilter(validStoredRootMetadata), Schema.makeFilter(validStoredIdPolicy));
export const StoredVectorRebuildSnapshot = VectorRebuildSnapshot.mapFields((fields) => ({
  ...fields,
  root: StoredRoot,
}));
const LegacyRootV1WithoutEligibility = LegacyInlineRoot.mapFields((fields) => ({
  ...fields,
  segments: Schema.Array(
    fields.segments.value.mapFields((segment) => Struct.omit(segment, ["eligibility"])),
  ),
}));
export const LegacyRoot = LegacyRootV1WithoutEligibility;
export const LegacyStoredRootV3 = LegacyInlineRoot.mapFields((fields) => ({
  ...fields,
  version: Schema.Literal(3),
  commonProjections: Schema.Array(CommonTermProjection),
  commonTermDictionaries: Schema.Array(LegacyCommonTerms),
  eligibilityModels: Schema.Array(Schema.suspend(() => EligibilityProjection)),
  segments: Schema.Array(
    fields.segments.value.mapFields((segment) => ({
      ...Struct.omit(segment, ["commonProjection", "commonTerms", "eligibility"]),
      eligibilityIndex: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      commonProjectionIndex: Schema.optional(
        Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      ),
      commonTermsIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    })),
  ),
})).check(
  Schema.makeFilter(
    (root) =>
      root.segments.every(
        (segment) =>
          (segment.commonProjectionIndex === undefined ||
            segment.commonProjectionIndex === null ||
            segment.commonProjectionIndex < root.commonProjections.length) &&
          (segment.commonTermsIndex === undefined ||
            segment.commonTermsIndex < root.commonTermDictionaries.length) &&
          (segment.eligibilityIndex === null ||
            segment.eligibilityIndex < root.eligibilityModels.length),
      ) || "Invalid legacy shared manifest metadata reference",
  ),
);
export const LegacyStoredRoot = LegacyStoredRootV3.mapFields((fields) => ({
  ...Struct.omit(fields, ["eligibilityModels"]),
  version: Schema.Literal(2),
  segments: Schema.Array(
    fields.segments.value.mapFields((segment) => Struct.omit(segment, ["eligibilityIndex"])),
  ),
})).check(
  Schema.makeFilter(
    (root) =>
      root.segments.every(
        (segment) =>
          (segment.commonProjectionIndex === undefined ||
            segment.commonProjectionIndex === null ||
            segment.commonProjectionIndex < root.commonProjections.length) &&
          (segment.commonTermsIndex === undefined ||
            segment.commonTermsIndex < root.commonTermDictionaries.length),
      ) || "Invalid legacy shared manifest metadata reference",
  ),
);
export const RootMigrationInput = Schema.Union([
  LegacyRoot,
  LegacyInlineRoot,
  LegacyStoredRoot,
  LegacyStoredRootV3,
  LegacyStoredRootV4,
  LegacyStoredRootV5,
  LegacyStoredRootV6,
  LegacyStoredRootV7,
  StoredRoot,
]);
export const VectorRebuildSnapshotMigrationInput = Schema.Union([
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyRoot })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyInlineRoot })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRoot })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV3 })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV4 })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV5 })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV6 })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV7 })),
  StoredVectorRebuildSnapshot,
]);
export const VECTOR_REBUILD_CHECKPOINT_BYTES = 8 * 1024 * 1024;
export const VectorRebuildCheckpointMetadata = Schema.Struct({
  expiresAt: Schema.NumberFromString.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export const TermProjection = Schema.Struct({
  dictionary: TermSummaries,
  partitions: Schema.NullOr(Schema.Array(TermSummaries).check(Schema.isBetweenLength(1, 32))),
});
export const CompactTermBounds = Schema.Array(
  Schema.Tuple([
    CommonTermProjection,
    Schema.Array(
      TermSummary.fields.df.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
    ).check(Schema.isBetweenLength(1, 16)),
  ]).check(
    Schema.makeFilter(
      ([projection, frequencies]) =>
        frequencies.length === projection.terms.length || "Misaligned compact term frequencies",
    ),
  ),
).check(Schema.isMaxLength(64));
const decodeEligibilityScalar = Schema.decodeExit(Schema.fromJsonString(Scalar));
const validatedEligibilityScalars = new Set<string>();
const EncodedEligibilityScalar = Schema.String.check(
  Schema.makeFilter((value) => {
    if (validatedEligibilityScalars.has(value)) return true;
    if (decodeEligibilityScalar(value)._tag !== "Success")
      return "Expected encoded attribute scalar";
    if (value.length <= 64) {
      if (validatedEligibilityScalars.size >= 256) {
        const oldest = validatedEligibilityScalars.values().next().value;
        if (oldest !== undefined) validatedEligibilityScalars.delete(oldest);
      }
      validatedEligibilityScalars.add(value);
    }
    return true;
  }),
);
const EligibilityProjectionValue = Schema.Struct({
  fields: NamespaceSchema.fields.filterable.check(
    Schema.makeFilter(
      (fields) =>
        fields.every((field, index) => {
          const previous = fields[index - 1];
          return previous === undefined || compareFieldNames(previous, field) < 0;
        }) || "Eligibility fields must be sorted and unique",
    ),
  ),
  data: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("joint"),
      groups: Schema.Array(
        Schema.Tuple([
          Schema.Array(Schema.Array(EncodedEligibilityScalar).check(Schema.isMaxLength(1))).check(
            Schema.isMaxLength(64),
          ),
          EligibleMinimum.members[1].elements[0],
          EligibleMinimum.members[1].elements[1],
        ]),
      ).check(Schema.isBetweenLength(1, 256)),
    }),
    Schema.Struct({
      kind: Schema.Literal("marginal"),
      columns: Schema.Array(
        Schema.Array(
          Schema.Tuple([
            Schema.NullOr(EncodedEligibilityScalar),
            EligibleMinimum.members[1].elements[0],
            EligibleMinimum.members[1].elements[1],
          ]),
        ).check(Schema.isBetweenLength(1, 256)),
      ).check(Schema.isBetweenLength(1, 64)),
    }),
  ]),
});
const encodeEligibilityProjection = Schema.encodeSync(
  Schema.fromJsonString(EligibilityProjectionValue),
);
export const EligibilityProjection = EligibilityProjectionValue.check(
  Schema.makeFilter((model) => {
    if (model.fields.length === 0) return "Eligibility projection requires a field";
    if (model.data.kind === "joint")
      return (
        model.data.groups.every(([values]) => values.length === model.fields.length) ||
        "Eligibility projection omitted a field"
      );
    return (
      (model.data.columns.length === model.fields.length &&
        model.data.columns.reduce((total, column) => total + column.length, 0) <= 256) ||
      "Eligibility projection omitted a field or exceeds its cell budget"
    );
  }),
  Schema.makeFilter(
    (model) =>
      textEncoder.encode(encodeEligibilityProjection(model)).byteLength <= 4096 ||
      "Eligibility projection exceeds four KiB",
  ),
);
export const TermCatalog = TermProjection.mapFields((fields) => ({
  ...fields,
  minimum: EligibleMinimum,
}));
export const CompactMinimumTermBounds = Schema.Array(
  Schema.Tuple([...CompactTermBounds.value.elements, EligibleMinimum]).check(
    Schema.makeFilter(
      ([projection, frequencies]) =>
        frequencies.length === projection.terms.length || "Misaligned compact term frequencies",
    ),
  ),
).check(Schema.isMaxLength(64));
export const ProjectedTermCatalog = TermCatalog.mapFields((fields) => ({
  ...fields,
  eligibility: Schema.NullOr(EligibilityProjection),
}));
export const CatalogTelemetry = Schema.Struct({
  memoryHits: Schema.Int,
  overviewCacheHits: Schema.Int,
  overviewCacheLookups: Schema.Int,
  batchReads: Schema.Int,
  batchHits: Schema.Int,
  batchBytes: Schema.Int,
  batchMs: Schema.Finite,
  batchTimeouts: Schema.Int,
  r2Reads: Schema.Int,
  r2Peak: Schema.Int,
  r2Hits: Schema.Int,
  r2Bytes: Schema.Int,
  fallbackDirectories: Schema.Int,
  overviewCacheMs: Schema.Finite,
  r2Ms: Schema.Finite,
  projectMs: Schema.Finite,
  fallbackMs: Schema.Finite,
  publishMs: Schema.Finite,
  entryMs: Schema.Finite,
  totalMs: Schema.Finite,
});
export const TermCatalogBatch = Schema.Struct({
  filterDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  rootFallback: Schema.Boolean,
  catalogs: Schema.Array(
    TermProjection.mapFields((fields) => ({
      ...fields,
      selection: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("model"), eligibility: EligibilityProjection }),
        Schema.Struct({ kind: Schema.Literal("minimum"), minimum: EligibleMinimum }),
      ]),
    })),
  ).check(Schema.isBetweenLength(1, 16)),
}).check(
  Schema.makeFilter(
    (batch) =>
      batch.catalogs.some((catalog) => catalog.selection.kind === "minimum") ===
        (batch.filterDigest !== null) || "Exact term catalogs require a filter digest",
  ),
);
const OverviewSource = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((text) => text.replace(/[\r\n]/g, "")),
    encode: SchemaGetter.passthrough(),
  }),
)
  .check(
    Schema.makeFilter(
      (text) => (text.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(text)) || "Invalid Base64 source",
    ),
  )
  .pipe(
    Schema.decodeTo(Schema.Uint8Array, {
      decode: SchemaGetter.transformEffect((text) =>
        Effect.try({
          try: () => Uint8Array.fromBase64(text),
          catch: () => new SchemaIssue.InvalidValue({ expected: "a valid Base64 string" }, text),
        }),
      ),
      encode: SchemaGetter.transform((bytes) => bytes.toBase64()),
    }),
  );
export const OverviewBatch = Schema.Array(OverviewSource)
  .check(Schema.isBetweenLength(1, 16))
  .check(
    Schema.makeFilter(
      (sources) =>
        sources.reduce((total, bytes) => total + bytes.byteLength, 0) <= 3 * 1024 * 1024 ||
        "Overview batch exceeds three MiB",
    ),
  );
const SegmentTextCounts = {
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  terms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};
export const SegmentTextField = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["title", "text"]),
    name: Schema.Null,
    analysis: Schema.Null,
    ...SegmentTextCounts,
  }),
  Schema.Struct({
    kind: Schema.Literal("attribute"),
    name: FieldName,
    analysis: WordV4Config,
    ...SegmentTextCounts,
  }),
]);
export const SegmentTextFields = Schema.Array(SegmentTextField).check(
  Schema.isBetweenLength(2, 66),
  Schema.makeFilter((fields) => {
    if (fields[0]?.kind !== "title" || fields[1]?.kind !== "text")
      return "Native title and text fields must lead the text field table";
    const named = fields.slice(2);
    return (
      named.every((field, index) => {
        if (field.kind !== "attribute") return false;
        const previous = named[index - 1];
        return (
          previous === undefined ||
          (previous.kind === "attribute" && compareFieldNames(previous.name, field.name) < 0)
        );
      }) || "Named text fields must be distinct and strictly sorted"
    );
  }),
);
export const SegmentHeader = Schema.Struct({
  version: Schema.Literals([2, 3, 4, 5, 6]),
  documents: Schema.NonEmptyArray(SegmentDocument),
  terms: SegmentTerms,
  total_title_length: Schema.Int,
  total_body_length: Schema.Int,
  metadata_end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  vector_end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  vector_ranges: Schema.Array(DataRange),
});
export const LocatedDocument = Schema.Struct({
  row: Schema.Int,
  document: SegmentDocument,
  vectorData: Schema.NullOr(DataRange),
});
export const NativeVectorLocation = Schema.Struct({
  row: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: CanonicalId,
  data: DataRange,
  vectorData: DataRange,
});
export const NativeVectorPage = Schema.Struct({
  complete: Schema.Boolean,
  rows: Schema.Array(NativeVectorLocation).check(Schema.isMaxLength(64)),
});
export const SearchStatistics = Schema.Struct({
  documents: Schema.Int,
  title_length: Schema.Int,
  body_length: Schema.Int,
  frequencies: Schema.Record(Schema.String, Schema.Int),
});
export const RankingInput = Schema.Struct({
  text: Schema.String,
  mode: Schema.Literals(["any", "all", "phrase"]),
  top_k: Schema.Int,
  dead: Schema.Array(Schema.Int),
  filters: Schema.Array(Filter),
  statistics: SearchStatistics,
});
export const TextPlanIdentity = Schema.Struct({
  correlatedRoot: Schema.Boolean,
  text: RankingInput.fields.text,
  mode: RankingInput.fields.mode,
  filters: RankingInput.fields.filters,
  documents: Root.fields.documents,
  titleLength: Root.fields.titleLength,
  bodyLength: Root.fields.bodyLength,
  segments: Schema.Array(
    Schema.Struct({
      key: Root.fields.segments.value.fields.key,
      headerBytes: Root.fields.segments.value.fields.headerBytes,
      metadataEnd: Root.fields.segments.value.fields.metadataEnd,
      minimumId: Root.fields.segments.value.fields.minimumId,
      count: Root.fields.segments.value.fields.count,
      dead: Root.fields.segments.value.fields.dead,
      removedFrequencies: Root.fields.segments.value.fields.removedFrequencies,
    }),
  ),
});
export const SegmentScoreBound = Schema.Struct({
  bound: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  minimumId: Root.fields.segments.value.fields.minimumId,
});
export const TextPlan = Schema.Struct({
  statistics: SearchStatistics,
  segments: Schema.Array(
    Schema.Struct({
      ...SegmentScoreBound.fields,
      eligible: Schema.Boolean,
      maximumMatches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      singleton: Schema.optional(TermSummaries),
    }),
  ),
});
export const SharedTextPlan = Schema.Struct({
  identity: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  plan: TextPlan,
});
export const SharedTextPlanCacheHeaders = Schema.Struct({
  "content-length": Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 256 * 1024 }),
  ),
  "x-kannin-plan-bytes": Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 }),
  ),
});
export const SegmentHits = Schema.Array(
  Schema.Struct({ row: Schema.Int, id: CanonicalId, score: Schema.Finite, data: DataRange }),
);
export const VectorSyncResult = Schema.Struct({
  submitted: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
  visibility: Schema.Literal("strong"),
});
export const VectorMessage = Schema.Struct({
  namespace: NamespaceName,
  log: Schema.String,
  sequence: Schema.Int,
});
export const IndexMessage = Schema.Struct({ namespace: NamespaceName });
export const SegmentRange = Schema.Struct({
  key: Schema.String.check(
    Schema.isPattern(/^namespaces\/[A-Za-z0-9_.-]{1,128}\/segments\/[A-Za-z0-9-]+\.rsix$/),
  ),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16777216 })),
});
export const TermProjectionRange = Schema.Struct({
  key: SegmentRange.fields.key,
  headerBytes: SegmentRange.fields.length,
});
export const CorrelatedOverview = Schema.Struct({
  bucket: Schema.String,
  source: TermProjectionRange,
  overview: OverviewSource.check(
    Schema.makeFilter(
      (bytes) => bytes.byteLength <= 1024 * 1024 || "Correlated overview exceeds one MiB",
    ),
  ),
});
export const TermFilters = Schema.fromJsonString(QueryFields.filters);
export const TermFilterHeader = Schema.StringFromBase64.pipe(Schema.decodeTo(TermFilters));
export const TextTerms = Schema.Array(Schema.String).check(Schema.isMaxLength(512));
export const TermProjectionProps = Schema.Struct({
  bucket: Schema.String.check(Schema.isBetweenLength(1, 128)),
  terms: Schema.fromJsonString(TextTerms),
  prefixes: Schema.optional(Schema.Array(CommonTerms).check(Schema.isBetweenLength(1, 16))),
  selection: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("fields"),
      fields: EligibilityProjection.fields.fields.check(Schema.isMaxLength(16)),
    }),
    Schema.Struct({ kind: Schema.Literal("filters"), filters: TermFilters }),
  ]),
  ranges: Schema.Array(TermProjectionRange).check(Schema.isBetweenLength(1, 16)),
});
export const StoredOverviewBatch = Schema.Struct({
  bucket: TermProjectionProps.fields.bucket,
  ranges: TermProjectionProps.fields.ranges,
  overviews: OverviewBatch,
});
export const OverviewFrameMetadata = Schema.Struct({
  rawBytes: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 512 * 1024 }),
  ),
});
export const DirectoryCacheMiss = Schema.Literal("known");
export const SegmentCacheProps = Schema.Struct({
  bucket: TermProjectionProps.fields.bucket,
  format: Schema.Literal("compact-json-v2"),
});
export const NativeRankingInput = Schema.Struct({
  bucket: SegmentCacheProps.fields.bucket,
  query: Schema.Struct({
    text: TextFields.text,
    mode: RankingInput.fields.mode,
    top_k: QueryFields.topK,
    filters: QueryFields.filters,
    statistics: RankingInput.fields.statistics,
  }),
  segments: Schema.Array(
    Schema.Struct({
      key: Root.fields.segments.value.fields.key,
      headerBytes: Root.fields.segments.value.fields.headerBytes,
      bytes: Root.fields.segments.value.fields.bytes,
      dead: Root.fields.segments.value.fields.dead,
    }),
  ).check(Schema.isBetweenLength(1, 8)),
  cutoff: Schema.NullOr(Schema.Struct({ id: Row.fields.id, score: Row.fields.score })),
});
export const NativeRankingResult = Schema.Struct({
  segments: Schema.Array(SegmentHits).check(Schema.isBetweenLength(1, 8)),
  metrics: Schema.Struct({
    headerHits: Schema.Int,
    rangeHits: Schema.Int,
    sourceReads: Schema.Int,
    sourceBytes: Schema.Int,
    headerCacheBytes: Schema.Int,
    rangeCacheBytes: Schema.Int,
    prepareMs: Schema.Finite,
    acquireMs: Schema.Finite,
    decodeMs: Schema.Finite,
    scoreMs: Schema.Finite,
    spans: Schema.Int,
    ranges: Schema.Int,
    bytes: Schema.Int,
    blocks: Schema.Int,
  }),
});
export class Rejected extends Schema.TaggedError<Rejected, { readonly brand: unique symbol }>()(
  "Rejected",
  {
    status: Schema.Int,
    message: Schema.String,
    upstreamStatus: Schema.optional(Schema.Int),
    upstreamRay: Schema.optional(Schema.NullOr(Schema.String)),
  },
) {}

export const NativeVectorHits = Schema.Array(Schema.Tuple([CanonicalId, Schema.Finite])).check(
  Schema.isMaxLength(100),
);

export const CompactResult = Schema.Struct({
  compacted: Schema.Int,
  segments: Schema.Int,
  documents: Schema.optional(Schema.Int),
});
export const RebuildResult = Schema.Struct({
  sequence: Schema.Int,
  rebuilt: Schema.Literal(true),
});
export const CacheWarmHintResult = Schema.Struct({
  status: Schema.Literal("ACCEPTED"),
  message: Schema.optional(Unicode),
});
export const NamespaceRpcCommand = Schema.Union([
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("hint_cache_warm"),
    input: Schema.optional(Schema.Struct({})),
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("migrate-root"),
    input: Schema.optional(Schema.Struct({})),
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("write"),
    input: WriteCommand,
  }),
  Schema.Struct({ namespace: NamespaceName, operation: Schema.Literal("query"), input: Query }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("metadata"),
    input: Schema.optional(Schema.Struct({})),
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("compact"),
    input: Schema.optional(Schema.Struct({})),
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("collect"),
    input: Collection,
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("rebuild"),
    input: Schema.optional(Schema.Struct({})),
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("vector-sync"),
    input: Schema.optional(Schema.Struct({})),
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("vector-rebuild"),
    input: VectorRebuild,
  }),
]);
export const RpcCommand = Schema.Union([
  NamespaceRpcCommand,
  Schema.Struct({
    operation: Schema.Literal("namespaces"),
    input: Schema.optional(NamespacesInput),
  }),
]);
export const NamespaceCommand = Schema.Union([
  NamespaceRpcCommand,
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("internal-compact"),
    input: IndexMessage,
  }),
  Schema.Struct({
    namespace: NamespaceName,
    operation: Schema.Literal("internal-vector-sync"),
    input: VectorMessage,
  }),
]);
export const RootMigrationResult = Schema.Struct({
  version: Schema.Literal(8),
  sequence: Root.fields.sequence,
  rootRewritten: Schema.Boolean,
  migratedSnapshots: Schema.Int,
  expiredSnapshots: Schema.Int,
});
export const RpcValue = Schema.Union([
  CacheWarmHintResult,
  NamespacesPage,
  RootMigrationResult,
  QueryResult,
  WriteResult,
  Metadata,
  CompactResult,
  CollectionResult,
  RebuildResult,
  VectorSyncResult,
  VectorRebuildResult,
]);
export const RpcReply = Schema.Union([
  Schema.TaggedStruct("Success", { value: RpcValue }),
  Schema.TaggedStruct("Failure", { error: Rejected }),
]);

export const ObjectKey = Schema.String.check(Schema.isMinLength(1));
export const ObjectVersion = Schema.Struct({ etag: Schema.String.check(Schema.isMinLength(1)) });
export const ObjectMetadata = Schema.Struct({
  key: ObjectKey,
  etag: ObjectVersion.fields.etag,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  uploaded: Schema.Date,
  customMetadata: Schema.Record(Schema.String, Schema.String),
  sha256: Schema.optional(Schema.Uint8Array),
});
export const ObjectWriteCondition = Schema.Struct({
  ifMatch: Schema.optional(Schema.String),
  ifNoneMatch: Schema.optional(Schema.String),
  customMetadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  sha256: Schema.optional(Schema.Uint8Array),
  contentType: Schema.optional(Schema.String),
});
export class ObjectStoreFailure extends Schema.TaggedError<
  ObjectStoreFailure,
  { readonly brand: unique symbol }
>()("ObjectStoreFailure", {
  operation: Schema.Literals(["read", "write", "head", "list", "remove"]),
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

export const S3StoreConfig = Schema.Struct({
  bucket: Schema.String.check(Schema.isMinLength(1)),
  endpoint: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  region: Schema.String.check(Schema.isMinLength(1)),
  accessKeyId: Schema.Redacted(Schema.String),
  secretAccessKey: Schema.Redacted(Schema.String),
  urlStyle: Schema.optional(Schema.Literals(["path", "virtual"])),
});

export const ObjectReadOptions = Schema.Struct({
  range: Schema.optional(
    Schema.Struct({
      offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    }).check(
      Schema.makeFilter(
        (range) =>
          Number.isSafeInteger(range.offset + range.length) || "Range overflows integer precision",
      ),
    ),
  ),
});
export const ObjectContentRange = Schema.String.check(Schema.isPattern(/^bytes \d+-\d+\/\d+$/));

export const ObjectCatalogMetadata = ObjectMetadata.mapFields((fields) => ({
  ...fields,
  customMetadata: Schema.optional(fields.customMetadata),
}));
export const ObjectListInput = Schema.Struct({
  prefix: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  delimiter: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  includeMetadata: Schema.optional(Schema.Boolean),
});
export const ObjectPage = Schema.Union([
  Schema.Struct({
    objects: Schema.Array(ObjectCatalogMetadata),
    delimitedPrefixes: Schema.Array(Schema.String),
    truncated: Schema.Literal(true),
    cursor: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    objects: Schema.Array(ObjectCatalogMetadata),
    delimitedPrefixes: Schema.Array(Schema.String),
    truncated: Schema.Literal(false),
  }),
]);

export const ObjectUserMetadata = Schema.Record(Unicode, Unicode);
export const ObjectUserMetadataJson = Schema.fromJsonString(ObjectUserMetadata);

export const DeploymentTarget = Schema.Literals(["railway", "docker", "cloudflare"]);

export const ImmutableCacheName = Schema.Literals([
  "raio-segments-v1",
  "raio-overview-batches-v8",
  "kannin-text-plans-v1",
  "kannin-vectors-v2",
]);
export const CacheObjectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const CacheGeneration = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
export const CacheHeaders = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,128}$/)),
  Unicode.check(Schema.isMaxLength(8192)),
).check(
  Schema.makeFilter(
    (headers) => Object.keys(headers).length <= 64 || "Too many cached response headers",
  ),
  Schema.makeFilter(
    (headers) =>
      !["authorization", "cookie", "set-cookie", "proxy-authorization"].some(
        (name) => headers[name] !== undefined,
      ) || "Authenticated response headers cannot enter a shared cache",
  ),
);
export const CacheHeadersJson = Schema.fromJsonString(CacheHeaders);
export const CacheTtlSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 31536000 }),
);
export const CacheEntryBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 16 * 1024 * 1024 }),
);
export const CacheClientConfig = Schema.Struct({
  endpoint: S3StoreConfig.fields.endpoint,
  token: Schema.Redacted(Unicode.check(Schema.isMinLength(1))),
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 })),
  maxEntryBytes: CacheEntryBytes,
});
export const CacheServerConfig = Schema.Struct({
  token: CacheClientConfig.fields.token,
  host: Unicode.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  edgeEndpoint: S3StoreConfig.fields.endpoint,
  maxEntries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65536 })),
  maxMetadataBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
  ),
  maxStagingBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 * 1024 * 1024 })),
  maxEntryBytes: CacheEntryBytes,
  maxTtlSeconds: CacheTtlSeconds,
});
export const CacheDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export const CacheDeleteResultJson = Schema.fromJsonString(CacheDeleteResult);
export class CacheFailure extends Schema.TaggedError<
  CacheFailure,
  { readonly brand: unique symbol }
>()("CacheFailure", {
  operation: Schema.Literals(["initialize", "match", "put", "delete"]),
  cause: Schema.Defect(),
}) {}

export const PortableServerConfig = Schema.Struct({
  token: Schema.Redacted(Unicode.check(Schema.isMinLength(1))),
  host: Unicode.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  wasmPath: Unicode.check(Schema.isMinLength(1)),
  objectStore: S3StoreConfig,
  cache: Schema.optional(CacheClientConfig),
});

export const NativeJsonNumeric = Schema.declare<ReturnType<typeof JSON.rawJSON>>(
  (value): value is ReturnType<typeof JSON.rawJSON> =>
    JSON.isRawJSON(value) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.rawJSON),
);
