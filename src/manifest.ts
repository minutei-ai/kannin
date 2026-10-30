import { Effect, Option, Schema } from "effect";
import {
  CommonTermProjection,
  Rejected,
  VECTOR_REBUILD_CHECKPOINT_BYTES,
  CommonTerms,
  EligibilityProjection,
  RootMigrationInput,
  LegacyInlineRoot,
  LegacyPackedRoot,
  StoredRoot,
  StoredVectorRebuildSnapshot,
  VectorRebuildSnapshotMigrationInput,
  namespaceColumnsFromNative,
} from "./protocol";
import type {
  Root,
  VectorRebuildSnapshot,
  LegacyStoredRoot,
  LegacyStoredRootV3,
  LegacyStoredRootV4,
  LegacyStoredRootV5,
} from "./protocol";

const projectionJson = Schema.fromJsonString(CommonTermProjection);
const termsJson = Schema.fromJsonString(CommonTerms);
const storedRootJson = Schema.fromJsonString(StoredRoot);
const rootMigrationJson = Schema.fromJsonString(RootMigrationInput);
const storedSnapshotJson = Schema.fromJsonString(StoredVectorRebuildSnapshot);
const snapshotMigrationJson = Schema.fromJsonString(VectorRebuildSnapshotMigrationInput);
const encodeProjection = Schema.encodeSync(projectionJson);
const encodeTerms = Schema.encodeSync(termsJson);
const encodeEligibility = Schema.encodeSync(Schema.fromJsonString(EligibilityProjection));
const decodeStoredRoot = Schema.decodeSync(storedRootJson, { onExcessProperty: "error" });
const decodeMigrationRoot = Schema.decodeSync(rootMigrationJson, { onExcessProperty: "error" });
const decodeStoredSnapshot = Schema.decodeSync(storedSnapshotJson, { onExcessProperty: "error" });
const decodeMigrationSnapshot = Schema.decodeSync(snapshotMigrationJson, {
  onExcessProperty: "error",
});

const poolRoot = (root: typeof Root.Type) => {
  const projections: Array<typeof CommonTermProjection.Type> = [];
  const projectionIndexes = new Map<string, number>();
  const dictionaries: Array<typeof CommonTerms.Type> = [];
  const dictionaryIndexes = new Map<string, number>();
  const eligibilityModels: Array<typeof EligibilityProjection.Type> = [];
  const eligibilityIndexes = new Map<string, number>();
  const eligibilityObjects = new Map<typeof EligibilityProjection.Type, number>();
  const eligibilityIndexFor = (model: typeof EligibilityProjection.Type | null) => {
    if (model === null) return null;
    const retained = eligibilityObjects.get(model);
    if (retained !== undefined) return retained;
    const key = encodeEligibility(model);
    const existing = eligibilityIndexes.get(key);
    if (existing !== undefined) {
      eligibilityObjects.set(model, existing);
      return existing;
    }
    const index = eligibilityModels.length;
    eligibilityIndexes.set(key, index);
    eligibilityObjects.set(model, index);
    eligibilityModels.push(model);
    return index;
  };
  const projectionIndexFor = (projection: typeof CommonTermProjection.Type | null | undefined) => {
    if (projection === undefined || projection === null) return projection;
    const key = encodeProjection(projection);
    const existing = projectionIndexes.get(key);
    if (existing !== undefined) return existing;
    const index = projections.length;
    projectionIndexes.set(key, index);
    projections.push(projection);
    return index;
  };
  const dictionaryIndexFor = (dictionary: typeof CommonTerms.Type | undefined) => {
    if (dictionary === undefined) return undefined;
    const key = encodeTerms(dictionary);
    const existing = dictionaryIndexes.get(key);
    if (existing !== undefined) return existing;
    const index = dictionaries.length;
    dictionaryIndexes.set(key, index);
    dictionaries.push(dictionary);
    return index;
  };
  const segments = root.segments.map((segment) => {
    const { commonProjection, commonTerms, eligibility, ...fields } = segment;
    const commonProjectionIndex = projectionIndexFor(commonProjection);
    const commonTermsIndex = dictionaryIndexFor(commonTerms);
    return {
      ...fields,
      commonProjectionIndex,
      commonTermsIndex,
      eligibilityIndex: eligibilityIndexFor(eligibility),
    };
  });
  return {
    ...root,
    version: 8 as const,
    segments,
    commonProjections: projections,
    commonTermDictionaries: dictionaries,
    eligibilityModels,
  };
};

