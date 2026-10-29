import { expect, test } from "bun:test";
import { Effect, Schema, Struct } from "effect";
import {
  BloomPack,
  CommonTermProjection,
  CommonTerms,
  EligibilityProjection,
  LegacyInlineRoot,
  LegacyRoot,
  LegacyStoredRoot,
  LegacyStoredRootV3,
  LegacyStoredRootV4,
  LegacyStoredRootV5,
  LegacyPackedRoot,
  NamespaceColumns,
  NamespaceSchema,
  Root,
  StoredRoot,
  VectorRebuildSnapshot,
  filterableNames,
  namespaceColumnsFromNative,
  nativeSchemaFromColumns,
  resolvedVectorDimensions,
  vectorFilterNames,
} from "../src/protocol";
import {
  decodeRoot,
  decodeRootEffect,
  decodeRootForMigration,
  decodeVectorRebuildSnapshot,
  decodeVectorRebuildSnapshotForMigration,
  encodeRoot,
  encodeVectorRebuildSnapshot,
} from "../src/manifest";

const projection = Schema.decodeSync(CommonTermProjection)({
  terms: ["alpha"],
  partitions: [[[1, 1, 0, 0]]],
  independent: [[[1, 1, 0, 0]]],
});
const dictionary = Schema.decodeSync(CommonTerms)({
  alpha: { df: 2, bounds: [[1, 1, 0, 0]] },
});
const eligibility = Schema.decodeSync(EligibilityProjection)({
  fields: ["group"],
  data: {
    kind: "joint",
    groups: [[[['"shared attribute value shared by both immutable segments"']], 0, 0]],
  },
});
const inlineSegment = (key: string) => ({
  key,
  sequence: 1,
  headerBytes: 100,
  bytes: 200,
  metadataEnd: 150,
  count: 1,
  minimumId: key,
  documentBloom: "bloom-doc-".repeat(16),
  termBloom: "bloom-term-".repeat(16),
  dead: [],
  removedFrequencies: {},
  eligibility: null,
});
const inlineSegmentWithMetadata = (key: string) => ({
  ...inlineSegment(key),
  commonTerms: dictionary,
  commonProjection: projection,
  eligibility,
});
const legacyInlineRoot = Schema.decodeSync(LegacyInlineRoot)({
  version: 1,
  sequence: 1,
  head: null,
  documents: 2,
  titleLength: 4,
  bodyLength: 8,
  vectorEpoch: "epoch",
  vectorJobs: [],
  lastReceipt: null,
  segments: [
    inlineSegmentWithMetadata("namespaces/test/segments/segment-a.rsix"),
    inlineSegmentWithMetadata("namespaces/test/segments/segment-b.rsix"),
    inlineSegment("namespaces/test/segments/segment-c.rsix"),
  ],
});
const legacyRoot = Schema.decodeSync(LegacyRoot)({
  ...legacyInlineRoot,
  segments: legacyInlineRoot.segments.map(({ eligibility: _eligibility, ...segment }) => segment),
});
const legacyV1Expanded = Schema.decodeSync(LegacyInlineRoot)({
  ...legacyInlineRoot,
  segments: legacyInlineRoot.segments.map((segment) => ({ ...segment, eligibility: null })),
});
const bloomPack = Schema.decodeSync(BloomPack)({
  key: `namespaces/test/bloom-packs/${"a".repeat(64)}.bin`,
  bytes: 48,
  segmentKeys: [
    "namespaces/test/segments/segment-a.rsix",
    "namespaces/test/segments/deleted-segment.rsix",
    "namespaces/test/segments/segment-c.rsix",
  ],
  document: { offset: 0, length: 24, sha256: "b".repeat(64), offsets: [0, 8, 16, 24] },
  term: { offset: 24, length: 24, sha256: "c".repeat(64), offsets: [0, 8, 16, 24] },
});
const root = Schema.decodeSync(Root)({
  version: 1,
  sequence: 1,
  head: null,
  documents: 2,
  titleLength: 4,
  bodyLength: 8,
  vectorEpoch: "epoch",
  vectorJobs: [],
  lastReceipt: null,
  bloomPacks: [bloomPack],
  segments: [
    {
      ...inlineSegmentWithMetadata("namespaces/test/segments/segment-a.rsix"),
      bloom: { packIndex: 0, row: 0 },
    },
    {
      ...inlineSegmentWithMetadata("namespaces/test/segments/segment-c.rsix"),
      bloom: { packIndex: 0, row: 2 },
    },
  ].map(({ documentBloom: _documentBloom, termBloom: _termBloom, ...segment }) => segment),
});
const snapshot = Schema.decodeSync(VectorRebuildSnapshot)({ root, fields: [] });
const storedEligibilityIndex = (value: typeof eligibility | null) => {
  if (value === null) return null;
  return 0;
};
const storedProjectionIndex = (value: typeof projection | null | undefined) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return 0;
};
const storedTermsIndex = (value: typeof dictionary | undefined) => {
  if (value === undefined) return undefined;
  return 0;
};

