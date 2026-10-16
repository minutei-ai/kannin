import { Schema } from "effect";
import { SegmentRange, SegmentHeader, CacheMetrics } from "../src/protocol";

export const RangeProbeInput = Schema.Struct({
  ...SegmentRange.fields,
  preloadFrequency: Schema.optional(Schema.Boolean),
  decodeDirectory: Schema.optional(Schema.Boolean),
  evictionRanges: Schema.optional(Schema.Array(SegmentRange).check(Schema.isBetweenLength(1, 4))),
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
});
export const RangeProbeResult = Schema.Struct({
  postingBefore: Schema.Int,
  rangeBefore: CacheMetrics.fields.rangeCacheBytes,
  rangeChargedAfter: CacheMetrics.fields.rangeCacheChargedBytes,
  decodedDirectoryBytes: Schema.optional(Schema.Int),
  directoryCacheChargedBytes: CacheMetrics.fields.directoryCacheChargedBytes,
  encodedDirectoryCacheChargedBytes: CacheMetrics.fields.encodedDirectoryCacheChargedBytes,
  postingAfter: Schema.Int,
  rangeAfter: Schema.Int,
  reads: Schema.Int,
  bytes: Schema.Int,
  successes: Schema.Int,
  failures: Schema.Int,
  distinctBodies: Schema.Int,
  lengths: Schema.Array(Schema.Int),
});

export const DirectoryScanInput = Schema.Array(SegmentRange).check(Schema.isBetweenLength(1, 32));
export const DirectoryScanResult = Schema.Array(
  Schema.Struct({
    reads: CacheMetrics.fields.rangeReads,
    encodedDirectoryCacheEntries: CacheMetrics.fields.encodedDirectoryCacheEntries,
    encodedDirectoryAdmissionChargedBytes:
      CacheMetrics.fields.encodedDirectoryAdmissionChargedBytes,
    encodedDirectoryCacheChargedBytes: CacheMetrics.fields.encodedDirectoryCacheChargedBytes,
  }),
);

export const DirectoryAgingInput = Schema.Tuple([SegmentRange, SegmentRange]);
export const DecodedDirectoryScanResult = Schema.Array(
  Schema.Struct({
    hits: CacheMetrics.fields.directoryCacheHits,
    bytes: CacheMetrics.fields.directoryCacheChargedBytes,
    history: CacheMetrics.fields.encodedDirectoryAdmissionChargedBytes,
    metadata: Schema.Array(SegmentHeader.fields.terms),
  }),
);
export const DirectoryAgingResult = Schema.Struct({
  before: CacheMetrics.fields.encodedDirectoryAdmissionChargedBytes,
  after: CacheMetrics.fields.encodedDirectoryAdmissionChargedBytes,
  reads: CacheMetrics.fields.rangeReads,
  hits: CacheMetrics.fields.encodedDirectoryCacheHits,
});

export const DirectoryBudgetInput = Schema.Struct({
  ...SegmentRange.fields,
  count: RangeProbeInput.fields.count,
});
