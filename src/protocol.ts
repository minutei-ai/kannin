import { Schema } from "effect";

const Unicode = Schema.String.check(
  Schema.makeFilter((text) => text.isWellFormed() || "Expected well-formed Unicode"),
);
export const Id = Unicode.check(Schema.isBetweenLength(1, 128));
export const NamespaceName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
export const Operation = Schema.Literals([
  "write",
  "query",
  "metadata",
  "vector-sync",
  "vector-rebuild",
  "rebuild",
  "compact",
  "collect",
]);
export const Scalar = Schema.Union([Unicode, Schema.Finite, Schema.Boolean, Schema.Null]);
export const FieldName = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/));
export const Attributes = Schema.Record(FieldName, Scalar);
export const VectorFilterFields = Schema.Array(FieldName).check(
  Schema.isMaxLength(5),
  Schema.makeFilter(
    (fields) => new Set(fields).size === fields.length || "Duplicate indexed field",
  ),
);
export const Vector = Schema.Array(
  Schema.Finite.check(
    Schema.isBetween({ minimum: -3.4028234663852886e38, maximum: 3.4028234663852886e38 }),
  ),
).check(
  Schema.isBetweenLength(1, 4096),
  Schema.makeFilter(
    (values) =>
      values.some((value) => Math.fround(value) !== 0) ||
      "A cosine vector must have nonzero float32 magnitude",
  ),
);
export const Document = Schema.Struct({
  id: Id,
  title: Schema.optional(Unicode.check(Schema.isMaxLength(8192))),
  text: Unicode.check(Schema.isMaxLength(262144)),
  attributes: Attributes,
  vector: Schema.optional(Vector),
});
export const Write = Schema.Struct({
  requestId: Id,
  upserts: Schema.Array(Document).check(Schema.isMaxLength(1000)),
  deletes: Schema.Array(Id).check(Schema.isMaxLength(1000)),
  reset: Schema.optional(Schema.Boolean),
});
export const StoredDocument = Document.mapFields((fields) => ({ ...fields, revision: Schema.Int }));
export const Filter = Schema.Union([
  Schema.Struct({
    field: FieldName,
    op: Schema.Literals(["eq", "ne"]),
    value: Scalar,
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literals(["gt", "gte", "lt", "lte"]),
    value: Schema.Finite,
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literal("in"),
    value: Schema.Array(Scalar).check(Schema.isBetweenLength(1, 32)),
  }),
  Schema.Struct({
    field: FieldName,
    op: Schema.Literal("exists"),
    value: Schema.Boolean,
  }),
]);
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
export const Root = Schema.Struct({
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
  segments: Schema.Array(
    Schema.Struct({
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
    }),
  ),
});
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
export const Log = Schema.Struct({
  version: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  previous: Schema.Union([Schema.String, Schema.Null]),
  digest: Schema.String,
  vectorEpoch: Schema.String,
  vectorDeletes: Schema.Array(Schema.String),
  write: Write,
});
export const Row = Schema.Struct({
  id: Id,
  title: Schema.String,
  text: Schema.String,
  attributes: Attributes,
  revision: Schema.Int,
  score: Schema.Finite,
});
export const QueryResult = Schema.Struct({
  rows: Schema.Array(Row),
  sequence: Schema.Int,
  consistency: Schema.Literals(["strong", "edge-eventual", "vectorize-eventual"]),
});
export const WriteResult = Schema.Struct({
  sequence: Schema.Int,
  requestId: Id,
  vectorSync: Schema.Literal("queued"),
});
export const ErrorBody = Schema.Struct({ error: Schema.String });
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
  termCacheApiHits: Schema.Int,
  rangeReads: Schema.Int,
  rangeBytes: Schema.Int,
  rangeCacheHits: Schema.Int,
  directoryCacheHits: Schema.Int,
  encodedDirectoryCacheHits: Schema.Int,
  workerCacheHits: Schema.Int,
  workerCacheMisses: Schema.Int,
  cacheApiHits: Schema.Int,
});
export const Metadata = Schema.Struct({
  sequence: Schema.Int,
  documents: Schema.Int,
  segments: Schema.Int,
  manifestEncodedBytes: Schema.Int,
  vectorOutbox: Schema.Int,
  cache: CacheMetrics,
});
export const Health = Schema.Struct({
  snapshotMemoryChargedBytes: Schema.Int,
  snapshotPayloadRetainedBytes: Schema.Int,
  snapshotR2Reads: Schema.Int,
  snapshotR2BodyBytes: Schema.Int,
  snapshotRevalidations: Schema.Int,
  snapshotSharedReads: Schema.Int,
  snapshotCacheDecodes: Schema.Int,
  snapshotCacheRejected: Schema.Int,
  snapshotCachePutAttempts: Schema.Int,
  snapshotCachePutBytes: Schema.Int,
  snapshotCachePutSkipped: Schema.Int,
  name: Schema.Literal("kannin"),
  version: Schema.Literal("0.1.0"),
  engine: Schema.Literal("rust-wasm-r2"),
  vectors: Schema.Literal("cloudflare-vectorize"),
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
  id: Id,
  revision: Schema.Int,
  title_length: Schema.Int,
  body_length: Schema.Int,
  attributes: Attributes,
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
export const TermSummary = Schema.Struct({
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
export const TermProjection = Schema.Struct({
  dictionary: TermSummaries,
  partitions: Schema.NullOr(Schema.Array(TermSummaries).check(Schema.isBetweenLength(1, 32))),
});
export const TermCatalog = TermProjection.mapFields((fields) => ({
  ...fields,
  minimum: EligibleMinimum,
}));
export const CatalogTelemetry = Schema.Struct({
  memoryHits: Schema.Int,
  overviewCacheHits: Schema.Int,
  overviewCacheLookups: Schema.Int,
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
export const TermCatalogBatch = Schema.Array(TermCatalog).check(Schema.isBetweenLength(1, 16));
export const OverviewBatch = Schema.Array(Schema.Uint8ArrayFromBase64)
  .check(Schema.isBetweenLength(1, 16))
  .check(
    Schema.makeFilter(
      (sources) =>
        sources.reduce((total, bytes) => total + bytes.byteLength, 0) <= 3 * 1024 * 1024 ||
        "Overview batch exceeds three MiB",
    ),
  );
export const SegmentHeader = Schema.Struct({
  version: Schema.Literal(1),
  documents: Schema.NonEmptyArray(SegmentDocument),
  terms: SegmentTerms,
  total_title_length: Schema.Int,
  total_body_length: Schema.Int,
});
export const LocatedDocument = Schema.Struct({ row: Schema.Int, document: SegmentDocument });
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
      dead: Root.fields.segments.value.fields.dead,
      removedFrequencies: Root.fields.segments.value.fields.removedFrequencies,
    }),
  ),
});
export const TextPlan = Schema.Struct({
  statistics: SearchStatistics,
  segments: Schema.Array(
    Schema.Struct({
      bound: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      eligible: Schema.Boolean,
    }),
  ),
});
export const SharedTextPlan = Schema.Struct({
  identity: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  plan: TextPlan,
});
export const SegmentHits = Schema.Array(
  Schema.Struct({ row: Schema.Int, id: Id, score: Schema.Finite }),
);
export const VectorSyncResult = Schema.Struct({
  submitted: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
  visibility: Schema.Literal("vectorize-eventual"),
});
export const VectorMessage = Schema.Struct({
  namespace: NamespaceName,
  log: Schema.String,
  sequence: Schema.Int,
});
export const IndexMessage = Schema.Struct({ namespace: NamespaceName });
export const SegmentRange = Schema.Struct({
  key: Schema.String.check(
    Schema.isPattern(/^namespaces\/[A-Za-z0-9_-]+\/segments\/[A-Za-z0-9-]+\.rsix$/),
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
  overview: Schema.Uint8ArrayFromBase64.check(
    Schema.makeFilter(
      (bytes) => bytes.byteLength <= 1024 * 1024 || "Correlated overview exceeds one MiB",
    ),
  ),
});
export const TermProjectionProps = Schema.Struct({
  bucket: Schema.String.check(Schema.isBetweenLength(1, 63)),
  terms: Schema.fromJsonString(Schema.Array(Schema.String).check(Schema.isMaxLength(64))),
  filters: Schema.fromJsonString(Schema.Array(Filter).check(Schema.isMaxLength(16))),
  ranges: Schema.Array(TermProjectionRange).check(Schema.isBetweenLength(1, 16)),
});
export const SegmentCacheProps = Schema.Struct({ bucket: TermProjectionProps.fields.bucket });
export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  status: Schema.Int,
  message: Schema.String,
  upstreamStatus: Schema.optional(Schema.Int),
  upstreamRay: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export const VectorSelection = Schema.Struct({
  epoch: Root.fields.vectorEpoch,
  sequence: Root.fields.sequence,
  pending: Root.fields.vectorJobs,
  vector: Vector,
  filters: Schema.Array(Filter),
  fields: VectorFilterFields,
});
export const VectorCandidates = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    score: Schema.Finite,
    metadata: Schema.Struct({ id: Id, revision: Schema.Int }),
  }),
).check(Schema.isMaxLength(50));