const expandSharedSegments = <
  Segment extends
    | (typeof StoredRoot.Type.segments)[number]
    | (typeof LegacyStoredRootV3.Type.segments)[number]
    | (typeof LegacyStoredRootV4.Type.segments)[number],
>(
  segments: ReadonlyArray<Segment>,
  commonProjections: ReadonlyArray<typeof CommonTermProjection.Type>,
  commonTermDictionaries: ReadonlyArray<typeof CommonTerms.Type>,
  eligibilityModels: ReadonlyArray<typeof EligibilityProjection.Type>,
) =>
  segments.map((segment) => {
    const { commonProjectionIndex, commonTermsIndex, eligibilityIndex, ...metadata } = segment;
    const stored = Object.assign(metadata, { eligibility: null });
    if (eligibilityIndex !== null)
      Object.assign(stored, { eligibility: eligibilityModels[eligibilityIndex] });
    if (commonProjectionIndex === null) {
      if (commonTermsIndex === undefined) return Object.assign(stored, { commonProjection: null });
      return Object.assign(stored, {
        commonProjection: null,
        commonTerms: commonTermDictionaries[commonTermsIndex],
      });
    }
    if (commonProjectionIndex === undefined) {
      if (commonTermsIndex === undefined) return stored;
      return Object.assign(stored, { commonTerms: commonTermDictionaries[commonTermsIndex] });
    }
    if (commonTermsIndex === undefined)
      return Object.assign(stored, {
        commonProjection: commonProjections[commonProjectionIndex],
      });
    return Object.assign(stored, {
      commonProjection: commonProjections[commonProjectionIndex],
      commonTerms: commonTermDictionaries[commonTermsIndex],
    });
  });

const expandRoot = (root: typeof StoredRoot.Type): typeof Root.Type => {
  const { commonProjections, commonTermDictionaries, eligibilityModels, ...fields } = root;
  return {
    ...fields,
    version: 1 as const,
    segments: expandSharedSegments(
      fields.segments,
      commonProjections,
      commonTermDictionaries,
      eligibilityModels,
    ),
  };
};

const expandStoredSchema = (root: typeof LegacyStoredRootV5.Type): typeof Root.Type => {
  const { commonProjections, commonTermDictionaries, eligibilityModels, schema, ...fields } = root;
  const schemaFields = Option.match(Option.fromUndefinedOr(schema), {
    onNone: () => ({}),
    onSome: (native) => ({ schema: namespaceColumnsFromNative(native) }),
  });
  return {
    ...fields,
    version: 1 as const,
    ...schemaFields,
    segments: expandSharedSegments(
      fields.segments,
      commonProjections,
      commonTermDictionaries,
      eligibilityModels,
    ),
  };
};

const expandPackedRoot = (root: typeof LegacyStoredRootV4.Type): typeof LegacyPackedRoot.Type => {
  const { commonProjections, commonTermDictionaries, eligibilityModels, ...fields } = root;
  return Schema.decodeSync(LegacyPackedRoot)({
    ...fields,
    version: 1 as const,
    segments: expandSharedSegments(
      fields.segments,
      commonProjections,
      commonTermDictionaries,
      eligibilityModels,
    ),
  });
};

const poolSnapshot = (snapshot: typeof VectorRebuildSnapshot.Type) => ({
  ...snapshot,
  root: poolRoot(snapshot.root),
});

const expandSnapshot = (snapshot: typeof StoredVectorRebuildSnapshot.Type) => ({
  ...snapshot,
  root: expandRoot(snapshot.root),
});

export function encodeRoot(root: typeof Root.Type) {
  return Schema.encodeSync(storedRootJson)(poolRoot(root));
}

export function decodeRoot(text: string) {
  return expandRoot(decodeStoredRoot(text));
}

