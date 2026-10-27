import { Schema } from "effect";
import {
  LocatedDocument,
  SegmentDocument,
  RankingInput,
  TermProjectionRange,
} from "../src/protocol";
export const DocumentDirectoryProbe = Schema.Struct({
  source: TermProjectionRange,
  ranking: RankingInput,
  ids: Schema.Array(Schema.String),
  dead: Schema.Array(Schema.Int),
  rows: Schema.Array(Schema.Int),
  saturate: Schema.Boolean,
});
export const DocumentDirectoryArm = Schema.Struct({
  source: TermProjectionRange,
  outcome: Schema.Literals(["present", "missing", "failure"]),
  holdGet: Schema.Boolean,
  holdUse: Schema.Boolean,
});
export const DocumentDirectoryProjection = Schema.Struct({
  partial: Schema.Boolean,
  lookup: Schema.Array(LocatedDocument),
  rows: Schema.Array(LocatedDocument),
  vectors: Schema.Array(SegmentDocument),
});
export const DocumentDirectoryResult = Schema.Struct({
  first: DocumentDirectoryProjection,
  second: DocumentDirectoryProjection,
  held: Schema.Int,
});

export const DocumentDirectoryState = Schema.Struct({
  key: Schema.String,
  segment: Schema.String,
  outcome: Schema.String,
  holdGet: Schema.Boolean,
  holdUse: Schema.Boolean,
  commonStarted: Schema.Int,
  commonFinished: Schema.Int,
  fullReads: Schema.Int,
  canonicalReads: Schema.Int,
  lookupStarted: Schema.Int,
  useStarted: Schema.Int,
});
