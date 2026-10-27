import { Schema, Struct } from "effect";
import { Root, DataRange, Row, QueryDocument } from "../src/protocol";
export const MetadataAcquisitionSource = Schema.Struct(
  Struct.pick(Root.fields.segments.value.fields, ["key", "headerBytes", "bytes", "metadataEnd"]),
);
export const MetadataAcquisitionLocations = Schema.Array(
  Schema.Tuple([MetadataAcquisitionSource, DataRange, Row.fields.score]),
);
export const MetadataAcquisitionHitProbe = Schema.Struct({
  locations: MetadataAcquisitionLocations,
  clear: Schema.Boolean,
});
export const MetadataAcquisitionPageProbe = Schema.Struct({
  source: MetadataAcquisitionSource,
  pages: Schema.Array(DataRange),
  payload: Schema.optional(Schema.Array(Schema.Int)),
  payloadOffset: Schema.Literals(["normal", "nan", "fraction", "infinity"]),
  clear: Schema.Boolean,
});
export const MetadataAcquisitionHitResult = Schema.Array(Row);
export const MetadataAcquisitionPageResult = Schema.Array(QueryDocument);
export const MetadataAcquisitionState = Schema.Struct({
  active: Schema.Int,
  peak: Schema.Int,
  reads: Schema.Int,
  bytes: Schema.Int,
  lengths: Schema.Array(Schema.Int),
  wideKey: Schema.String,
  holdWide: Schema.Boolean,
  wideStarted: Schema.Int,
  wideFinished: Schema.Int,
});