const storedV3 = Schema.decodeSync(LegacyStoredRootV3)({
  ...legacyInlineRoot,
  version: 3,
  commonProjections: [projection],
  commonTermDictionaries: [dictionary],
  eligibilityModels: [eligibility],
  segments: legacyInlineRoot.segments.map((segment) => {
    const { commonProjection, commonTerms, eligibility: _eligibility, ...fields } = segment;
    return {
      ...fields,
      eligibilityIndex: storedEligibilityIndex(segment.eligibility),
      commonProjectionIndex: storedProjectionIndex(commonProjection),
      commonTermsIndex: storedTermsIndex(commonTerms),
    };
  }),
});
const storedV2 = Schema.decodeSync(LegacyStoredRoot)({
  ...storedV3,
  version: 2,
  segments: storedV3.segments.map(({ eligibilityIndex: _eligibilityIndex, ...segment }) => segment),
});

test("Root v6 pools shared metadata and retains valid Bloom pack holes", () => {
  const wire = encodeRoot(root);
  const expanded = decodeRoot(wire);
  expect(expanded).toEqual(root);
  expect(expanded.segments[0]?.commonTerms).toEqual(dictionary);
  expect(expanded.segments[0]?.commonProjection).toEqual(projection);
  expect(expanded.segments[0]?.commonTerms).toBe(expanded.segments[1]?.commonTerms);
  expect(expanded.segments[0]?.commonProjection).toBe(expanded.segments[1]?.commonProjection);
  expect(expanded.segments[0]?.eligibility).toBe(expanded.segments[1]?.eligibility);
  expect(wire).toContain('"version":6');
  expect(wire).toContain('"bloomPacks"');
  expect(wire).toContain('"bloom":{"packIndex":0,"row":2}');
  expect(wire).not.toContain('"documentBloom":');
  expect(wire).not.toContain('"termBloom":');
  expect(wire).not.toContain('"commonTerms":');
  expect(wire).not.toContain('"commonProjection":');
  expect(wire).not.toContain('"eligibility":');
  expect(Schema.decodeSync(Schema.fromJsonString(StoredRoot))(wire).eligibilityModels).toEqual([
    eligibility,
  ]);
});

test("Root v6 rejects invalid Bloom pack descriptors and segment references", () => {
  const wire = encodeRoot(root);
  const invalidPackIndex = wire.replace('"packIndex":0', '"packIndex":2');
  expect(() => decodeRoot(invalidPackIndex)).toThrow();
  const invalidRow = wire.replace('"row":2', '"row":1');
  expect(() => decodeRoot(invalidRow)).toThrow();
  const invalidColumnOffsets = wire.replace('"offsets":[0,8,16,24]', '"offsets":[0,7,16,24]');
  expect(() => decodeRoot(invalidColumnOffsets)).toThrow();
  const invalidColumns = wire.replace('"term":{"offset":24', '"term":{"offset":23');
  expect(() => decodeRoot(invalidColumns)).toThrow();
  const invalidDigestKey = wire.replace(
    `bloom-packs/${"a".repeat(64)}`,
    "bloom-packs/not-a-digest",
  );
  expect(() => decodeRoot(invalidDigestKey)).toThrow();
});

