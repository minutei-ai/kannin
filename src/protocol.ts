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
  "rebuild",
  "compact",
]);
export const Scalar = Schema.Union([Unicode, Schema.Finite, Schema.Boolean, Schema.Null]);
export const Attributes = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)),
  Scalar,
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
    field: Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)),
    op: Schema.Literals(["eq", "ne"]),
    value: Scalar,
  }),
  Schema.Struct({
    field: Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)),
    op: Schema.Literals(["gt", "gte", "lt", "lte"]),
    value: Schema.Finite,
  }),
  Schema.Struct({
    field: Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)),
    op: Schema.Literal("in"),
    value: Schema.Array(Scalar).check(Schema.isBetweenLength(1, 32)),
  }),
  Schema.Struct({
    field: Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)),
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
  directoryCacheChargedBytes: Schema.Int,
  bloomCacheBytes: Schema.Int,
  rangeReads: Schema.Int,
  rangeBytes: Schema.Int,
  rangeCacheHits: Schema.Int,
  directoryCacheHits: Schema.Int,
  workerCacheHits: Schema.Int,
  workerCacheMisses: Schema.Int,
  cacheApiHits: Schema.Int,
});
export const Metadata = Schema.Struct({
  sequence: Schema.Int,
  documents: Schema.Int,
  vectorOutbox: Schema.Int,
  cache: CacheMetrics,
});
export const Health = Schema.Struct({
  name: Schema.Literal("raio"),
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
export const SegmentHits = Schema.Array(
  Schema.Struct({ row: Schema.Int, id: Id, score: Schema.Finite }),
);
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
export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  status: Schema.Int,
  message: Schema.String,
}) {}