export const decodeRootEffect = Effect.fn("kannin.decodeRoot")(function* (text: string) {
  return expandRoot(
    yield* Schema.decodeEffect(storedRootJson, { onExcessProperty: "error" })(text),
  );
});

const expandLegacyStoredRoot = (
  stored: typeof LegacyStoredRoot.Type | typeof LegacyStoredRootV3.Type,
): typeof LegacyInlineRoot.Type => {
  if (stored.version === 2)
    return expandLegacyStoredRoot({
      ...stored,
      version: 3 as const,
      eligibilityModels: [],
      segments: stored.segments.map((segment) => ({
        ...segment,
        eligibilityIndex: null,
      })),
    });
  const { commonProjections, commonTermDictionaries, eligibilityModels, ...fields } = stored;
  return Schema.decodeSync(LegacyInlineRoot)({
    ...fields,
    version: 1,
    segments: expandSharedSegments(
      fields.segments,
      commonProjections,
      commonTermDictionaries,
      eligibilityModels,
    ),
  });
};

const migrationRoot = (stored: typeof RootMigrationInput.Type) => {
  if (stored.version === 1) {
    const root: typeof LegacyInlineRoot.Type = {
      ...stored,
      segments: stored.segments.map((segment) => ({ ...segment, eligibility: null })),
    };
    return {
      kind: "legacy" as const,
      sourceVersion: 1 as const,
      root,
      needsEligibility: true as const,
    };
  }
  if (stored.version === 2)
    return {
      kind: "legacy" as const,
      sourceVersion: 2 as const,
      root: expandLegacyStoredRoot(stored),
      needsEligibility: true as const,
    };
  if (stored.version === 3)
    return {
      kind: "legacy" as const,
      sourceVersion: 3 as const,
      root: expandLegacyStoredRoot(stored),
      needsEligibility: false as const,
    };
  if (stored.version === 4)
    return {
      kind: "packed" as const,
      sourceVersion: 4 as const,
      root: expandPackedRoot(stored),
    };
  if (stored.version === 5)
    return {
      kind: "schema" as const,
      sourceVersion: 5 as const,
      root: expandStoredSchema(stored),
    };
  if (stored.version === 6)
    return {
      kind: "schema" as const,
      sourceVersion: 6 as const,
      root: expandRoot({ ...stored, version: 8 }),
    };
  if (stored.version === 7)
    return {
      kind: "schema" as const,
      sourceVersion: 7 as const,
      root: expandRoot({ ...stored, version: 8 }),
    };
  return { kind: "current" as const, root: expandRoot(stored) };
};

export function decodeRootForMigration(text: string) {
  return migrationRoot(decodeMigrationRoot(text));
}

export function encodeVectorRebuildSnapshot(snapshot: typeof VectorRebuildSnapshot.Type) {
  const bytes = new TextEncoder().encode(
    Schema.encodeSync(storedSnapshotJson)(poolSnapshot(snapshot)),
  );
  if (bytes.byteLength > VECTOR_REBUILD_CHECKPOINT_BYTES)
    throw new Rejected({ status: 503, message: "Rebuild checkpoint exceeds byte budget" });
  return bytes;
}

export function decodeVectorRebuildSnapshot(text: string) {
  return expandSnapshot(decodeStoredSnapshot(text));
}

export function decodeVectorRebuildSnapshotForMigration(text: string) {
  const stored = decodeMigrationSnapshot(text);
  const converted = migrationRoot(stored.root);
  if (converted.kind === "legacy")
    return {
      kind: "legacy" as const,
      sourceVersion: converted.sourceVersion,
      needsEligibility: converted.needsEligibility,
      snapshot: { ...stored, root: converted.root },
    };
  if (converted.kind === "packed")
    return {
      kind: "packed" as const,
      sourceVersion: converted.sourceVersion,
      snapshot: { ...stored, root: converted.root },
    };
  if (converted.kind === "schema")
    return {
      kind: "schema" as const,
      sourceVersion: converted.sourceVersion,
      snapshot: { ...stored, root: converted.root },
    };
  return { kind: "current" as const, snapshot: { ...stored, root: converted.root } };
}