test("pooled Root references remain bounds checked", () => {
  const wire = encodeRoot(root);
  const invalidMetadataEnd = wire.replace('"metadataEnd":150', '"metadataEnd":201');
  expect(() => decodeRoot(invalidMetadataEnd)).toThrow();
  const metadataBeforeHeader = wire.replace('"metadataEnd":150', '"metadataEnd":99');
  expect(() => decodeRoot(metadataBeforeHeader)).toThrow();
  const invalidProjection = wire.replace('"commonProjectionIndex":0', '"commonProjectionIndex":9');
  expect(() => decodeRoot(invalidProjection)).toThrow();
  const invalidNestedValue = wire.replace('"df":2', '"df":1');
  expect(() => decodeRoot(invalidNestedValue)).toThrow();
  const invalidEligibility = wire.replace('"eligibilityIndex":0', '"eligibilityIndex":9');
  expect(() => decodeRoot(invalidEligibility)).toThrow();
  const missingEligibility = wire.replace('"eligibilityIndex":0,', "");
  expect(missingEligibility).not.toBe(wire);
  expect(() => decodeRoot(missingEligibility)).toThrow();
});

test("migration decoder distinguishes current v6 from legacy v1, v2, v3, packed v4, and schema v5", async () => {
  const wire = encodeRoot(root);
  expect(decodeRootForMigration(wire)).toEqual({ kind: "current", root });
  const storedCurrent = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(wire);
  const storedV4 = Schema.decodeSync(LegacyStoredRootV4)({
    ...Struct.omit(storedCurrent, ["schema"]),
    version: 4,
  });
  const packedV4 = Schema.encodeSync(Schema.fromJsonString(LegacyStoredRootV4))(storedV4);
  expect(() => decodeRoot(packedV4)).toThrow();
  expect(decodeRootForMigration(packedV4)).toEqual({
    kind: "packed",
    sourceVersion: 4,
    root: Schema.decodeSync(LegacyPackedRoot)(Struct.omit(root, ["schema"])),
  });
  const legacyV1 = Schema.encodeSync(Schema.fromJsonString(LegacyRoot))(legacyRoot);
  expect(decodeRootForMigration(legacyV1)).toEqual({
    kind: "legacy",
    sourceVersion: 1,
    root: legacyV1Expanded,
    needsEligibility: true,
  });
  expect(() => decodeRoot(legacyV1)).toThrow();
  const inlineV1 = Schema.encodeSync(Schema.fromJsonString(LegacyInlineRoot))(legacyInlineRoot);
  expect(decodeRootForMigration(inlineV1)).toMatchObject({
    kind: "legacy",
    sourceVersion: 1,
    needsEligibility: true,
    root: legacyV1Expanded,
  });
  const pooledV2 = Schema.encodeSync(Schema.fromJsonString(LegacyStoredRoot))(storedV2);
  expect(() => decodeRoot(pooledV2)).toThrow();
  expect(decodeRootForMigration(pooledV2)).toMatchObject({
    kind: "legacy",
    sourceVersion: 2,
    needsEligibility: true,
    root: legacyV1Expanded,
  });
  const pooledV3 = Schema.encodeSync(Schema.fromJsonString(LegacyStoredRootV3))(storedV3);
  expect(() => decodeRoot(pooledV3)).toThrow();
  expect(decodeRootForMigration(pooledV3)).toMatchObject({
    kind: "legacy",
    sourceVersion: 3,
    needsEligibility: false,
    root: legacyInlineRoot,
  });
  expect((await Effect.runPromiseExit(decodeRootEffect(wire)))._tag).toBe("Success");
  expect((await Effect.runPromiseExit(decodeRootEffect(legacyV1)))._tag).toBe("Failure");
  expect((await Effect.runPromiseExit(decodeRootEffect(pooledV2)))._tag).toBe("Failure");
  expect((await Effect.runPromiseExit(decodeRootEffect(pooledV3)))._tag).toBe("Failure");
  expect((await Effect.runPromiseExit(decodeRootEffect(packedV4)))._tag).toBe("Failure");
});

