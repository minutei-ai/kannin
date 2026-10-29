import { Schema } from "effect";
import { crc32 } from "node:zlib";

const Range = Schema.Tuple([Schema.Int, Schema.Int]);
const Row = Schema.Tuple([
  Schema.String,
  Schema.Int,
  Schema.Record(Schema.String, Schema.Unknown),
  Range,
  Schema.Boolean,
]);
const Block = Schema.Tuple([
  Schema.Int,
  Schema.Int,
  Schema.Int,
  Schema.Int,
  Schema.Int,
  Schema.Int,
  Schema.Int,
  Range,
]);
const Term = Schema.Tuple([Schema.Int, Schema.Array(Block)]);
const Terms = Schema.Record(Schema.String, Term);
const Header = Schema.Tuple([
  Schema.Literal(4),
  Schema.Array(Row),
  Schema.Array(Schema.Unknown),
  Schema.Array(Terms),
  Schema.Int,
  Schema.Int,
  Schema.Array(Range),
]);
export const emptyStoredTermFixture: typeof Term.Type = [0, []];

export function mutateStoredHeaderFixture(
  source: Uint8Array,
  changes: {
    readonly documents?: (rows: ReadonlyArray<typeof Row.Type>) => ReadonlyArray<typeof Row.Type>;
    readonly terms?: (terms: typeof Terms.Type) => typeof Terms.Type;
  },
) {
  const length = new DataView(source.buffer, source.byteOffset).getUint32(8, true);
  const original = Schema.decodeSync(Schema.fromJsonString(Header))(
    new TextDecoder().decode(source.subarray(16, 16 + length)),
  );
  const [version, rows, fields, groups, metadataEnd, vectorEnd, vectors] = original;
  const changed = { rows, groups };
  if (changes.documents !== undefined) changed.rows = changes.documents(rows);
  if (changes.terms !== undefined) {
    const native = groups[0];
    if (native === undefined) throw new Error("Missing native posting group fixture");
    changed.groups = [changes.terms(native), ...groups.slice(1)];
  }
  const json = new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(Header))([
      version,
      changed.rows,
      fields,
      changed.groups,
      metadataEnd,
      vectorEnd,
      vectors,
    ]),
  );
  const frame = new Uint8Array(16 + json.byteLength);
  frame.set(source.subarray(0, 8));
  const view = new DataView(frame.buffer);
  view.setUint32(8, json.byteLength, true);
  view.setUint32(12, crc32(json), true);
  frame.set(json, 16);
  return frame;
}
