import { Effect, Schema } from "effect";
import {
  IdType,
  PublicColumnsInput,
  PublicRowsInput,
  PublicRowsRejection,
  TypedWriteDocuments,
} from "./protocol";
import type { CanonicalId, TypedCell } from "./protocol";
import { preparePublicAttributeDecoder } from "./public-cell";
import type { PublicAttributeDecoder, PublicCellDecoder } from "./public-cell";
import { decodePublicId } from "./public-id";
import { encodePublicSchema } from "./public-schema";

const RESERVED_ID = "id";
const decodeIdType = Schema.decodeUnknownEffect(IdType);
const decodeRows = Schema.decodeUnknownEffect(PublicRowsInput, { onExcessProperty: "error" });
const decodeColumns = Schema.decodeUnknownEffect(PublicColumnsInput, {
  onExcessProperty: "error",
});
const decodeDocuments = Schema.decodeEffect(TypedWriteDocuments, { onExcessProperty: "error" });

type Cell = typeof TypedCell.Type;
type Entry = readonly [string, Cell];
type Id = typeof CanonicalId.Type;

interface Prepared {
  readonly idType: typeof IdType.Type;
  readonly attributes: PublicAttributeDecoder;
}

const prepare = Effect.fn("kannin.public.prepareRows")(function* (
  idPolicy: unknown,
  declaration: unknown,
) {
  const idType = yield* decodeIdType(idPolicy);
  yield* encodePublicSchema(declaration);
  const attributes = yield* preparePublicAttributeDecoder(declaration);
  const prepared: Prepared = { idType, attributes };
  return prepared;
});

const document = (id: Id, entries: ReadonlyArray<Entry>) => ({
  id,
  roles: { title: "", text: "" },
  attributes: Object.fromEntries(entries),
});

const rowEntry = (attributes: PublicAttributeDecoder, name: string, value: unknown) =>
  Effect.gen(function* () {
    const decoder = yield* attributes.cell(name);
    const cell = yield* decoder(value);
    return [name, cell] as const;
  });

const decodeRow = (prepared: Prepared, row: Readonly<Record<string, unknown>>, index: number) =>
  Effect.gen(function* () {
    if (!Object.hasOwn(row, RESERVED_ID))
      return yield* new PublicRowsRejection({ reason: "missing-id", row: index });
    const id = yield* decodePublicId(prepared.idType, row[RESERVED_ID]);
    const entries = yield* Effect.forEach(
      Object.entries(row).filter(([name]) => name !== RESERVED_ID),
      ([name, value]) => rowEntry(prepared.attributes, name, value),
    );
    return document(id, entries);
  });

export const decodePublicRows = Effect.fn("kannin.public.decodeRows")(function* (
  idPolicy: unknown,
  declaration: unknown,
  input: unknown,
) {
  const prepared = yield* prepare(idPolicy, declaration);
  const rows = yield* decodeRows(input);
  const documents = yield* Effect.forEach(rows, (row, index) => decodeRow(prepared, row, index));
  return yield* decodeDocuments(documents);
});

interface Column {
  readonly name: string;
  readonly decoder: PublicCellDecoder;
  readonly values: ReadonlyArray<unknown>;
}

const prepareColumn = (
  attributes: PublicAttributeDecoder,
  ids: ReadonlyArray<unknown>,
  name: string,
  values: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const decoder = yield* attributes.cell(name);
    if (values.length !== ids.length)
      return yield* new PublicRowsRejection({ reason: "unequal-columns", field: name });
    const column: Column = { name, decoder, values };
    return column;
  });

export const decodePublicColumns = Effect.fn("kannin.public.decodeColumns")(function* (
  idPolicy: unknown,
  declaration: unknown,
  input: unknown,
) {
  const prepared = yield* prepare(idPolicy, declaration);
  const columns = yield* decodeColumns(input);
  const ids = columns[RESERVED_ID];
  if (ids === undefined) return yield* new PublicRowsRejection({ reason: "missing-id" });
  const attributes = yield* Effect.forEach(
    Object.entries(columns).filter(([name]) => name !== RESERVED_ID),
    ([name, values]) => prepareColumn(prepared.attributes, ids, name, values),
  );
  const documents = yield* Effect.forEach(ids, (rawId, index) =>
    Effect.gen(function* () {
      const id = yield* decodePublicId(prepared.idType, rawId);
      const entries = yield* Effect.forEach(attributes, (column) =>
        column
          .decoder(column.values[index])
          .pipe(Effect.map((cell) => [column.name, cell] as const)),
      );
      return document(id, entries);
    }),
  );
  return yield* decodeDocuments(documents);
});
