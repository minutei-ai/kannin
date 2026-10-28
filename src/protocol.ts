import { Effect, Schema, SchemaGetter, SchemaIssue, Struct } from "effect";

const Unicode = Schema.String.check(
  Schema.makeFilter((text) => text.isWellFormed() || "Expected well-formed Unicode"),
);
export const Id = Unicode.check(Schema.isBetweenLength(1, 128));
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
export const FieldName = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/));
export const Attributes = Schema.Record(FieldName, Scalar);
const textEncoder = new TextEncoder();
const encodeAttributes = Schema.encodeSync(Schema.fromJsonString(Attributes), {
  disableChecks: true,
});
export const ConstantAttributes = Attributes.check(
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
export const NamespaceSchema = Schema.Struct({
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
const MIN_VECTOR_DIMENSIONS = 1;
const MAX_VECTOR_DIMENSIONS = 4096;
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
export const Document = Schema.Struct({
  id: Id,
  title: Schema.optional(Unicode.check(Schema.isMaxLength(8192))),
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
  commonTerms: Schema.optional(Schema.suspend(() => CommonTerms)),
  commonProjection: Schema.optional(Schema.NullOr(Schema.suspend(() => CommonTermProjection))),
  commonLeaders: Schema.optional(Schema.suspend(() => CommonLeaders)),
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
const validBloomReferences = (root: typeof PackedRootValue.Type) =>
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
export const Root = PackedRootValue.mapFields((fields) => ({
  ...fields,
  segments: Schema.Array(MetadataSegment.check(Schema.makeFilter(validMetadataBoundary))),
})).check(Schema.makeFilter(validBloomReferences));
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
const TermDocument = Schema.Struct({
  row: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 })),
  id: Id,
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
  commonTermDictionaries: Schema.Array(CommonTerms),
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
const validStoredRootMetadata = (
  root: Pick<
    typeof PackedStoredRoot.Type,
    "bloomPacks" | "segments" | "commonProjections" | "commonTermDictionaries" | "eligibilityModels"
  >,
) => {
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
export const StoredRoot = PackedStoredRoot.mapFields((fields) => ({
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
  commonTermDictionaries: Schema.Array(CommonTerms),
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
  StoredRoot,
]);
export const VectorRebuildSnapshotMigrationInput = Schema.Union([
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyRoot })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyInlineRoot })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRoot })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV3 })),
  VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV4 })),
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
          return previous === undefined || previous < field;
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
export const SegmentHeader = Schema.Struct({
  version: Schema.Literal(2),
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
  id: Id,
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
  Schema.Struct({ row: Schema.Int, id: Id, score: Schema.Finite, data: DataRange }),
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

export const NativeVectorHits = Schema.Array(Schema.Tuple([Id, Schema.Finite])).check(
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
  Schema.Struct({ namespace: NamespaceName, operation: Schema.Literal("write"), input: Write }),
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
  version: Schema.Literal(5),
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