test("rebuild snapshots retain their envelope and use the same migration classification", () => {
  const wire = new TextDecoder().decode(encodeVectorRebuildSnapshot(snapshot));
  expect(decodeVectorRebuildSnapshot(wire)).toEqual(snapshot);
  expect(wire).toContain('"version":6');
  const legacy = Schema.encodeSync(
    Schema.fromJsonString(
      VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyRoot })),
    ),
  )({ root: legacyRoot, fields: [] });
  expect(() => decodeVectorRebuildSnapshot(legacy)).toThrow();
  expect(decodeVectorRebuildSnapshotForMigration(legacy)).toMatchObject({
    kind: "legacy",
    sourceVersion: 1,
    needsEligibility: true,
    snapshot: { fields: [], root: legacyV1Expanded },
  });
  expect(decodeVectorRebuildSnapshotForMigration(wire)).toEqual({
    kind: "current",
    snapshot,
  });
  const storedV4 = Schema.decodeSync(LegacyStoredRootV4)({
    ...Struct.omit(Schema.decodeSync(Schema.fromJsonString(StoredRoot))(encodeRoot(root)), [
      "schema",
    ]),
    version: 4,
  });
  const packedV4 = Schema.encodeSync(
    Schema.fromJsonString(
      VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV4 })),
    ),
  )({ root: storedV4, fields: [] });
  expect(() => decodeVectorRebuildSnapshot(packedV4)).toThrow();
  expect(decodeVectorRebuildSnapshotForMigration(packedV4)).toEqual({
    kind: "packed",
    sourceVersion: 4,
    snapshot: {
      root: Schema.decodeSync(LegacyPackedRoot)(Struct.omit(root, ["schema"])),
      fields: [],
    },
  });
  const pooled = Schema.encodeSync(
    Schema.fromJsonString(
      VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV3 })),
    ),
  )({ root: storedV3, fields: [] });
  expect(() => decodeVectorRebuildSnapshot(pooled)).toThrow();
  expect(decodeVectorRebuildSnapshotForMigration(pooled)).toMatchObject({
    kind: "legacy",
    sourceVersion: 3,
    needsEligibility: false,
    snapshot: { fields: [], root: legacyInlineRoot },
  });
});

