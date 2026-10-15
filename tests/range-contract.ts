import { Schema } from "effect";
import { SegmentRange } from "../src/protocol";

export const RangeProbeInput = Schema.Struct({
  ...SegmentRange.fields,
  preloadFrequency: Schema.optional(Schema.Boolean),
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
});
export const RangeProbeResult = Schema.Struct({
  postingBefore: Schema.Int,
  postingAfter: Schema.Int,
  rangeAfter: Schema.Int,
  reads: Schema.Int,
  bytes: Schema.Int,
  successes: Schema.Int,
  failures: Schema.Int,
  distinctBodies: Schema.Int,
  lengths: Schema.Array(Schema.Int),
});