test("column declarations keep both native orders and do not invent attribute types", () => {
  const encodeNative = Schema.encodeSync(Schema.fromJsonString(NamespaceSchema));
  const omitted = Schema.decodeSync(NamespaceSchema)({
    filterable: ["vector", "title", "text"],
    vectorFilterFields: ["text", "vector"],
  });
  const explicit = Schema.decodeSync(NamespaceSchema)({ ...omitted, vectorDimensions: 768 });
  const omittedColumns = namespaceColumnsFromNative(omitted);
  const explicitColumns = namespaceColumnsFromNative(explicit);
  expect(omittedColumns.columns[0]).toEqual({ source: "native-vector" });
  expect(explicitColumns.columns[0]).toEqual({ source: "native-vector", dimensions: 768 });
  expect(omittedColumns.columns.filter((column) => column.source === "attribute")).toEqual([
    { source: "attribute", name: "vector", value: "legacy-untyped", vectorFilterOrder: 1 },
    { source: "attribute", name: "title", value: "legacy-untyped" },
    { source: "attribute", name: "text", value: "legacy-untyped", vectorFilterOrder: 0 },
  ]);
  expect(filterableNames(omittedColumns)).toEqual(["vector", "title", "text"]);
  expect(vectorFilterNames(omittedColumns)).toEqual(["text", "vector"]);
  expect(resolvedVectorDimensions(undefined)).toBe(768);
  expect(resolvedVectorDimensions(omittedColumns)).toBe(768);
  expect(resolvedVectorDimensions(explicitColumns)).toBe(768);
  expect(encodeNative(nativeSchemaFromColumns(omittedColumns))).toBe(encodeNative(omitted));
  expect(encodeNative(nativeSchemaFromColumns(explicitColumns))).toBe(encodeNative(explicit));
  expect(encodeNative(omitted)).not.toBe(encodeNative(explicit));
  expect(() =>
    Schema.decodeUnknownSync(NamespaceColumns)({
      columns: [
        { source: "native-vector" },
        { source: "attribute", name: "year", value: "string" },
      ],
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeSync(NamespaceColumns)({
      columns: [{ source: "id", name: "id", value: "legacy-untyped" }],
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(NamespaceColumns)({
      columns: [
        { source: "attribute", name: "vector", value: "legacy-untyped" },
        { source: "native-vector" },
      ],
    }),
  ).toThrow();
  const declared = Schema.decodeSync(Root)({ ...root, schema: omittedColumns });
  const explicitRoot = Schema.decodeSync(Root)({ ...root, schema: explicitColumns });
  const wire = encodeRoot(declared);
  expect(decodeRoot(wire)).toEqual(declared);
  expect(wire).toContain('"source":"native-vector"');
  expect(wire).not.toContain('"dimensions"');
  expect(wire).not.toContain('"filterable"');
  expect(encodeRoot(explicitRoot)).toContain('"dimensions":768');
  const stored = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(wire);
  const legacyV5 = Schema.decodeSync(LegacyStoredRootV5)({
    ...stored,
    version: 5,
    schema: omitted,
  });
  const legacyWire = Schema.encodeSync(Schema.fromJsonString(LegacyStoredRootV5))(legacyV5);
  expect(legacyWire).toContain('"version":5');
  expect(legacyWire).toContain('"vectorFilterFields":["text","vector"]');
  expect(() => decodeRoot(legacyWire)).toThrow();
  expect(decodeRootForMigration(legacyWire)).toEqual({
    kind: "schema",
    sourceVersion: 5,
    root: declared,
  });
  const legacySnapshot = Schema.encodeSync(
    Schema.fromJsonString(
      VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: LegacyStoredRootV5 })),
    ),
  )({ root: legacyV5, fields: ["text", "vector"] });
  expect(() => decodeVectorRebuildSnapshot(legacySnapshot)).toThrow();
  expect(decodeVectorRebuildSnapshotForMigration(legacySnapshot)).toEqual({
    kind: "schema",
    sourceVersion: 5,
    snapshot: { root: declared, fields: ["text", "vector"] },
  });
});

test("stored column readers reject unsupported declaration properties", () => {
  const schema = namespaceColumnsFromNative({
    filterable: ["text"],
    vectorFilterFields: [],
  });
  const declared = Schema.decodeSync(Root)({ ...root, schema });
  const stored = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(encodeRoot(declared));
  for (const invalid of [
    { ...schema, idType: "uint" },
    { columns: schema.columns.map((column) => Object.assign({}, column, { fullText: true })) },
  ]) {
    const corrupted = { ...stored, schema: invalid };
    expect(() => decodeRoot(JSON.stringify(corrupted))).toThrow();
    expect(() =>
      decodeVectorRebuildSnapshot(JSON.stringify({ root: corrupted, fields: [] })),
    ).toThrow();
  }
});
