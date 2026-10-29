import { sha256 } from "../hash";
import {
  Array as EffectArray,
  Cause,
  Clock,
  Exit,
  Effect,
  Fiber,
  Match,
  Option,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import {
  Segment,
  Directory,
  CompressedDirectory,
  pack,
  unpack,
  directory_compress,
  segment_document,
  segment_query_document,
  segment_query_documents,
  segment_bloom,
  BloomBatch,
  FrequencyPage,
  EligibilityQuery,
  segment_overview_project,
  segment_correlated_overview,
} from "../../dist/wasm/raio_engine";
import type { PreparedQuery, Ranker } from "../../dist/wasm/raio_engine";
import type {
  DataRange,
  Root,
  Row,
  UnpackedSegment,
  ConvertedInlineRoot,
  LocatedDocument,
} from "../protocol";
import {
  compareFieldNames,
  StoredDocument,
  QueryDocument,
  SegmentHeader,
  CommonTerms,
  CommonTermProjection,
  CommonLeaders,
  SegmentRange,
  ProjectedTermCatalog,
  TermSummaries,
  TermProjection,
  TermProjectionRange,
  CorrelatedOverview,
  CatalogTelemetry,
  EligibleMinimum,
  EligibilityProjection,
  TermCatalogBatch,
  TermFilters,
  type OverviewBatch,
  StoredOverviewBatch,
  OverviewFrameMetadata,
  TermProjectionProps,
  SegmentCacheProps,
  DirectoryCacheMiss,
  Rejected,
  NamespaceSchema,
  namespaceColumnsFromNative,
  ConstantAttributes,
  BloomPack,
  TextPlan,
  type SegmentScoreBound,
} from "../protocol";

import type { BackgroundContext, ObjectCondition, SearchRuntime } from "../platform";

function bloomOffsets(rows: ReadonlyArray<Uint8Array>) {
  const offsets = new Uint32Array(rows.length + 1);
  const layout = { offset: 0 };
  for (const [index, row] of rows.entries()) {
    offsets[index] = layout.offset;
    layout.offset += row.byteLength;
  }
  offsets[rows.length] = layout.offset;
  return { length: layout.offset, offsets };
}

function writeBloomRows(bytes: Uint8Array, start: number, rows: ReadonlyArray<Uint8Array>) {
  const layout = { offset: start };
  for (const row of rows) {
    bytes.set(row, layout.offset);
    layout.offset += row.byteLength;
  }
}

function validBloomRows(rows: ReadonlyArray<Uint8Array>) {
  if (
    rows.length === 0 ||
    rows.length > 64 ||
    rows.some((row) => row.byteLength < 8 || row.byteLength > 16 * 1024 * 1024)
  )
    return false;
  return rows.reduce((total, row) => total + row.byteLength, 0) <= 16 * 1024 * 1024;
}

function validateBloomBatch(bytes: Uint8Array, offsets: Uint32Array) {
  const batch = new BloomBatch(bytes, offsets);
  batch.free();
  return true;
}

function documentReadConcurrency(pages: ReadonlyArray<typeof DataRange.Type>) {
  if (pages.reduce((total, page) => total + page.length, 0) <= 64 * 1024) return 8;
  return 4;
}

export function createStorage(runtime: SearchRuntime) {
  const env = runtime.env;
  const caches = runtime.cache;
  const waitUntil = runtime.waitUntil;
  const pendingQueryPublications = new Map<string, number>();
  const queryPublicationBudget = { bytes: 0 };
  const MAX_QUERY_PUBLICATION_BYTES = 2 * 1024 * 1024;
  const MAX_QUERY_PUBLICATIONS = 16;

  function publishQueryCache(
    identity: string,
    charge: number,
    publication: Effect.Effect<void, Cause.UnknownError>,
    ctx?: BackgroundContext,
  ) {
    if (
      pendingQueryPublications.has(identity) ||
      pendingQueryPublications.size >= MAX_QUERY_PUBLICATIONS ||
      queryPublicationBudget.bytes + charge > MAX_QUERY_PUBLICATION_BYTES
    )
      return false;
    pendingQueryPublications.set(identity, charge);
    queryPublicationBudget.bytes += charge;
    const pending = Effect.runPromise(
      publication.pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            pendingQueryPublications.delete(identity);
            queryPublicationBudget.bytes -= charge;
          }),
        ),
      ),
    );
    if (ctx === undefined) waitUntil(pending);
    else ctx.waitUntil(pending);
    return true;
  }

  const buffers = new Map<string, Uint8Array>();
  const frequencyPages = new Map<string, { page: FrequencyPage; bytes: number }>();
  const frequencyBudget = { bytes: 0 };
  const cacheOrder = new Map<string, "range" | "frequency">();
  const pendingRanges = new Map<string, Promise<Uint8Array>>();
  const MAX_PENDING_RANGES = 64;
  const SMALL_RANGE_LIMIT = 64 * 1024;
  const SMALL_RANGE_BODY_UNIT = 64 * 1024;
  const smallRangeReads = Semaphore.makeUnsafe(64);
  const MAX_DIRECTORY_FALLBACK_LENGTH = 2 * 1024 * 1024;
  const MAX_DIRECTORY_CACHE_LENGTH = 4 * 1024 * 1024;
  const SMALL_CATALOG_HEADER_BYTES = 64 * 1024;
  const MAX_DIRECTORY_CACHE_BYTES = MAX_DIRECTORY_FALLBACK_LENGTH + 8192;
  const directoryFallbackReads = Semaphore.makeUnsafe(1);
  const CANONICAL_HEADER_UNIT = 64 * 1024;
  const canonicalHeaderReads = Semaphore.makeUnsafe(128);
  const DIRECTORY_CACHE_UNITS = 4;
  const DIRECTORY_CACHE_UNIT = MAX_DIRECTORY_CACHE_BYTES / DIRECTORY_CACHE_UNITS - 8192;
  const directoryCacheReads = Semaphore.makeUnsafe(DIRECTORY_CACHE_UNITS);
  const directoryFrameAttempts = Semaphore.makeUnsafe(16);
  const directoryFrameFailures = { full: { epoch: 0n }, common: { epoch: 0n } };
  const DIRECTORY_FRAME_BUDGET = 250_000_000n;
  const budget = { bytes: 0, payloadBytes: 0 };
  const MAX_CACHE_BYTES = 12 * 1024 * 1024;
  const encodedDirectories = new Map<string, CompressedDirectory>();
  const encodedBudget = { bytes: 0 };
  const MAX_ENCODED_DIRECTORY_BYTES = 9 * 1024 * 1024;
  const textPlans = new Map<string, { plan: typeof TextPlan.Type; bytes: number }>();
  const textPlanBudget = { bytes: 0 };
  const MAX_TEXT_PLAN_BYTES = 1024 * 1024;
  const scoreBounds = new Map<string, typeof SegmentScoreBound.Type>();
  const scoreBoundBudget = { bytes: 0 };
  const MAX_SCORE_BOUND_BYTES = 1024 * 1024;
  const admissionCounts = new Map<string, number>();
  const admissionBudget = { bytes: 0, requests: 0 };
  const MAX_ADMISSION_BYTES = 1024 * 1024;
  const directories = new Map<
    string,
    { directory: Directory; bytes: number; admissionIdentity: string }
  >();
  const activeDirectories = new Map<
    string,
    {
      readers: number;
      directory: Directory | undefined;
      fingerprint: ArrayBuffer | undefined;
      acquisition: Option.Option<Promise<Exit.Exit<void, Cause.UnknownError | Rejected>>>;
    }
  >();
  const decodedBudget = { bytes: 0 };
  const MAX_DECODED_BYTES = 40 * 1024 * 1024;
  const MAX_DECODED_CACHE_BYTES = 24 * 1024 * 1024;
  const CachedTermCatalog = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("projection"), projection: TermProjection }),
    Schema.Struct({ kind: Schema.Literal("minimum"), minimum: EligibleMinimum }),
    Schema.Struct({ kind: Schema.Literal("eligibility"), eligibility: Schema.String }),
  ]);
  const encodeCachedTermCatalog = Schema.encodeSync(Schema.fromJsonString(CachedTermCatalog));
  const termCatalogs = new Map<string, { value: typeof CachedTermCatalog.Type; bytes: number }>();
  const termBudget = { bytes: 0 };
  const MAX_TERM_CACHE_BYTES = 4 * 1024 * 1024;
  const overviewBuffers = new Map<string, Uint8Array>();
  const overviewBudget = { bytes: 0 };
  const MAX_OVERVIEW_BYTES = 4 * 1024 * 1024;
  const OVERVIEW_BODY_UNIT = 64 * 1024;
  const MAX_OVERVIEW_BODY_UNITS = 64;
  const overviewBodyReads = Semaphore.makeUnsafe(MAX_OVERVIEW_BODY_UNITS);
  const reads = {
    overviewMemoryHits: 0,
    overviewCacheApiHits: 0,
    overviewCacheApiLookups: 0,
    overviewBuilds: 0,
    correlatedReads: 0,
    correlatedHits: 0,
    correlatedBytes: 0,
    termReads: 0,
    termRequests: 0,
    termBytes: 0,
    termMemoryHits: 0,
    termWorkerCacheHits: 0,
    rangeReads: 0,
    rangeCacheTimeouts: 0,
    rangeR2FallbackReads: 0,
    rangeR2FallbackBytes: 0,
    directoryCacheTimeouts: 0,
    directoryR2FallbackReads: 0,
    directoryR2FallbackBytes: 0,
    directoryR2CacheReads: 0,
    directoryR2CacheHits: 0,
    directoryR2CacheBytes: 0,
    directoryR2CacheRejected: 0,
    directoryR2CacheTimeouts: 0,
    directoryR2CachePublications: 0,
    directoryR2CacheOriginResponses: 0,
    rangeBytes: 0,
    rangeCacheHits: 0,
    directoryCacheHits: 0,
    directoryCommonHits: 0,
    encodedDirectoryCacheHits: 0,
    textPlanCacheHits: 0,
    workerCacheHits: 0,
    workerCacheMisses: 0,
    cacheApiHits: 0,
    bloomR2Reads: 0,
    bloomR2Bytes: 0,
  };
  const bloomBatches = new Map<string, { batch: BloomBatch; bytes: number; prefix: string }>();
  const bloomBudget = { bytes: 0 };
  type BloomReadFailure = Cause.UnknownError | Rejected;
  type PendingBloomColumn = {
    completion: Promise<Exit.Exit<Uint8Array, BloomReadFailure>>;
    resolve: (exit: Exit.Exit<Uint8Array, BloomReadFailure>) => void;
    cacheable: boolean;
    users: number;
  };
  const pendingBloomColumns = new Map<string, PendingBloomColumn>();
  const bloomColumnReads = Semaphore.makeUnsafe(4);
  const bloomColumnBytes = Semaphore.makeUnsafe(16);
  const MAX_BLOOM_BASE64_LENGTH = Math.ceil((16 * 1024 * 1024) / 3) * 4;
  const withBloomAdmission = Effect.fn("kannin.withBloomAdmission")(
    <A, E, R>(semaphore: Semaphore.Semaphore, permits: number, self: Effect.Effect<A, E, R>) =>
      semaphore
        .withPermitsIfAvailable(permits)(self)
        .pipe(
          Effect.repeat({
            while: Option.isNone,
            schedule: Schedule.min([
              Schedule.exponential("1 millis"),
              Schedule.spaced("16 millis"),
            ]),
          }),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.never,
              onSome: Effect.succeed,
            }),
          ),
        ),
  );
  const strings = Schema.fromJsonString(Schema.Array(Schema.String));
  const encodeStrings = Schema.encodeSync(strings);
  const decodeTermCatalog = Schema.decodeEffect(Schema.fromJsonString(ProjectedTermCatalog));
  const decodeCatalogTelemetry = Schema.decodeEffect(Schema.fromJsonString(CatalogTelemetry));
  const correlatedOverviewJson = Schema.fromJsonString(CorrelatedOverview);
  const decodeCorrelatedOverview = Schema.decodeEffect(correlatedOverviewJson);
  const encodeCorrelatedOverview = Schema.encodeEffect(correlatedOverviewJson);
  const overviewBatchJson = Schema.fromJsonString(StoredOverviewBatch);
  const decodeOverviewBatch = Schema.decodeEffect(overviewBatchJson);
  const encodeOverviewBatch = Schema.encodeEffect(overviewBatchJson);
  const decodeTermSummaries = Schema.decodeEffect(Schema.fromJsonString(TermSummaries));
  const decodeEligibleMinimum = Schema.decodeEffect(Schema.fromJsonString(EligibleMinimum));
  const decodeTermCatalogBatch = Schema.decodeEffect(Schema.fromJsonString(TermCatalogBatch));
  const encodeProjectionTerms = Schema.encodeSync(TermProjectionProps.fields.terms);
  const encodeEligibility = Schema.encodeSync(Schema.fromJsonString(EligibilityProjection));
  const encodeTextPlan = Schema.encodeSync(Schema.fromJsonString(TextPlan));
  const encodeEligibilityFields = Schema.encodeSync(
    Schema.fromJsonString(EligibilityProjection.fields.fields),
  );
  const decodeEligibilityMinimum = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum));
  const storedDocumentJson = Schema.fromJsonString(StoredDocument);
  const decodeStoredDocument = Schema.decodeSync(storedDocumentJson);
  const queryDocumentJson = Schema.fromJsonString(QueryDocument);
  const decodeQueryDocument = Schema.decodeSync(queryDocumentJson);
  const decodeQueryDocumentEffect = Schema.decodeEffect(queryDocumentJson);
  const decodeQueryDocumentsEffect = Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(QueryDocument)),
  );

  function evictFor(bytes: number) {
    while (budget.bytes + frequencyBudget.bytes + bytes > MAX_CACHE_BYTES) {
      const oldest = cacheOrder.entries().next().value;
      if (oldest === undefined) break;
      cacheOrder.delete(oldest[0]);
      const key = oldest[0].slice(2);
      if (oldest[1] === "range") {
        const prior = buffers.get(key);
        if (prior !== undefined) {
          budget.bytes -= prior.byteLength + key.length * 4 + 128;
          budget.payloadBytes -= prior.byteLength;
        }
        buffers.delete(key);
      } else {
        const prior = frequencyPages.get(key);
        if (prior !== undefined) {
          frequencyBudget.bytes -= prior.bytes;
          prior.page.free();
        }
        frequencyPages.delete(key);
      }
    }
  }

  function remember(key: string, bytes: Uint8Array) {
    const previous = buffers.get(key);
    if (previous !== undefined) {
      budget.bytes -= previous.byteLength + key.length * 4 + 128;
      budget.payloadBytes -= previous.byteLength;
    }
    buffers.delete(key);
    cacheOrder.delete(`r:${key}`);
    const charge = bytes.byteLength + key.length * 4 + 128;
    if (charge > MAX_CACHE_BYTES) return;
    evictFor(charge);
    buffers.set(key, bytes);
    cacheOrder.set(`r:${key}`, "range");
    budget.bytes += charge;
    budget.payloadBytes += bytes.byteLength;
  }

  function cachedRange(key: string) {
    const bytes = buffers.get(key);
    if (bytes === undefined) return undefined;
    reads.rangeCacheHits += 1;
    buffers.delete(key);
    buffers.set(key, bytes);
    cacheOrder.delete(`r:${key}`);
    cacheOrder.set(`r:${key}`, "range");
    return bytes;
  }

  function noteDirectoryRequest(key: string) {
    admissionBudget.requests += 1;
    if (admissionBudget.requests >= 4096) {
      admissionBudget.requests = 0;
      for (const [identity, count] of admissionCounts) {
        const aged = Math.floor(count / 2);
        if (aged === 0) {
          admissionCounts.delete(identity);
          admissionBudget.bytes -= identity.length * 4 + 128;
        } else admissionCounts.set(identity, aged);
      }
    }
    const previous = admissionCounts.get(key);
    if (previous !== undefined) {
      admissionCounts.delete(key);
      admissionCounts.set(key, Math.min(255, previous + 1));
      return;
    }
    const charge = key.length * 4 + 128;
    if (charge > MAX_ADMISSION_BYTES) return;
    while (admissionBudget.bytes + charge > MAX_ADMISSION_BYTES) {
      const oldest = admissionCounts.keys().next().value;
      if (oldest === undefined) break;
      admissionCounts.delete(oldest);
      admissionBudget.bytes -= oldest.length * 4 + 128;
    }
    admissionCounts.set(key, 1);
    admissionBudget.bytes += charge;
  }

  function rememberEncodedDirectory(
    key: string,
    bytes: Uint8Array,
    expected: number,
    common = false,
  ) {
    if (encodedDirectories.has(key)) return;
    const frequency = admissionCounts.get(key) ?? 0;
    if (common && frequency < 2) return;
    const maximum = MAX_ENCODED_DIRECTORY_BYTES - MAX_ADMISSION_BYTES;
    if (bytes.byteLength + key.length * 4 + 128 > maximum) return;
    using frame = Match.value(common).pipe(
      Match.when(true, () => CompressedDirectory.common(bytes, expected)),
      Match.orElse(() => new CompressedDirectory(bytes, expected)),
    );
    const charge = frame.heap_bytes() + key.length * 4 + 128;
    if (charge > maximum) return;
    const victims = [];
    const remaining = { bytes: encodedBudget.bytes };
    for (const [identity, value] of encodedDirectories) {
      if (remaining.bytes + charge <= maximum) break;
      if (frequency <= (admissionCounts.get(identity) ?? 0)) return;
      victims.push(identity);
      remaining.bytes -= value.heap_bytes() + identity.length * 4 + 128;
    }
    for (const identity of victims) {
      const victim = encodedDirectories.get(identity);
      encodedDirectories.delete(identity);
      victim?.free();
    }
    encodedDirectories.set(key, frame.retain());
    encodedBudget.bytes = remaining.bytes + charge;
  }

  function cachedEncodedDirectory(key: string) {
    const frame = encodedDirectories.get(key);
    if (frame === undefined) return undefined;
    noteDirectoryRequest(key);
    reads.rangeCacheHits += 1;
    reads.encodedDirectoryCacheHits += 1;
    encodedDirectories.delete(key);
    encodedDirectories.set(key, frame);
    return frame;
  }

  function addFrequencyPosting(
    ranker: Ranker,
    key: string,
    term: string,
    offset: number,
    bytes: Uint8Array,
  ) {
    const identity = `${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${bytes.byteLength}`;
    const cached = frequencyPages.get(identity);
    if (cached !== undefined) {
      cacheOrder.delete(`p:${identity}`);
      cacheOrder.set(`p:${identity}`, "frequency");
      ranker.add_frequency(term, cached.page);
      return;
    }
    const page = new FrequencyPage(bytes);
    const charge = page.heap_bytes() + new TextEncoder().encode(identity).byteLength * 4 + 192;
    if (charge > MAX_CACHE_BYTES) {
      using cleanup = new DisposableStack();
      cleanup.use(page);
      ranker.add_frequency(term, page);
      return;
    }
    evictFor(charge);
    frequencyPages.set(identity, { page, bytes: charge });
    cacheOrder.set(`p:${identity}`, "frequency");
    frequencyBudget.bytes += charge;
    ranker.add_frequency(term, page);
  }

  function rememberDirectory(
    identity: string,
    headerBytes: number,
    directory: Directory,
    fingerprint?: ArrayBuffer,
    common = false,
  ) {
    const format = Match.value(common).pipe(
      Match.when(true, () => "directory-common-v3"),
      Match.orElse(() => "directory-v5"),
    );
    const admissionIdentity = `${identity}/0/${headerBytes}/${format}`;
    const bytes = directory.heap_bytes();
    const active = activeDirectories.get(admissionIdentity);
    if (active !== undefined && active.directory === undefined && bytes <= MAX_DECODED_BYTES) {
      active.directory = directory.retain();
      active.fingerprint = fingerprint;
    }
    if (directories.has(identity)) return;
    if (bytes > MAX_DECODED_CACHE_BYTES) return;
    const frequency = admissionCounts.get(admissionIdentity) ?? 1;
    const victims = [];
    const remaining = { bytes: decodedBudget.bytes };
    for (const [key, entry] of directories) {
      if (remaining.bytes + bytes <= MAX_DECODED_CACHE_BYTES) break;
      if (frequency <= (admissionCounts.get(entry.admissionIdentity) ?? 0)) return;
      victims.push(key);
      remaining.bytes -= entry.bytes;
    }
    for (const key of victims) {
      const entry = directories.get(key);
      directories.delete(key);
      entry?.directory.free();
    }
    directories.set(identity, { directory: directory.retain(), bytes, admissionIdentity });
    decodedBudget.bytes = remaining.bytes + bytes;
  }

  function directoryFrameByteLimit(headerBytes: number, common: boolean) {
    const overhead = Match.value(common).pipe(
      Match.when(true, () => 64 * 1024 + 8192),
      Match.orElse(() => 8192),
    );
    return Math.min(headerBytes + overhead, MAX_DIRECTORY_CACHE_BYTES);
  }

  const readSegmentCache = Effect.fn("kannin.readSegmentCache")(
    (url: URL, props: typeof SegmentCacheProps.Type) =>
      Effect.gen(function* () {
        const key = new URL(url);
        key.hostname = "raio-cache.internal";
        key.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
        key.searchParams.set("format", props.format);
        const cache = yield* Effect.tryPromise(() => caches.open("raio-segments-v1")).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (cache === undefined) return { key, cache, response: undefined };
        const response = yield* Effect.tryPromise(async (signal) => {
          const matched = await cache.match(key);
          if (signal.aborted) {
            if (matched?.body !== undefined && matched.body !== null) await matched.body.cancel();
            signal.throwIfAborted();
          }
          return matched;
        }).pipe(Effect.orElseSucceed(() => undefined));
        return { key, cache, response };
      }),
  );

  const acquireDirectoryFrame = Effect.fn("kannin.acquireDirectoryFrame")(
    (key: string, length: number, common: boolean = false) =>
      Effect.gen(function* () {
        const format = Match.value(common).pipe(
          Match.when(true, () => "directory-common-v3"),
          Match.orElse(() => "directory-v5"),
        );
        const identity = Match.value(common).pipe(
          Match.when(true, () => `${env.STORAGE_CACHE_SCOPE}:${key}/common-v3`),
          Match.orElse(() => `${env.STORAGE_CACHE_SCOPE}:${key}`),
        );
        const failures = Match.value(common).pipe(
          Match.when(true, () => directoryFrameFailures.common),
          Match.orElse(() => directoryFrameFailures.full),
        );
        if (length > MAX_DIRECTORY_CACHE_LENGTH)
          return yield* Effect.forkDetach(Effect.succeed(Option.none<Uint8Array>()));
        const units = Math.min(DIRECTORY_CACHE_UNITS, Math.ceil(length / DIRECTORY_CACHE_UNIT));
        const acquisition = directoryFrameAttempts.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeNanos;
            const observedFailure = failures.epoch;
            const acquired = yield* Effect.gen(function* () {
              if (
                (yield* Clock.currentTimeNanos) - started >= DIRECTORY_FRAME_BUDGET ||
                failures.epoch !== observedFailure
              )
                return Option.some(Option.none<Uint8Array>());
              return yield* directoryCacheReads.withPermitsIfAvailable(units)(
                Effect.gen(function* () {
                  reads.directoryR2CacheReads += 1;
                  const object = yield* Effect.tryPromise(() =>
                    env.STORAGE.get(`cache/${format}/${key}/${length}`),
                  );
                  if (object === null) return Option.none<Uint8Array>();
                  const source = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(TermProjectionRange),
                  )(object.customMetadata?.source).pipe(Effect.option);
                  if (
                    object.size > directoryFrameByteLimit(length, common) ||
                    Option.isNone(source) ||
                    source.value.key !== key ||
                    source.value.headerBytes !== length
                  ) {
                    yield* Effect.tryPromise(() => object.body.cancel());
                    reads.directoryR2CacheRejected += 1;
                    return Option.none<Uint8Array>();
                  }
                  const bytes = new Uint8Array(
                    yield* Effect.tryPromise(() => object.arrayBuffer()),
                  );
                  reads.directoryR2CacheBytes += bytes.byteLength;
                  const fingerprint = yield* Effect.tryPromise(() =>
                    crypto.subtle.digest("SHA-256", bytes),
                  );
                  const checked = yield* Effect.try(() => {
                    using directory = Match.value(common).pipe(
                      Match.when(true, () => Directory.common(bytes, length, MAX_DECODED_BYTES)),
                      Match.orElse(() => Directory.compressed(bytes, length, MAX_DECODED_BYTES)),
                    );
                    rememberDirectory(identity, length, directory, fingerprint, common);
                    return bytes;
                  }).pipe(Effect.option);
                  if (Option.isSome(checked)) reads.directoryR2CacheHits += 1;
                  else {
                    reads.directoryR2CacheRejected += 1;
                  }
                  return checked;
                }).pipe(
                  Effect.orElseSucceed(() => Option.none<Uint8Array>()),
                  Effect.tap((frame) =>
                    Effect.sync(() => {
                      if (Option.isNone(frame)) failures.epoch += 1n;
                    }),
                  ),
                  Effect.uninterruptible,
                ),
              );
            }).pipe(
              Effect.repeat({
                while: Option.isNone,
                schedule: Schedule.min([
                  Schedule.exponential("1 millis"),
                  Schedule.spaced("16 millis"),
                ]).pipe(Schedule.upTo({ duration: DIRECTORY_FRAME_BUDGET })),
              }),
            );
            return Option.flatten(acquired);
          }),
        );
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const reader = yield* Effect.forkDetach(
              acquisition.pipe(
                Effect.map(Option.flatten),
                Effect.orElseSucceed(() => Option.none<Uint8Array>()),
              ),
            );
            waitUntil(new Promise<void>((resolve) => reader.addObserver(() => resolve())));
            return reader;
          }),
        );
      }),
  );

  const waitDirectoryFrame = Effect.fn("kannin.waitDirectoryFrame")(
    (reader: Fiber.Fiber<Option.Option<Uint8Array>>) =>
      Fiber.join(reader).pipe(
        Effect.timeoutOption(DIRECTORY_FRAME_BUDGET),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (Option.isNone(result)) reads.directoryR2CacheTimeouts += 1;
          }),
        ),
      ),
  );

  function publishDirectoryFrame(
    key: string,
    length: number,
    bytes: Uint8Array,
    ctx?: BackgroundContext,
    common = false,
    condition?: ObjectCondition,
  ) {
    if (
      length > MAX_DIRECTORY_CACHE_LENGTH ||
      bytes.byteLength > directoryFrameByteLimit(length, common)
    )
      return false;
    const format = Match.value(common).pipe(
      Match.when(true, () => "directory-common-v3"),
      Match.orElse(() => "directory-v5"),
    );
    const identity = `cache/${format}/${key}/${length}`;
    const published = publishQueryCache(
      Match.value(condition).pipe(
        Match.when(undefined, () => `${env.STORAGE_CACHE_SCOPE}:${identity}`),
        Match.orElse(() => `${env.STORAGE_CACHE_SCOPE}:${identity}/conditional`),
      ),
      bytes.byteLength * 4 + identity.length * 4 + 192,
      Schema.encodeEffect(Schema.fromJsonString(TermProjectionRange))({
        key,
        headerBytes: length,
      }).pipe(
        Effect.orDie,
        Effect.flatMap((source) =>
          Effect.tryPromise(() => {
            if (condition !== undefined)
              return env.STORAGE.put(identity, new Uint8Array(bytes), {
                customMetadata: { source },
                onlyIf: condition,
              });
            return env.STORAGE.put(identity, new Uint8Array(bytes), { customMetadata: { source } });
          }),
        ),
        Effect.asVoid,
      ),
      ctx,
    );
    if (published) reads.directoryR2CachePublications += 1;
    return published;
  }

  async function range(
    key: string,
    offset: number,
    length: number,
    compressedDirectory = false,
    retain = true,
    directoryMiss?: typeof DirectoryCacheMiss.Type,
  ) {
    const resource = Match.value(compressedDirectory).pipe(
      Match.when(true, () => "directory-v5"),
      Match.orElse(() => "range"),
    );
    const rawIdentity = `${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${length}`;
    const cacheKey = Match.value(compressedDirectory).pipe(
      Match.when(true, () => `${rawIdentity}/directory-v5`),
      Match.orElse(() => rawIdentity),
    );
    const cached = Match.value(compressedDirectory).pipe(
      Match.when(true, () => {
        const frame = cachedEncodedDirectory(cacheKey);
        if (frame === undefined) return undefined;
        return frame.bytes();
      }),
      Match.orElse(() => cachedRange(cacheKey)),
    );
    if (cached !== undefined) return cached;
    if (compressedDirectory) noteDirectoryRequest(cacheKey);
    const pendingKey = `${cacheKey}/${retain}`;
    const pending = pendingRanges.get(pendingKey);
    if (pending !== undefined) return pending;
    const acquisition = (async () => {
      const input = Schema.encodeSync(SegmentRange)({ key, offset, length });
      const url = new URL(`https://segments.internal/${resource}`);
      url.searchParams.set("key", input.key);
      url.searchParams.set("offset", String(input.offset));
      url.searchParams.set("length", String(input.length));
      const props = Schema.encodeSync(SegmentCacheProps)({
        bucket: env.STORAGE_CACHE_SCOPE,
        format: "compact-json-v2",
      });
      const headers = new Headers();
      if (directoryMiss !== undefined)
        headers.set(
          "x-kannin-directory-miss",
          Schema.encodeSync(DirectoryCacheMiss)(directoryMiss),
        );
      reads.rangeReads += 1;
      const cachedRead = Effect.tryPromise({
        try: async (signal) => {
          const response = await runtime.segments({ props }).fetch(url, { signal, headers });
          const status = response.headers.get("cf-cache-status");
          if (status === "HIT") reads.workerCacheHits += 1;
          else if (status === "MISS") reads.workerCacheMisses += 1;
          if (status !== "HIT" && response.headers.get("x-raio-cache") === "api-hit")
            reads.cacheApiHits += 1;
          if (response.headers.get("x-raio-cache") === "r2-directory-hit")
            reads.directoryR2CacheOriginResponses += 1;
          if (!response.ok)
            throw new Rejected({
              status: 503,
              message: "Committed R2 segment unavailable",
              upstreamStatus: response.status,
              upstreamRay: response.headers.get("cf-ray"),
            });
          const bytes = new Uint8Array(await response.arrayBuffer());
          signal.throwIfAborted();
          if (compressedDirectory) {
            const fingerprint = await crypto.subtle.digest("SHA-256", bytes);
            signal.throwIfAborted();
            const active = activeDirectories.get(cacheKey);
            const known = active?.fingerprint;
            const digest = new Uint8Array(fingerprint);
            if (
              known === undefined ||
              !new Uint8Array(known).every((byte, index) => byte === digest[index])
            ) {
              using directory = Directory.compressed(bytes, length, MAX_DECODED_BYTES);
              if (active !== undefined)
                rememberDirectory(
                  `${env.STORAGE_CACHE_SCOPE}:${key}`,
                  length,
                  directory,
                  fingerprint,
                );
            }
          }
          return bytes;
        },
        catch: (cause) => {
          if (Schema.is(Rejected)(cause)) return cause;
          return new Cause.UnknownError(cause);
        },
      });
      const fallback = Effect.acquireUseRelease(
        Effect.gen(function* () {
          reads.rangeR2FallbackReads += 1;
          if (compressedDirectory) reads.directoryR2FallbackReads += 1;
          return yield* Effect.tryPromise(() =>
            env.STORAGE.get(key, { range: { offset, length } }),
          );
        }),
        (object) =>
          Effect.gen(function* () {
            if (object === null)
              return yield* new Rejected({
                status: 503,
                message: "Committed R2 segment unavailable",
              });
            const body = yield* Effect.tryPromise(() => object.arrayBuffer());
            reads.rangeR2FallbackBytes += body.byteLength;
            if (body.byteLength !== length)
              return yield* new Rejected({
                status: 503,
                message: "R2 range returned a truncated segment",
              });
            if (compressedDirectory) {
              reads.directoryR2FallbackBytes += body.byteLength;
              const frame = yield* Effect.gen(function* () {
                if (!activeDirectories.has(cacheKey))
                  return yield* Effect.try(() => directory_compress(new Uint8Array(body)));
                using directory = yield* Effect.try(() =>
                  Directory.canonical(new Uint8Array(body), length),
                );
                if (directory.heap_bytes() > MAX_DECODED_BYTES)
                  return yield* new Rejected({
                    status: 503,
                    message: "Segment directory exceeds the decoded-memory budget",
                  });
                const encoded = yield* Effect.try(() => directory.compressed_frame(length));
                rememberDirectory(`${env.STORAGE_CACHE_SCOPE}:${key}`, length, directory);
                return encoded;
              });
              publishDirectoryFrame(key, length, frame);
              return frame;
            }
            return new Uint8Array(body);
          }),
        (object) => {
          if (object === null || object.bodyUsed) return Effect.void;
          return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
        },
      ).pipe(Effect.uninterruptible);
      const directoryRecovery = Effect.gen(function* () {
        if (directoryMiss !== undefined) return yield* fallback;
        const reader = yield* acquireDirectoryFrame(key, length);
        const frame = Option.flatten(yield* waitDirectoryFrame(reader));
        if (Option.isSome(frame)) return frame.value;
        return yield* fallback;
      });
      const boundedRead = Effect.gen(function* () {
        const acquired = yield* cachedRead.pipe(Effect.timeoutOption("250 millis"));
        if (Option.isSome(acquired)) return acquired.value;
        reads.rangeCacheTimeouts += 1;
        return yield* fallback;
      });
      const bytes = await Effect.runPromise(
        Match.value(compressedDirectory).pipe(
          Match.when(true, () => {
            if (length > MAX_DIRECTORY_FALLBACK_LENGTH) return cachedRead;
            return Effect.race(
              cachedRead,
              Effect.gen(function* () {
                yield* Effect.sleep("250 millis");
                reads.rangeCacheTimeouts += 1;
                reads.directoryCacheTimeouts += 1;
                const attempt = Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const recovery = yield* Effect.forkDetach(
                      directoryFallbackReads.withPermitsIfAvailable(1)(directoryRecovery),
                    );
                    waitUntil(
                      new Promise<void>((resolve) => {
                        recovery.addObserver(() => resolve());
                      }),
                    );
                    return yield* restore(Fiber.join(recovery));
                  }),
                );
                const recovered = yield* attempt.pipe(
                  Effect.repeat({
                    while: Option.isNone,
                    schedule: Schedule.spaced("50 millis").pipe(
                      Schedule.upTo({ duration: "1 second" }),
                    ),
                  }),
                );
                return yield* Effect.fromOption(
                  recovered,
                  () =>
                    new Rejected({
                      status: 503,
                      message: "Directory recovery admission unavailable",
                    }),
                );
              }),
            );
          }),
          Match.orElse(() => {
            if (retain && length > SMALL_RANGE_LIMIT) return cachedRead;
            return smallRangeReads
              .withPermitsIfAvailable(Math.max(1, Math.ceil((length * 4) / SMALL_RANGE_BODY_UNIT)))(
                boundedRead,
              )
              .pipe(
                Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("1 millis") }),
                Effect.flatMap(
                  Option.match({ onNone: () => Effect.never, onSome: Effect.succeed }),
                ),
              );
          }),
        ),
      );
      reads.rangeBytes += bytes.byteLength;
      if (!compressedDirectory && bytes.byteLength !== length)
        throw new Rejected({ status: 503, message: "R2 range returned a truncated segment" });
      if (compressedDirectory) rememberEncodedDirectory(cacheKey, bytes, length);
      else if (retain) remember(cacheKey, bytes);
      return bytes;
    })();
    if (pendingRanges.size >= MAX_PENDING_RANGES) return acquisition;
    const shared = acquisition.then(
      (bytes) => {
        pendingRanges.delete(pendingKey);
        return bytes;
      },
      (cause: unknown) => {
        pendingRanges.delete(pendingKey);
        return Promise.reject(cause);
      },
    );
    pendingRanges.set(pendingKey, shared);
    return shared;
  }

  const acquireDirectory = Effect.fn("kannin.acquireDirectory")(
    (
      key: string,
      headerBytes: number,
      canonical: boolean,
      preferR2: boolean,
      query?: PreparedQuery,
      documentLookup: boolean = false,
    ) =>
      Effect.gen(function* () {
        const commonMiss = { value: false, observed: false };
        const commonAdmission = `${env.STORAGE_CACHE_SCOPE}:${key}/common-v3/0/${headerBytes}/directory-common-v3`;
        const directory = yield* Effect.gen(function* () {
          const identity = `${env.STORAGE_CACHE_SCOPE}:${key}`;
          const admissionIdentity = `${identity}/0/${headerBytes}/directory-v5`;
          const cached = directories.get(identity);
          if (cached !== undefined) {
            noteDirectoryRequest(admissionIdentity);
            reads.directoryCacheHits += 1;
            directories.delete(identity);
            directories.set(identity, cached);
            return cached.directory.retain();
          }
          const fullActive = activeDirectories.get(admissionIdentity)?.directory;
          if (fullActive !== undefined) {
            noteDirectoryRequest(admissionIdentity);
            return fullActive.retain();
          }
          if (documentLookup && query === undefined && !canonical) {
            const commonIdentity = `${identity}/common-v3`;
            const commonActive = activeDirectories.get(commonAdmission);
            const projected = directories.get(commonIdentity);
            const available = projected?.directory ?? commonActive?.directory;
            if (available !== undefined) {
              noteDirectoryRequest(commonAdmission);
              reads.directoryCacheHits += 1;
              reads.directoryCommonHits += 1;
              if (projected !== undefined) {
                directories.delete(commonIdentity);
                directories.set(commonIdentity, projected);
              }
              return available.retain();
            }
          }
          if (
            query !== undefined &&
            !canonical &&
            headerBytes <= MAX_DIRECTORY_CACHE_LENGTH &&
            !encodedDirectories.has(admissionIdentity)
          ) {
            const commonIdentity = `${identity}/common-v3`;
            const projected = directories.get(commonIdentity);
            const commonActive = activeDirectories.get(commonAdmission);
            const available = projected?.directory ?? commonActive?.directory;
            if (available !== undefined) {
              commonMiss.observed = true;
              if (available.covers_query(query)) {
                noteDirectoryRequest(commonAdmission);
                reads.directoryCacheHits += 1;
                reads.directoryCommonHits += 1;
                if (projected !== undefined) {
                  directories.delete(commonIdentity);
                  directories.set(commonIdentity, projected);
                }
                return available.retain();
              }
            } else {
              const previous = commonActive?.acquisition ?? Option.none();
              const commonAcquire = Effect.gen(function* () {
                const acquired = { frame: Option.none<Uint8Array>() };
                if (Option.isSome(previous)) {
                  const completion = previous.value;
                  const exit = yield* Effect.promise(() => completion);
                  yield* exit;
                } else {
                  const decoded = yield* Effect.try(() => {
                    const frame = cachedEncodedDirectory(commonAdmission);
                    if (frame === undefined) return undefined;
                    return frame.directory(MAX_DECODED_BYTES);
                  });
                  if (decoded !== undefined) {
                    commonMiss.observed = true;
                    if (!decoded.covers_query(query)) {
                      decoded.free();
                      return undefined;
                    }
                    rememberDirectory(commonIdentity, headerBytes, decoded, undefined, true);
                    return decoded;
                  }
                  const reader = yield* acquireDirectoryFrame(key, headerBytes, true);
                  acquired.frame = Option.flatten(yield* waitDirectoryFrame(reader));
                  if (Option.isSome(acquired.frame)) commonMiss.observed = true;
                }
                const shared =
                  commonActive?.directory ?? directories.get(commonIdentity)?.directory;
                if (shared !== undefined) commonMiss.observed = true;
                if (shared === undefined || !shared.covers_query(query)) return undefined;
                noteDirectoryRequest(commonAdmission);
                if (Option.isSome(acquired.frame))
                  rememberEncodedDirectory(
                    commonAdmission,
                    acquired.frame.value,
                    headerBytes,
                    true,
                  );
                return shared.retain();
              });
              const selected = yield* Effect.gen(function* () {
                if (commonActive === undefined || Option.isSome(previous))
                  return yield* commonAcquire;
                const completion =
                  Promise.withResolvers<Exit.Exit<void, Cause.UnknownError | Rejected>>();
                commonActive.acquisition = Option.some(completion.promise);
                return yield* commonAcquire.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => completion.resolve(Exit.map(exit, () => undefined))),
                  ),
                );
              });
              if (selected !== undefined) {
                reads.directoryCommonHits += 1;
                return selected;
              }
            }
            commonMiss.value = !commonMiss.observed;
          }
          const retained = activeDirectories.get(admissionIdentity);
          if (retained?.directory !== undefined) {
            noteDirectoryRequest(admissionIdentity);
            return retained.directory.retain();
          }
          if (
            (canonical || preferR2) &&
            retained !== undefined &&
            Option.isSome(retained.acquisition)
          ) {
            const completion = retained.acquisition.value;
            const exit = yield* Effect.promise(() => completion);
            yield* exit;
            const shared = activeDirectories.get(admissionIdentity)?.directory;
            if (shared === undefined)
              return yield* new Rejected({
                status: 503,
                message: "Shared directory acquisition did not retain metadata",
              });
            return shared.retain();
          }
          if (!canonical) {
            const decoded = yield* Effect.try(() => {
              const frame = cachedEncodedDirectory(admissionIdentity);
              if (frame === undefined) return undefined;
              return frame.directory(MAX_DECODED_BYTES);
            });
            if (decoded !== undefined) {
              if (decoded.heap_bytes() > MAX_DECODED_BYTES) {
                decoded.free();
                return yield* new Rejected({
                  status: 503,
                  message: "Segment directory exceeds the decoded-memory budget",
                });
              }
              rememberDirectory(identity, headerBytes, decoded);
              return decoded;
            }
          }
          const acquire = Effect.gen(function* () {
            if (!canonical && preferR2 && headerBytes <= MAX_DIRECTORY_CACHE_LENGTH) {
              const apiFrame = yield* Effect.gen(function* () {
                const input = yield* Schema.encodeEffect(SegmentRange)({
                  key,
                  offset: 0,
                  length: headerBytes,
                });
                const url = new URL("https://segments.internal/directory-v5");
                url.searchParams.set("key", input.key);
                url.searchParams.set("offset", String(input.offset));
                url.searchParams.set("length", String(input.length));
                const props = yield* Schema.encodeEffect(SegmentCacheProps)({
                  bucket: env.STORAGE_CACHE_SCOPE,
                  format: "compact-json-v2",
                });
                return yield* Effect.acquireUseRelease(
                  readSegmentCache(url, props).pipe(Effect.interruptible),
                  (selected) =>
                    Effect.gen(function* () {
                      const response = selected.response;
                      if (response === undefined) return Option.none<Uint8Array>();
                      const units = Math.min(
                        DIRECTORY_CACHE_UNITS,
                        Math.ceil(headerBytes / DIRECTORY_CACHE_UNIT),
                      );
                      return yield* directoryCacheReads.withPermitsIfAvailable(units)(
                        Effect.acquireUseRelease(
                          Effect.try(() => response.body?.getReader()),
                          (reader) =>
                            Effect.gen(function* () {
                              if (!response.ok || reader === undefined)
                                return yield* new Cause.UnknownError(
                                  "Invalid cached directory response",
                                );
                              const chunks: Uint8Array[] = [];
                              const total = { bytes: 0 };
                              for (;;) {
                                const part = yield* Effect.tryPromise(() => reader.read());
                                if (part.done) break;
                                const chunk = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(
                                  part.value,
                                );
                                total.bytes += chunk.byteLength;
                                if (total.bytes > directoryFrameByteLimit(headerBytes, false))
                                  return yield* new Cause.UnknownError(
                                    "Cached directory exceeds byte budget",
                                  );
                                chunks.push(chunk);
                              }
                              const bytes = new Uint8Array(total.bytes);
                              const cursor = { offset: 0 };
                              for (const chunk of chunks) {
                                bytes.set(chunk, cursor.offset);
                                cursor.offset += chunk.byteLength;
                              }
                              return bytes;
                            }),
                          (reader) => {
                            if (reader === undefined) return Effect.void;
                            return Effect.tryPromise(() => reader.cancel()).pipe(
                              Effect.ignore,
                              Effect.andThen(
                                Effect.try(() => reader.releaseLock()).pipe(Effect.ignore),
                              ),
                            );
                          },
                        ),
                      );
                    }),
                  (selected) => {
                    const response = selected.response;
                    if (response === undefined) return Effect.void;
                    const body = response.body;
                    if (body === null || response.bodyUsed) return Effect.void;
                    return Effect.tryPromise(() => body.cancel()).pipe(Effect.ignore);
                  },
                );
              }).pipe(
                Effect.interruptible,
                Effect.timeoutOption(DIRECTORY_FRAME_BUDGET),
                Effect.map(Option.flatten),
                Effect.orElseSucceed(() => Option.none()),
              );
              if (Option.isSome(apiFrame)) {
                const apiDirectory = yield* Effect.try(() => {
                  using decoded = Directory.compressed(
                    apiFrame.value,
                    headerBytes,
                    MAX_DECODED_BYTES,
                  );
                  noteDirectoryRequest(admissionIdentity);
                  rememberDirectory(identity, headerBytes, decoded);
                  rememberEncodedDirectory(admissionIdentity, apiFrame.value, headerBytes);
                  reads.cacheApiHits += 1;
                  return decoded.retain();
                }).pipe(Effect.option);
                if (Option.isSome(apiDirectory)) return apiDirectory.value;
              }
            }
            const observed = yield* Effect.gen(function* () {
              if (!canonical && !preferR2) return Option.none<Option.Option<Uint8Array>>();
              return yield* Effect.flatMap(
                acquireDirectoryFrame(key, headerBytes),
                waitDirectoryFrame,
              );
            });
            const frame = Option.flatten(observed);
            const directoryMiss = Match.value(
              preferR2 &&
                headerBytes <= MAX_DIRECTORY_CACHE_LENGTH &&
                Option.isSome(observed) &&
                Option.isNone(observed.value),
            ).pipe(
              Match.when(true, () => "known" as const),
              Match.orElse(() => undefined),
            );
            if (Option.isSome(frame)) {
              if (preferR2) {
                noteDirectoryRequest(admissionIdentity);
                rememberEncodedDirectory(admissionIdentity, frame.value, headerBytes);
              }
              const recovered =
                activeDirectories.get(admissionIdentity)?.directory ??
                directories.get(identity)?.directory;
              if (recovered !== undefined) return recovered.retain();
            }
            const decode = Effect.gen(function* () {
              const bytes = yield* Effect.gen(function* () {
                if (Option.isSome(frame)) return frame.value;
                if (!canonical)
                  return yield* Effect.tryPromise({
                    try: () => range(key, 0, headerBytes, true, true, directoryMiss),
                    catch: (cause) => {
                      if (Schema.is(Rejected)(cause)) return cause;
                      return new Cause.UnknownError(cause);
                    },
                  });
                noteDirectoryRequest(admissionIdentity);
                reads.rangeR2FallbackReads += 1;
                reads.directoryR2FallbackReads += 1;
                return yield* Effect.acquireUseRelease(
                  Effect.tryPromise(() =>
                    env.STORAGE.get(key, { range: { offset: 0, length: headerBytes } }),
                  ),
                  (object) =>
                    Effect.gen(function* () {
                      if (object === null)
                        return yield* new Rejected({
                          status: 503,
                          message: "Committed R2 segment unavailable",
                        });
                      const body = yield* Effect.tryPromise(() => object.arrayBuffer());
                      reads.rangeR2FallbackBytes += body.byteLength;
                      reads.directoryR2FallbackBytes += body.byteLength;
                      if (body.byteLength !== headerBytes)
                        return yield* new Rejected({
                          status: 503,
                          message: "R2 range returned a truncated segment",
                        });
                      return new Uint8Array(body);
                    }),
                  (object) => {
                    if (object === null || object.bodyUsed) return Effect.void;
                    return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
                  },
                ).pipe(Effect.uninterruptible);
              });
              if (!canonical) {
                const concurrent = directories.get(identity);
                if (concurrent !== undefined) return concurrent.directory.retain();
                const active = activeDirectories.get(admissionIdentity);
                if (active?.directory !== undefined) return active.directory.retain();
              }
              const decoded = yield* Effect.try(() => {
                if (canonical && Option.isNone(frame))
                  return Directory.canonical(bytes, headerBytes);
                if (!canonical) {
                  const cachedFrame = encodedDirectories.get(admissionIdentity);
                  if (cachedFrame !== undefined) return cachedFrame.directory(MAX_DECODED_BYTES);
                }
                return Directory.compressed(bytes, headerBytes, MAX_DECODED_BYTES);
              });
              if (decoded.heap_bytes() > MAX_DECODED_BYTES) {
                decoded.free();
                return yield* new Rejected({
                  status: 503,
                  message: "Segment directory exceeds the decoded-memory budget",
                });
              }
              rememberDirectory(identity, headerBytes, decoded);
              return decoded;
            });
            if (!canonical || Option.isSome(frame)) return yield* decode;
            return yield* canonicalHeaderReads
              .withPermitsIfAvailable(Math.ceil(headerBytes / CANONICAL_HEADER_UNIT))(
                decode.pipe(Effect.uninterruptible),
              )
              .pipe(
                Effect.repeat({
                  while: Option.isNone,
                  schedule: Schedule.min([
                    Schedule.exponential("1 millis"),
                    Schedule.spaced("16 millis"),
                  ]).pipe(Schedule.upTo({ duration: "2 seconds" })),
                }),
                Effect.flatMap(
                  Option.match({
                    onSome: Effect.succeed,
                    onNone: () =>
                      new Rejected({
                        status: 503,
                        message: "Canonical directory admission unavailable",
                      }),
                  }),
                ),
              );
          });
          if (canonical || preferR2) {
            if (retained === undefined) return yield* acquire;
            const completion =
              Promise.withResolvers<Exit.Exit<void, Cause.UnknownError | Rejected>>();
            retained.acquisition = Option.some(completion.promise);
            return yield* acquire.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => completion.resolve(Exit.map(exit, () => undefined))),
              ),
            );
          }
          return yield* acquire;
        });
        const publication = `${env.STORAGE_CACHE_SCOPE}:cache/directory-common-v3/${key}/${headerBytes}`;
        if (
          commonMiss.value &&
          !pendingQueryPublications.has(publication) &&
          !pendingQueryPublications.has(`${publication}/conditional`)
        ) {
          const frame = yield* Effect.try(() => directory.common_frame(headerBytes)).pipe(
            Effect.option,
          );
          if (Option.isSome(frame)) {
            publishDirectoryFrame(key, headerBytes, frame.value, undefined, true, {
              etagDoesNotMatch: "*",
            });
          }
        }
        return directory;
      }),
  );

  const withDirectory = Effect.fn("raio.withDirectory")(
    <A, E, R>(
      key: string,
      headerBytes: number,
      use: (directory: Directory) => Effect.Effect<A, E, R>,
      permits?: Semaphore.Semaphore,
      canonical = false,
      preferR2 = false,
      query?: PreparedQuery,
      documentLookup: boolean = false,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const fullIdentity = `${env.STORAGE_CACHE_SCOPE}:${key}/0/${headerBytes}/directory-v5`;
          const identities = [fullIdentity];
          if (query !== undefined)
            identities.push(
              `${env.STORAGE_CACHE_SCOPE}:${key}/common-v3/0/${headerBytes}/directory-common-v3`,
            );
          return identities.map((identity) => {
            const existing = activeDirectories.get(identity);
            if (existing !== undefined) {
              existing.readers += 1;
              return { identity, active: existing };
            }
            const active = {
              readers: 1,
              directory: undefined,
              fingerprint: undefined,
              acquisition: Option.none<Promise<Exit.Exit<void, Cause.UnknownError | Rejected>>>(),
            };
            if (activeDirectories.size < MAX_PENDING_RANGES)
              activeDirectories.set(identity, active);
            return { identity, active };
          });
        }),
        () =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              const acquire = acquireDirectory(
                key,
                headerBytes,
                canonical && headerBytes <= MAX_DIRECTORY_CACHE_LENGTH,
                preferR2,
                query,
                documentLookup,
              );
              if (permits === undefined) return yield* acquire;
              return yield* permits.withPermit(acquire);
            }),
            use,
            (directory) => Effect.sync(() => directory.free()),
          ),
        (retained) =>
          Effect.sync(() => {
            for (const { identity, active } of retained) {
              active.readers -= 1;
              if (active.readers === 0) {
                if (activeDirectories.get(identity) === active) activeDirectories.delete(identity);
                active.directory?.free();
              }
            }
          }),
      ),
  );

  function rememberOverview(identity: string, bytes: Uint8Array) {
    const previous = overviewBuffers.get(identity);
    const keyBytes = new TextEncoder().encode(identity).byteLength * 4 + 128;
    if (previous !== undefined) overviewBudget.bytes -= previous.byteLength + keyBytes;
    overviewBuffers.delete(identity);
    const charge = bytes.byteLength + keyBytes;
    if (charge > MAX_OVERVIEW_BYTES) return;
    while (overviewBudget.bytes + charge > MAX_OVERVIEW_BYTES) {
      const oldest = overviewBuffers.entries().next().value;
      if (oldest === undefined) break;
      overviewBuffers.delete(oldest[0]);
      overviewBudget.bytes -=
        oldest[1].byteLength + new TextEncoder().encode(oldest[0]).byteLength * 4 + 128;
    }
    overviewBuffers.set(identity, bytes);
    overviewBudget.bytes += charge;
  }

  const storeOverviewBatch = Effect.fn("kannin.storeOverviewBatch")(
    (key: string, encoded: string) =>
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode(encoded);
        if (bytes.byteLength > 512 * 1024) return;
        const frame = yield* Effect.try(() => pack(encoded));
        if (frame.byteLength > 512 * 1024) return;
        const metadata = yield* Schema.encodeEffect(OverviewFrameMetadata)({
          rawBytes: bytes.byteLength,
        }).pipe(Effect.orDie);
        yield* Effect.tryPromise(() =>
          env.STORAGE.put(key, new Uint8Array(frame), { customMetadata: metadata }),
        );
      }),
    Effect.asVoid,
  );

  const warmTermBatch = Effect.fn("kannin.warmTermBatch")(
    (segments: Readonly<typeof Root.Type.segments>, ctx: BackgroundContext) =>
      Effect.gen(function* () {
        if (segments.length % 8 !== 0) return;
        const ranges = segments.slice(-8).map((segment) => ({
          key: segment.key,
          headerBytes: segment.headerBytes,
        }));
        const first = ranges[0];
        if (first === undefined) return;
        const overviews = ranges
          .map((source) =>
            overviewBuffers.get(`${env.STORAGE_CACHE_SCOPE}:${source.key}/${source.headerBytes}`),
          )
          .filter((bytes) => bytes !== undefined);
        if (overviews.length !== ranges.length) return;
        if (overviews.reduce((total, bytes) => total + bytes.byteLength, 0) > 384 * 1024) return;
        const encoded = yield* encodeOverviewBatch({
          bucket: env.STORAGE_CACHE_SCOPE,
          ranges,
          overviews,
        });
        const bytes = new TextEncoder().encode(encoded);
        if (bytes.byteLength > 512 * 1024) return;
        const encodedRanges = yield* Schema.encodeEffect(
          Schema.fromJsonString(TermProjectionProps.fields.ranges),
        )(ranges);
        const digest = yield* Effect.tryPromise(() => sha256(encodedRanges));
        const identity = new URL("https://overviews.internal/batch-v8");
        identity.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
        identity.searchParams.set("ranges", digest);
        publishQueryCache(
          identity.href,
          bytes.byteLength * 4 + identity.href.length * 4 + 128,
          storeOverviewBatch(`cache/correlated-pool-batches-v3/${first.key}/${digest}`, encoded),
          ctx,
        );
      }).pipe(Effect.orElseSucceed(() => undefined)),
  );

  const pendingOverviewBatches = new Map<
    string,
    Promise<Option.Option<Effect.Success<ReturnType<typeof readStoredOverviewBatch>>>>
  >();
  const OVERVIEW_BATCH_BUDGET = 1_000_000_000n;
  const readStoredOverviewBatch = Effect.fn("kannin.readStoredOverviewBatch")(
    (key: string, encodedRanges: string) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeNanos;
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise(() => env.STORAGE.get(key)),
          (object) =>
            Effect.gen(function* () {
              if (
                object === null ||
                object.size > 512 * 1024 ||
                (yield* Clock.currentTimeNanos) - started >= OVERVIEW_BATCH_BUDGET
              )
                return undefined;
              const metadata = yield* Schema.decodeUnknownEffect(OverviewFrameMetadata)(
                object.customMetadata,
              );
              const units = Math.ceil(
                Math.max(object.size, metadata.rawBytes * 4) / OVERVIEW_BODY_UNIT,
              );
              const acquired = yield* overviewBodyReads
                .withPermitsIfAvailable(units)(
                  Effect.gen(function* () {
                    if ((yield* Clock.currentTimeNanos) - started >= OVERVIEW_BATCH_BUDGET)
                      return undefined;
                    const bytes = yield* Effect.tryPromise(() => object.arrayBuffer());
                    if ((yield* Clock.currentTimeNanos) - started >= OVERVIEW_BATCH_BUDGET)
                      return undefined;
                    if (
                      bytes.byteLength !== object.size ||
                      bytes.byteLength < 16 ||
                      new DataView(bytes).getUint32(8, true) !== metadata.rawBytes
                    )
                      return undefined;
                    const encoded = yield* Effect.try(() => unpack(new Uint8Array(bytes)));
                    const candidate = yield* decodeOverviewBatch(encoded);
                    const source = yield* Schema.encodeEffect(
                      Schema.fromJsonString(TermProjectionProps.fields.ranges),
                    )(candidate.ranges);
                    if (
                      candidate.bucket !== env.STORAGE_CACHE_SCOPE ||
                      source !== encodedRanges ||
                      candidate.overviews.length !== candidate.ranges.length
                    )
                      return undefined;
                    return { value: candidate, encoded, encodedBytes: object.size };
                  }).pipe(Effect.uninterruptible),
                )
                .pipe(
                  Effect.repeat({
                    while: Option.isNone,
                    schedule: Schedule.min([
                      Schedule.exponential("1 millis"),
                      Schedule.spaced("16 millis"),
                    ]).pipe(Schedule.upTo({ duration: OVERVIEW_BATCH_BUDGET })),
                  }),
                );
              return Option.getOrUndefined(acquired);
            }),
          (object) => {
            if (object === null || object.bodyUsed) return Effect.void;
            return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
          },
        );
      }).pipe(Effect.orElseSucceed(() => undefined)),
  );

  async function acquireStoredOverviewBatch(
    key: string,
    encodedRanges: string,
    ctx: BackgroundContext,
  ) {
    const selected = { completion: pendingOverviewBatches.get(key), started: false };
    if (selected.completion === undefined) {
      if (pendingOverviewBatches.size >= 16)
        return { started: false, result: Option.some(undefined) };
      selected.started = true;
      const source = Effect.runPromise(readStoredOverviewBatch(key, encodedRanges));
      const completion = Effect.runPromise(
        Effect.tryPromise(() => source).pipe(
          Effect.timeoutOption(OVERVIEW_BATCH_BUDGET),
          Effect.orElseSucceed(() => Option.some(undefined)),
        ),
      );
      selected.completion = completion;
      pendingOverviewBatches.set(key, completion);
      ctx.waitUntil(
        source
          .finally(() => {
            if (pendingOverviewBatches.get(key) === completion) pendingOverviewBatches.delete(key);
          })
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    }
    return { started: selected.started, result: await selected.completion };
  }

  const OVERVIEW_CACHE_BUDGET = 50_000_000n;
  const overviewCacheBodies = Semaphore.makeUnsafe(1);
  const readCachedOverviewBatch = Effect.fn("kannin.readCachedOverviewBatch")(
    function* (key: string, encodedRanges: string) {
      const started = yield* Clock.currentTimeNanos;
      const cache = yield* Effect.tryPromise(() => caches.open("raio-overview-batches-v8"));
      if ((yield* Clock.currentTimeNanos) - started >= OVERVIEW_CACHE_BUDGET) return undefined;
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise(() => cache.match(key)),
        (response) =>
          Effect.gen(function* () {
            if (response === undefined) return { cache, candidate: undefined };
            if ((yield* Clock.currentTimeNanos) - started >= OVERVIEW_CACHE_BUDGET)
              return undefined;
            const acquired = yield* overviewCacheBodies
              .withPermitsIfAvailable(1)(
                Effect.gen(function* () {
                  const remaining =
                    OVERVIEW_CACHE_BUDGET - ((yield* Clock.currentTimeNanos) - started);
                  const body = response.body;
                  if (remaining <= 0n || body === null) return undefined;
                  const consumed = yield* Effect.acquireUseRelease(
                    Effect.sync(() => body.getReader()),
                    (reader) =>
                      Effect.gen(function* () {
                        const chunks: Array<Uint8Array> = [];
                        const count = { bytes: 0 };
                        while (true) {
                          const chunk = yield* Effect.tryPromise(() => reader.read());
                          if (chunk.done) break;
                          const value = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(
                            chunk.value,
                          );
                          count.bytes += value.byteLength;
                          if (count.bytes > 4 * 1024 * 1024 + 128 * 1024) return undefined;
                          chunks.push(value);
                        }
                        const bytes = new Uint8Array(count.bytes);
                        const cursor = { offset: 0 };
                        for (const chunk of chunks) {
                          bytes.set(chunk, cursor.offset);
                          cursor.offset += chunk.byteLength;
                        }
                        return new TextDecoder().decode(bytes);
                      }).pipe(Effect.timeoutOption(remaining)),
                    (reader) =>
                      Effect.tryPromise(() => reader.cancel()).pipe(
                        Effect.ignore,
                        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
                      ),
                  );
                  const encoded = Option.getOrUndefined(consumed);
                  if (encoded === undefined) return undefined;
                  if ((yield* Clock.currentTimeNanos) - started >= OVERVIEW_CACHE_BUDGET)
                    return undefined;
                  const candidate = yield* decodeOverviewBatch(encoded).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  if (
                    candidate === undefined ||
                    candidate.bucket !== env.STORAGE_CACHE_SCOPE ||
                    candidate.overviews.length !== candidate.ranges.length ||
                    (yield* Schema.encodeEffect(
                      Schema.fromJsonString(TermProjectionProps.fields.ranges),
                    )(candidate.ranges)) !== encodedRanges
                  )
                    return undefined;
                  return candidate;
                }),
              )
              .pipe(
                Effect.repeat({
                  while: Option.isNone,
                  schedule: Schedule.min([
                    Schedule.exponential("1 millis"),
                    Schedule.spaced("4 millis"),
                  ]).pipe(Schedule.upTo({ duration: OVERVIEW_CACHE_BUDGET })),
                }),
              );
            return { cache, candidate: Option.getOrUndefined(acquired) };
          }),
        (response) => {
          if (response === undefined || response.bodyUsed) return Effect.void;
          const body = response.body;
          if (body === null) return Effect.void;
          return Effect.tryPromise(() => body.cancel()).pipe(Effect.ignore);
        },
      );
    },
    Effect.orElseSucceed(() => undefined),
  );
  const pendingOverviewCache = new Map<
    string,
    Promise<Option.Option<Effect.Success<ReturnType<typeof readCachedOverviewBatch>>>>
  >();

  async function acquireCachedOverviewBatch(
    key: string,
    encodedRanges: string,
    ctx: BackgroundContext,
  ) {
    const selected = { completion: pendingOverviewCache.get(key) };
    if (selected.completion === undefined) {
      if (pendingOverviewCache.size >= 16) return undefined;
      const source = Effect.runPromise(readCachedOverviewBatch(key, encodedRanges));
      const completion = Effect.runPromise(
        Effect.tryPromise(() => source).pipe(Effect.timeoutOption(OVERVIEW_CACHE_BUDGET)),
      );
      selected.completion = completion;
      pendingOverviewCache.set(key, completion);
      ctx.waitUntil(
        source.finally(() => {
          if (pendingOverviewCache.get(key) === completion) pendingOverviewCache.delete(key);
        }),
      );
    }
    return Option.getOrUndefined(await selected.completion);
  }

  const readTermProjections = Effect.fn("kannin.readTermProjections")(
    (
      ranges: ReadonlyArray<typeof TermProjectionRange.Type>,
      requestedTerms: typeof TermProjectionProps.Type.terms,
      actualFilters: typeof TermFilters.Type,
      prefixes: ReadonlyArray<typeof CommonTerms.Type> | undefined,
      ctx: BackgroundContext,
    ) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeNanos;
        const usedRootFallback = { value: false };
        const terms = encodeProjectionTerms(requestedTerms);
        const filters = yield* Schema.encodeEffect(TermFilters)(actualFilters);
        const allowRootFallback =
          prefixes !== undefined &&
          prefixes.length === ranges.length &&
          actualFilters.length === 0 &&
          prefixes.every((prefix) => requestedTerms.every((term) => Object.hasOwn(prefix, term)));
        const telemetry = {
          memoryHits: 0,
          overviewCacheHits: 0,
          overviewCacheLookups: 0,
          batchReads: 0,
          batchHits: 0,
          batchBytes: 0,
          batchMs: 0,
          batchTimeouts: 0,
          r2Reads: 0,
          r2Peak: 0,
          r2Hits: 0,
          r2Bytes: 0,
          fallbackDirectories: 0,
          overviewCacheMs: 0,
          r2Ms: 0,
          projectMs: 0,
          fallbackMs: 0,
          publishMs: 0,
          entryMs: 0,
          totalMs: 0,
        };
        const inspected = yield* Effect.forEach(
          ranges,
          (input, index) =>
            Effect.gen(function* () {
              const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`;
              const bytes = overviewBuffers.get(identity);
              if (bytes === undefined) return undefined;
              const projectedAt = yield* Clock.currentTimeNanos;
              const catalog = yield* Effect.try(() =>
                segment_overview_project(bytes, terms, filters),
              ).pipe(
                Effect.flatMap(decodeTermCatalog),
                Effect.orElseSucceed(() => undefined),
              );
              telemetry.projectMs += Number((yield* Clock.currentTimeNanos) - projectedAt) / 1e6;
              if (catalog === undefined || (allowRootFallback && catalog.partitions === null)) {
                if (catalog === undefined) {
                  overviewBuffers.delete(identity);
                  overviewBudget.bytes -=
                    bytes.byteLength + new TextEncoder().encode(identity).byteLength * 4 + 128;
                }
                return undefined;
              }
              return { index, identity, bytes, catalog };
            }),
          { concurrency: 1 },
        );
        const hits = inspected.filter((hit) => hit !== undefined);
        if (hits.length === ranges.length) {
          for (const hit of hits) rememberOverview(hit.identity, hit.bytes);
          reads.overviewMemoryHits += hits.length;
          telemetry.memoryHits = hits.length;
          telemetry.totalMs = Number((yield* Clock.currentTimeNanos) - started) / 1e6;
          return { catalogs: hits.map((hit) => hit.catalog), telemetry, rootFallback: false };
        }
        const cacheKey = new URL("https://overviews.internal/batch-v8");
        cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
        const encodedRanges = yield* Schema.encodeEffect(
          Schema.fromJsonString(TermProjectionProps.fields.ranges),
        )(ranges);
        const rangesDigest = yield* Effect.tryPromise(() => sha256(encodedRanges));
        cacheKey.searchParams.set("ranges", rangesDigest);
        const cacheStarted = yield* Clock.currentTimeNanos;
        const acquiredCache = yield* Effect.tryPromise(() =>
          acquireCachedOverviewBatch(cacheKey.href, encodedRanges, ctx),
        );
        const cache = acquiredCache?.cache;
        if (cache !== undefined) {
          reads.overviewCacheApiLookups += 1;
          telemetry.overviewCacheLookups += 1;
          const candidate = acquiredCache?.candidate;
          if (candidate !== undefined) {
            telemetry.overviewCacheMs +=
              Number((yield* Clock.currentTimeNanos) - cacheStarted) / 1e6;
            const projectedAt = yield* Clock.currentTimeNanos;
            const projected = yield* Effect.forEach(
              candidate.overviews,
              (bytes) =>
                Effect.try(() => segment_overview_project(bytes, terms, filters)).pipe(
                  Effect.flatMap(decodeTermCatalog),
                ),
              { concurrency: 1 },
            ).pipe(Effect.orElseSucceed(() => undefined));
            telemetry.projectMs += Number((yield* Clock.currentTimeNanos) - projectedAt) / 1e6;
            if (
              projected !== undefined &&
              (!allowRootFallback || projected.every((catalog) => catalog.partitions !== null))
            ) {
              for (const [index, bytes] of candidate.overviews.entries()) {
                const input = ranges[index];
                if (input === undefined)
                  return yield* new Rejected({
                    status: 503,
                    message: "Overview batch added a segment",
                  });
                rememberOverview(
                  `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`,
                  bytes,
                );
              }
              reads.overviewCacheApiHits += candidate.overviews.length;
              telemetry.overviewCacheHits = candidate.overviews.length;
              telemetry.totalMs = Number((yield* Clock.currentTimeNanos) - started) / 1e6;
              return { catalogs: projected, telemetry, rootFallback: false };
            }
          }
        }
        if (telemetry.overviewCacheMs === 0)
          telemetry.overviewCacheMs = Number((yield* Clock.currentTimeNanos) - cacheStarted) / 1e6;
        const first = ranges[0];
        const batch = { key: Option.none<string>() };
        if (first !== undefined && ranges.length >= 8) {
          const identity = `cache/correlated-pool-batches-v3/${first.key}/${rangesDigest}`;
          batch.key = Option.some(identity);
          const fetchedAt = yield* Clock.currentTimeNanos;
          const acquired = yield* Effect.tryPromise(() =>
            acquireStoredOverviewBatch(identity, encodedRanges, ctx),
          );
          if (acquired.started) telemetry.batchReads += 1;
          const result = acquired.result;
          if (Option.isNone(result)) telemetry.batchTimeouts += 1;
          else if (result.value !== undefined) {
            const loaded = result.value;
            const candidate = loaded.value;
            const projected = yield* Effect.forEach(
              candidate.overviews,
              (bytes) =>
                Effect.try(() => segment_overview_project(bytes, terms, filters)).pipe(
                  Effect.flatMap(decodeTermCatalog),
                ),
              { concurrency: 1 },
            ).pipe(Effect.orElseSucceed(() => undefined));
            if (
              projected !== undefined &&
              (!allowRootFallback || projected.every((catalog) => catalog.partitions !== null))
            ) {
              for (const [index, bytes] of candidate.overviews.entries()) {
                const input = ranges[index];
                if (input !== undefined)
                  rememberOverview(
                    `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`,
                    bytes,
                  );
              }
              if (cache !== undefined) {
                const bytes = new TextEncoder().encode(loaded.encoded);
                publishQueryCache(
                  cacheKey.href,
                  bytes.byteLength * 4 + cacheKey.href.length * 4 + 128,
                  Effect.tryPromise(() =>
                    cache.put(
                      cacheKey,
                      new Response(new Uint8Array(bytes), {
                        headers: {
                          "cache-control": "public, max-age=31536000, immutable",
                          "content-type": "application/json",
                        },
                      }),
                    ),
                  ),
                  ctx,
                );
              }
              telemetry.batchHits += 1;
              if (acquired.started) telemetry.batchBytes = loaded.encodedBytes;
              telemetry.batchMs = Number((yield* Clock.currentTimeNanos) - fetchedAt) / 1e6;
              telemetry.totalMs = Number((yield* Clock.currentTimeNanos) - started) / 1e6;
              return { catalogs: projected, telemetry, rootFallback: false };
            }
          }

          telemetry.batchMs = Number((yield* Clock.currentTimeNanos) - fetchedAt) / 1e6;
        }
        const sources: Array<(typeof OverviewBatch.Type)[number]> = [];
        const admission = { bytes: 0, enabled: true };
        const r2Activity = { count: 0 };
        const fallbackCapacity = 2;
        const fallbackReads = Semaphore.makeUnsafe(fallbackCapacity);
        const catalogs = yield* Effect.forEach(
          ranges,
          (input, index) =>
            Effect.gen(function* () {
              const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`;
              const hit = hits.find((entry) => entry.index === index);
              const selected = { bytes: hit?.bytes, catalog: hit?.catalog };
              if (selected.bytes === undefined || selected.catalog === undefined) {
                const prefetched = yield* Effect.gen(function* () {
                  reads.correlatedReads += 1;
                  telemetry.r2Reads += 1;
                  r2Activity.count += 1;
                  telemetry.r2Peak = Math.max(telemetry.r2Peak, r2Activity.count);
                  const r2Started = yield* Clock.currentTimeNanos;
                  const cached = yield* Effect.acquireUseRelease(
                    Effect.tryPromise(() =>
                      env.STORAGE.get(`cache/correlated-pool-v3/${input.key}`),
                    ),
                    (object) =>
                      Effect.gen(function* () {
                        if (object === null || object.size > 2 * 1024 * 1024) return undefined;
                        const units = Math.min(
                          MAX_OVERVIEW_BODY_UNITS,
                          Math.max(1, Math.ceil((object.size * 4) / OVERVIEW_BODY_UNIT)),
                        );
                        const acquired = yield* overviewBodyReads
                          .withPermitsIfAvailable(units)(
                            Effect.gen(function* () {
                              const encoded = yield* Effect.tryPromise(() => object.text());
                              telemetry.r2Bytes += object.size;
                              reads.correlatedBytes += object.size;
                              const decodedAt = yield* Clock.currentTimeNanos;
                              const decoded = yield* decodeCorrelatedOverview(encoded);
                              telemetry.projectMs +=
                                Number((yield* Clock.currentTimeNanos) - decodedAt) / 1e6;
                              return decoded;
                            }).pipe(Effect.uninterruptible),
                          )
                          .pipe(
                            Effect.repeat({
                              while: Option.isNone,
                              schedule: Schedule.exponential("1 millis").pipe(
                                Schedule.upTo({ duration: "2 seconds" }),
                              ),
                            }),
                          );
                        return Option.getOrUndefined(acquired);
                      }),
                    (object) => {
                      if (object === null || object.bodyUsed) return Effect.void;
                      return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
                    },
                  ).pipe(
                    Effect.ensuring(
                      Effect.gen(function* () {
                        telemetry.r2Ms += Number((yield* Clock.currentTimeNanos) - r2Started) / 1e6;
                        r2Activity.count -= 1;
                      }),
                    ),
                  );
                  if (cached === undefined) return undefined;
                  if (
                    cached.bucket !== env.STORAGE_CACHE_SCOPE ||
                    cached.source.key !== input.key ||
                    cached.source.headerBytes !== input.headerBytes
                  )
                    return undefined;
                  return cached.overview;
                }).pipe(Effect.orElseSucceed(() => undefined));
                const derived = yield* Effect.gen(function* () {
                  const bytes = prefetched;
                  if (bytes === undefined) return undefined;
                  const projectedAt = yield* Clock.currentTimeNanos;
                  const catalog = yield* Effect.try(() =>
                    segment_overview_project(bytes, terms, filters),
                  ).pipe(Effect.flatMap(decodeTermCatalog));
                  telemetry.projectMs +=
                    Number((yield* Clock.currentTimeNanos) - projectedAt) / 1e6;
                  if (catalog.partitions === null) return undefined;
                  telemetry.r2Hits += 1;
                  reads.correlatedHits += 1;
                  return { bytes, catalog };
                }).pipe(Effect.orElseSucceed(() => undefined));
                const fallbackStarted = yield* Clock.currentTimeNanos;
                const projection = yield* Effect.gen(function* () {
                  if (derived !== undefined) return derived;
                  const rootPrefix = prefixes?.[index];
                  if (allowRootFallback && rootPrefix !== undefined) {
                    usedRootFallback.value = true;
                    return {
                      bytes: undefined,
                      catalog: {
                        dictionary: Object.fromEntries(
                          requestedTerms.flatMap((term) => {
                            const summary = rootPrefix[term];
                            if (summary === undefined) return [];
                            return [[term, summary] as const];
                          }),
                        ),
                        minimum: [0, 0] as const,
                        partitions: null,
                        eligibility: null,
                      },
                    };
                  }
                  return yield* fallbackReads.withPermits(
                    Math.min(
                      fallbackCapacity,
                      Math.ceil(input.headerBytes / SMALL_CATALOG_HEADER_BYTES),
                    ),
                  )(
                    withDirectory(
                      input.key,
                      input.headerBytes,
                      (directory) =>
                        Effect.gen(function* () {
                          telemetry.fallbackDirectories += 1;
                          const bytes = yield* Effect.try(() => directory.overview()).pipe(
                            Effect.orElseSucceed(() => undefined),
                          );
                          const projected = yield* Effect.try(() =>
                            directory.catalog(terms, filters),
                          ).pipe(
                            Effect.flatMap(decodeTermCatalog),
                            Effect.orElseSucceed(() => undefined),
                          );
                          if (projected !== undefined) return { bytes, catalog: projected };
                          const dictionary = yield* Effect.try(() => directory.summary(terms)).pipe(
                            Effect.flatMap(decodeTermSummaries),
                          );
                          const minimum = yield* Effect.try(() => directory.minimum(filters)).pipe(
                            Effect.flatMap(decodeEligibleMinimum),
                          );
                          return {
                            bytes,
                            catalog: { dictionary, minimum, partitions: null, eligibility: null },
                          };
                        }),
                      undefined,
                      true,
                    ),
                  );
                });
                if (derived === undefined)
                  telemetry.fallbackMs +=
                    Number((yield* Clock.currentTimeNanos) - fallbackStarted) / 1e6;
                selected.bytes = projection.bytes;
                selected.catalog = projection.catalog;
                if (derived === undefined && projection.bytes !== undefined)
                  reads.overviewBuilds += 1;
              } else {
                reads.overviewMemoryHits += 1;
                telemetry.memoryHits += 1;
              }
              const bytes = selected.bytes;
              if (bytes === undefined) {
                admission.enabled = false;
                sources.length = 0;
                return selected.catalog;
              }
              rememberOverview(identity, bytes);
              admission.bytes += bytes.byteLength;
              if (admission.bytes > 3 * 1024 * 1024) {
                admission.enabled = false;
                sources.length = 0;
              }
              if (admission.enabled) sources[index] = bytes;
              return selected.catalog;
            }),
          { concurrency: 4 },
        );
        if ((cache !== undefined || Option.isSome(batch.key)) && admission.enabled) {
          const publishedAt = yield* Clock.currentTimeNanos;
          const encoded = yield* encodeOverviewBatch({
            bucket: env.STORAGE_CACHE_SCOPE,
            ranges,
            overviews: sources,
          });
          const bytes = new TextEncoder().encode(encoded);
          const storedKey = Option.getOrUndefined(batch.key);
          publishQueryCache(
            cacheKey.href,
            bytes.byteLength * 4 + cacheKey.href.length * 4 + 128,
            Effect.gen(function* () {
              if (cache !== undefined)
                yield* Effect.tryPromise(() =>
                  cache.put(
                    cacheKey,
                    new Response(new Uint8Array(bytes), {
                      headers: {
                        "cache-control": "public, max-age=31536000, immutable",
                        "content-type": "application/json",
                      },
                    }),
                  ),
                ).pipe(Effect.ignore);
              if (storedKey !== undefined) yield* storeOverviewBatch(storedKey, encoded);
            }),
            ctx,
          );
          telemetry.publishMs += Number((yield* Clock.currentTimeNanos) - publishedAt) / 1e6;
        }
        telemetry.totalMs = Number((yield* Clock.currentTimeNanos) - started) / 1e6;
        return { catalogs, telemetry, rootFallback: usedRootFallback.value };
      }),
  );

  function rememberTermCatalog(identity: string, value: typeof CachedTermCatalog.Type) {
    const encoded = encodeCachedTermCatalog(value);
    const bytes =
      4 *
        (new TextEncoder().encode(encoded).byteLength +
          new TextEncoder().encode(identity).byteLength) +
      256;
    if (bytes > MAX_TERM_CACHE_BYTES) return;
    const concurrent = termCatalogs.get(identity);
    if (concurrent !== undefined) {
      termBudget.bytes -= concurrent.bytes;
      termCatalogs.delete(identity);
    }
    while (termBudget.bytes + bytes > MAX_TERM_CACHE_BYTES) {
      const oldest = termCatalogs.entries().next().value;
      if (oldest === undefined) break;
      termCatalogs.delete(oldest[0]);
      termBudget.bytes -= oldest[1].bytes;
    }
    termCatalogs.set(identity, { value, bytes });
    termBudget.bytes += bytes;
  }

  const readTermCatalogs = Effect.fn("kannin.readTermCatalogs")(
    (
      ranges: ReadonlyArray<typeof TermProjectionRange.Type>,
      terms: ReadonlyArray<typeof TermProjectionProps.Type.terms>,
      filters: typeof TermFilters.Type,
      timings: Headers,
      rootPrefixes: ReadonlyArray<typeof CommonTerms.Type> | undefined,
    ) =>
      Effect.gen(function* () {
        if (
          ranges.length !== terms.length ||
          (rootPrefixes !== undefined &&
            (rootPrefixes.length !== ranges.length || filters.length !== 0))
        )
          return yield* new Rejected({
            status: 503,
            message: "Bloom projection omitted a segment",
          });
        const encodedFilters = yield* Schema.encodeEffect(TermFilters)(filters);
        const fieldSelector = encodeEligibilityFields(
          [...new Set(filters.map((filter) => filter.field))].toSorted(compareFieldNames),
        );
        const eligibilityQuery = yield* Effect.acquireRelease(
          Effect.sync(() => new EligibilityQuery(encodedFilters)),
          (query) => Effect.sync(() => query.free()),
        );
        const metrics = {
          requests: 0,
          nativeHits: 0,
          originResponses: 0,
          fetchMs: 0,
          fetchMaxMs: 0,
          bodyMs: 0,
          decodeMs: 0,
          sourceTotalMs: 0,
          sourceBatchReads: 0,
          sourceBatchHits: 0,
          sourceBatchBytes: 0,
          sourceBatchMs: 0,
          sourceBatchTimeouts: 0,
          sourceEntryMs: 0,
          sourcePublishMs: 0,
          sourceCacheMs: 0,
          sourceR2Ms: 0,
          sourceProjectMs: 0,
          sourceFallbackMs: 0,
          sourceR2Reads: 0,
          sourceR2Peak: 0,
          sourceR2Hits: 0,
          sourceR2Bytes: 0,
          sourceMemoryHits: 0,
          sourceApiHits: 0,
          sourceFallbacks: 0,
        };
        const windows = Array.from({ length: Math.ceil(ranges.length / 8) }, (_, index) =>
          EffectArray.zip(
            ranges.slice(index * 8, index * 8 + 8),
            terms.slice(index * 8, index * 8 + 8),
          ).map(([input, requested], offset) => [input, requested, index * 8 + offset] as const),
        );
        const batches = yield* Effect.forEach(
          windows,
          (window) =>
            Effect.gen(function* () {
              const selected = yield* Effect.forEach(
                window,
                ([input, requested, rangeIndex]) =>
                  Effect.gen(function* () {
                    const selector = encodeProjectionTerms(requested.toSorted());
                    const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`;
                    const projectionIdentity = `${identity}/projection:${selector}`;
                    const minimumIdentity = `${identity}/minimum:${encodedFilters}`;
                    const eligibilityIdentity = `${identity}/eligibility:${fieldSelector}`;
                    const projection = termCatalogs.get(projectionIdentity);
                    const minimum = termCatalogs.get(minimumIdentity);
                    if (projection !== undefined) {
                      termCatalogs.delete(projectionIdentity);
                      termCatalogs.set(projectionIdentity, projection);
                    }
                    if (minimum !== undefined) {
                      termCatalogs.delete(minimumIdentity);
                      termCatalogs.set(minimumIdentity, minimum);
                    }
                    const minimumValue = {
                      value: Match.value(minimum?.value).pipe(
                        Match.when({ kind: "minimum" }, (cached) => cached.minimum),
                        Match.orElse(() => undefined),
                      ),
                    };
                    if (minimumValue.value === undefined) {
                      const cached = termCatalogs.get(eligibilityIdentity);
                      if (cached?.value.kind === "eligibility") {
                        const eligibility = cached.value.eligibility;
                        const projected = yield* Effect.try(() =>
                          decodeEligibilityMinimum(eligibilityQuery.minimum(eligibility)),
                        ).pipe(Effect.option);
                        if (Option.isSome(projected)) minimumValue.value = projected.value;
                        if (termCatalogs.get(eligibilityIdentity) === cached) {
                          termCatalogs.delete(eligibilityIdentity);
                          if (Option.isSome(projected))
                            termCatalogs.set(eligibilityIdentity, cached);
                          else termBudget.bytes -= cached.bytes;
                        }
                      }
                    }
                    return {
                      input,
                      terms: requested,
                      prefix: rootPrefixes?.[rangeIndex],
                      projectionIdentity,
                      minimumIdentity,
                      eligibilityIdentity,
                      projection: Match.value(projection?.value).pipe(
                        Match.when({ kind: "projection" }, (cached) => cached.projection),
                        Match.orElse(() => undefined),
                      ),
                      minimum: minimumValue.value,
                    };
                  }),
                { concurrency: 1 },
              );
              reads.termMemoryHits += selected.filter(
                (entry) => entry.projection !== undefined && entry.minimum !== undefined,
              ).length;
              const groups = [
                {
                  filters: encodedFilters,
                  entries: selected.filter(
                    (entry) => entry.projection === undefined && entry.minimum === undefined,
                  ),
                },
                {
                  filters: "[]",
                  entries: selected.filter(
                    (entry) => entry.projection === undefined && entry.minimum !== undefined,
                  ),
                },
                {
                  filters: encodedFilters,
                  entries: selected.filter(
                    (entry) => entry.projection !== undefined && entry.minimum === undefined,
                  ),
                },
              ];
              for (const group of groups) {
                if (group.entries.length === 0) continue;
                const requested = new Set(
                  group.entries
                    .filter((entry) => entry.projection === undefined)
                    .flatMap((entry) => entry.terms),
                );
                const requestedTerms = [...requested].toSorted();
                const prefixes = Match.value(rootPrefixes).pipe(
                  Match.when(undefined, () => undefined),
                  Match.orElse(() => {
                    if (group.entries.some((entry) => entry.projection !== undefined))
                      return undefined;
                    const coveredPrefixes = group.entries.flatMap((entry) => {
                      const dictionary = entry.prefix;
                      if (dictionary === undefined) return [];
                      if (!requestedTerms.every((term) => Object.hasOwn(dictionary, term)))
                        return [];
                      return [dictionary];
                    });
                    if (coveredPrefixes.length !== group.entries.length) return undefined;
                    return coveredPrefixes;
                  }),
                );
                const props = {
                  bucket: env.STORAGE_CACHE_SCOPE,
                  terms: encodeProjectionTerms(requestedTerms),
                  prefixes,
                  selection: { kind: "filters" as const, filters: group.filters },
                  ranges: group.entries.map(({ input }) => ({
                    key: input.key,
                    headerBytes: input.headerBytes,
                  })),
                };
                const filterHeader = yield* Schema.encodeEffect(Schema.StringFromBase64)(
                  group.filters,
                );
                const headers = new Headers();
                const selection = {
                  value: yield* Schema.decodeEffect(TermProjectionProps.fields.selection)(
                    props.selection,
                  ),
                };
                if (filterHeader.length <= 8192 && selection.value.kind === "filters") {
                  const actual = selection.value.filters;
                  selection.value = {
                    kind: "fields",
                    fields: [...new Set(actual.map((filter) => filter.field))].toSorted(
                      compareFieldNames,
                    ),
                  };
                  headers.set("x-kannin-filters", filterHeader);
                }
                const encodedSelection = yield* Schema.encodeEffect(
                  TermProjectionProps.fields.selection,
                )(selection.value);
                const fetchedAt = yield* Clock.currentTimeNanos;
                const response = yield* Effect.tryPromise({
                  try: () =>
                    runtime
                      .terms({ props: { ...props, selection: encodedSelection } })
                      .fetch("https://terms.internal/catalog-v12", { headers }),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
                const fetchMs = Number((yield* Clock.currentTimeNanos) - fetchedAt) / 1e6;
                metrics.requests += 1;
                metrics.fetchMs += fetchMs;
                metrics.fetchMaxMs = Math.max(metrics.fetchMaxMs, fetchMs);
                reads.termReads += group.entries.length;
                reads.termRequests += 1;
                const status = response.headers.get("cf-cache-status");
                if (status === "HIT") {
                  reads.termWorkerCacheHits += group.entries.length;
                  metrics.nativeHits += 1;
                }
                const bodyAt = yield* Clock.currentTimeNanos;
                const text = yield* Effect.tryPromise(() => response.text());
                metrics.bodyMs += Number((yield* Clock.currentTimeNanos) - bodyAt) / 1e6;
                if (!response.ok)
                  return yield* new Rejected({
                    status: 503,
                    message: "Immutable term catalog unavailable",
                  });
                const decodedAt = yield* Clock.currentTimeNanos;
                const batch = yield* decodeTermCatalogBatch(text);
                const catalogs = batch.catalogs;
                if (catalogs.some((catalog) => catalog.selection.kind === "minimum")) {
                  const expectedFilterDigest = yield* Effect.tryPromise(() =>
                    sha256(group.filters),
                  );
                  if (batch.filterDigest !== expectedFilterDigest)
                    return yield* new Rejected({
                      status: 503,
                      message: "Term catalog filter digest mismatch",
                    });
                }
                metrics.decodeMs += Number((yield* Clock.currentTimeNanos) - decodedAt) / 1e6;
                const encodedTelemetry = response.headers.get("x-kannin-catalog-telemetry");
                if (
                  status !== "HIT" &&
                  response.headers.get("x-raio-cache") === "terms-origin" &&
                  encodedTelemetry !== null
                ) {
                  const telemetry = yield* decodeCatalogTelemetry(encodedTelemetry).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  if (telemetry !== undefined) {
                    metrics.originResponses += 1;
                    metrics.sourceTotalMs += telemetry.totalMs;
                    metrics.sourceEntryMs += telemetry.entryMs;
                    metrics.sourceBatchReads += telemetry.batchReads;
                    metrics.sourceBatchHits += telemetry.batchHits;
                    metrics.sourceBatchBytes += telemetry.batchBytes;
                    metrics.sourceBatchMs += telemetry.batchMs;
                    metrics.sourceBatchTimeouts += telemetry.batchTimeouts;
                    metrics.sourcePublishMs += telemetry.publishMs;
                    metrics.sourceCacheMs += telemetry.overviewCacheMs;
                    metrics.sourceR2Ms += telemetry.r2Ms;
                    metrics.sourceProjectMs += telemetry.projectMs;
                    metrics.sourceFallbackMs += telemetry.fallbackMs;
                    metrics.sourceR2Reads += telemetry.r2Reads;
                    metrics.sourceR2Peak = Math.max(metrics.sourceR2Peak, telemetry.r2Peak);
                    metrics.sourceR2Hits += telemetry.r2Hits;
                    metrics.sourceR2Bytes += telemetry.r2Bytes;
                    metrics.sourceMemoryHits += telemetry.memoryHits;
                    metrics.sourceApiHits += telemetry.overviewCacheHits;
                    metrics.sourceFallbacks += telemetry.fallbackDirectories;
                  }
                }
                if (catalogs.length !== group.entries.length)
                  return yield* new Rejected({
                    status: 503,
                    message: "Term projection batch omitted a segment",
                  });
                reads.termBytes += new TextEncoder().encode(text).byteLength;
                for (const [index, catalog] of catalogs.entries()) {
                  const entry = group.entries[index];
                  if (entry === undefined)
                    return yield* new Rejected({
                      status: 503,
                      message: "Term projection batch added a segment",
                    });
                  if (entry.projection === undefined) {
                    entry.projection = {
                      dictionary: catalog.dictionary,
                      partitions: catalog.partitions,
                    };
                    if (!batch.rootFallback)
                      rememberTermCatalog(entry.projectionIdentity, {
                        kind: "projection",
                        projection: entry.projection,
                      });
                  }
                  if (entry.minimum === undefined) {
                    if (catalog.selection.kind === "minimum") {
                      entry.minimum = catalog.selection.minimum;
                      if (!batch.rootFallback)
                        rememberTermCatalog(entry.minimumIdentity, {
                          kind: "minimum",
                          minimum: entry.minimum,
                        });
                    } else {
                      const model = catalog.selection.eligibility;
                      if (encodeEligibilityFields(model.fields) !== fieldSelector)
                        return yield* new Rejected({
                          status: 503,
                          message: "Term eligibility scope mismatch",
                        });
                      const encoded = encodeEligibility(model);
                      if (new TextEncoder().encode(encoded).byteLength > 4096)
                        return yield* new Rejected({
                          status: 503,
                          message: "Term eligibility exceeds four KiB",
                        });
                      entry.minimum = yield* Effect.try(() =>
                        decodeEligibilityMinimum(eligibilityQuery.minimum(encoded)),
                      );
                      if (!batch.rootFallback)
                        rememberTermCatalog(entry.eligibilityIdentity, {
                          kind: "eligibility",
                          eligibility: encoded,
                        });
                    }
                  }
                }
              }
              return yield* Effect.forEach(selected, (entry) => {
                if (entry.projection === undefined || entry.minimum === undefined)
                  return Effect.fail(
                    new Rejected({ status: 503, message: "Term projection omitted a segment" }),
                  );
                return Effect.succeed({ ...entry.projection, minimum: entry.minimum });
              });
            }),
          { concurrency: 8 },
        );
        timings.append(
          "server-timing",
          [
            `catalog_rpc_sum;dur=${metrics.fetchMs};desc="requests=${metrics.requests} native_hits=${metrics.nativeHits} origins=${metrics.originResponses}"`,
            `catalog_rpc_max;dur=${metrics.fetchMaxMs}`,
            `catalog_body_sum;dur=${metrics.bodyMs}`,
            `catalog_decode_sum;dur=${metrics.decodeMs}`,
            `catalog_origin_sum;dur=${metrics.sourceTotalMs}`,
            `catalog_entry_sum;dur=${metrics.sourceEntryMs}`,
            `catalog_batch_r2_sum;dur=${metrics.sourceBatchMs};desc="reads=${metrics.sourceBatchReads} hits=${metrics.sourceBatchHits} bytes=${metrics.sourceBatchBytes} timeouts=${metrics.sourceBatchTimeouts}"`,
            `catalog_publish_sum;dur=${metrics.sourcePublishMs}`,
            `catalog_source_cache_sum;dur=${metrics.sourceCacheMs};desc="memory=${metrics.sourceMemoryHits} api=${metrics.sourceApiHits}"`,
            `catalog_source_r2_sum;dur=${metrics.sourceR2Ms};desc="reads=${metrics.sourceR2Reads} hits=${metrics.sourceR2Hits} bytes=${metrics.sourceR2Bytes} batch_peak=${metrics.sourceR2Peak}"`,
            `catalog_source_project_sum;dur=${metrics.sourceProjectMs}`,
            `catalog_source_fallback_sum;dur=${metrics.sourceFallbackMs};desc="directories=${metrics.sourceFallbacks}"`,
          ].join(", "),
        );
        return batches.flat();
      }),
    Effect.scoped,
  );

  const storeSegmentCaches = Effect.fn("kannin.storeSegmentCaches")(
    (key: string, headerBytes: number, bytes: Uint8Array, common: boolean) =>
      Effect.gen(function* () {
        if (headerBytes <= MAX_DIRECTORY_CACHE_LENGTH) {
          yield* Effect.try(() => {
            using directory = Directory.canonical(bytes.subarray(0, headerBytes), headerBytes);
            publishDirectoryFrame(key, headerBytes, directory.compressed_frame(headerBytes));
            if (common)
              publishDirectoryFrame(
                key,
                headerBytes,
                directory.common_frame(headerBytes, bytes),
                undefined,
                true,
              );
          });
        }
        const overview = yield* Effect.try(() => segment_correlated_overview(bytes));
        if (overview === undefined) return;
        const encoded = yield* encodeCorrelatedOverview({
          bucket: env.STORAGE_CACHE_SCOPE,
          source: { key, headerBytes },
          overview,
        });
        yield* Effect.tryPromise(() =>
          env.STORAGE.put(`cache/correlated-pool-v3/${key}`, encoded, {
            httpMetadata: { contentType: "application/json" },
          }),
        );
        rememberOverview(`${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes}`, overview);
      }).pipe(Effect.orElseSucceed(() => undefined)),
  );

  const buildSegment = Effect.fn("raio.buildSegment")(
    (
      documents: ReadonlyArray<typeof StoredDocument.Type>,
      filterable: (typeof NamespaceSchema.Type)["filterable"] | undefined,
    ) =>
      Effect.acquireUseRelease(
        Effect.all([
          Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents),
          Schema.encodeEffect(
            Schema.UndefinedOr(Schema.fromJsonString(NamespaceSchema.fields.filterable)),
          )(filterable),
        ]).pipe(Effect.map(([encoded, fields]) => new Segment(encoded, fields))),
        (segment) =>
          Effect.gen(function* () {
            const header = yield* Schema.decodeEffect(Schema.fromJsonString(SegmentHeader))(
              segment.header_json(),
            );
            const commonTerms = yield* Schema.decodeEffect(Schema.fromJsonString(CommonTerms))(
              segment.common_terms(),
            );
            const commonProjection = yield* Schema.decodeEffect(
              Schema.NullOr(Schema.fromJsonString(CommonTermProjection)),
            )(segment.common_projection() ?? null);
            const commonLeaders = yield* Schema.decodeEffect(Schema.fromJsonString(CommonLeaders))(
              segment.common_leaders(),
            );
            const constantAttributes = yield* Schema.decodeEffect(
              Schema.fromJsonString(ConstantAttributes),
            )(segment.constant_attributes());
            const fields = yield* Schema.encodeEffect(
              Schema.fromJsonString(NamespaceSchema.fields.filterable),
            )(filterable ?? []);
            const eligibility = yield* Schema.decodeEffect(
              Schema.NullOr(Schema.fromJsonString(EligibilityProjection)),
            )(segment.eligibility(fields) ?? null);
            return {
              bytes: segment.bytes(),
              header,
              commonTerms,
              commonProjection,
              commonLeaders,
              constantAttributes,
              eligibility,
            };
          }),
        (segment) => Effect.sync(() => segment.free()),
      ),
  );

  const rebuildEligibility = Effect.fn("kannin.rebuildEligibility")(
    (
      segment: Pick<typeof UnpackedSegment.Type, "key" | "headerBytes" | "bytes">,
      filterable: (typeof NamespaceSchema.Type)["filterable"] | undefined,
    ) =>
      Effect.gen(function* () {
        if (filterable === undefined || filterable.length === 0) return null;
        if (
          segment.headerBytes < 16 ||
          segment.headerBytes > segment.bytes ||
          !Schema.is(SegmentRange.fields.length)(segment.headerBytes)
        )
          return yield* new Rejected({
            status: 503,
            message: "Canonical directory exceeds migration budget",
          });
        const fields = yield* Schema.encodeEffect(
          Schema.fromJsonString(NamespaceSchema.fields.filterable),
        )(filterable);
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise(() =>
            env.STORAGE.get(segment.key, {
              range: { offset: 0, length: segment.headerBytes },
            }),
          ),
          (object) =>
            Effect.gen(function* () {
              if (object === null || object.size !== segment.bytes)
                return yield* new Rejected({
                  status: 503,
                  message: "Canonical segment unavailable or size mismatch",
                });
              const bytes = new Uint8Array(yield* Effect.tryPromise(() => object.arrayBuffer()));
              if (bytes.byteLength !== segment.headerBytes)
                return yield* new Rejected({
                  status: 503,
                  message: "Canonical directory range mismatch",
                });
              return yield* Effect.acquireUseRelease(
                Effect.try(() => Directory.canonical(bytes, segment.headerBytes)),
                (directory) =>
                  Effect.gen(function* () {
                    if (directory.heap_bytes() > MAX_DECODED_BYTES)
                      return yield* new Rejected({
                        status: 503,
                        message: "Canonical directory exceeds decoded-memory budget",
                      });
                    const encoded = yield* Effect.try(() => directory.eligibility(fields));
                    return yield* Schema.decodeEffect(
                      Schema.NullOr(Schema.fromJsonString(EligibilityProjection)),
                    )(encoded ?? null);
                  }),
                (directory) => Effect.sync(() => directory.free()),
              );
            }),
          (object) => {
            if (object === null || object.bodyUsed) return Effect.void;
            return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
          },
        );
      }),
  );

  const rebuildCommonProjection = Effect.fn("kannin.rebuildCommonProjection")(
    (segment: (typeof Root.Type.segments)[number]) =>
      Effect.gen(function* () {
        const terms = Object.keys(segment.commonTerms ?? {});
        if (terms.length === 0) return null;
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise(() => env.STORAGE.get(segment.key)),
          (object) =>
            Effect.gen(function* () {
              if (object === null)
                return yield* new Rejected({
                  status: 503,
                  message: "Canonical segment unavailable",
                });
              if (object.size !== segment.bytes)
                return yield* new Rejected({
                  status: 503,
                  message: "Canonical segment size mismatch",
                });
              const bytes = new Uint8Array(yield* Effect.tryPromise(() => object.arrayBuffer()));
              if (bytes.byteLength !== segment.bytes)
                return yield* new Rejected({
                  status: 503,
                  message: "Canonical segment size mismatch",
                });
              const overview = yield* Effect.try(() => segment_correlated_overview(bytes));
              if (overview === undefined) return null;
              const catalog = yield* Effect.try(() =>
                segment_overview_project(overview, encodeProjectionTerms(terms), "[]"),
              ).pipe(Effect.flatMap(decodeTermCatalog));
              const partitions = catalog.partitions;
              if (partitions === null) return null;
              if (
                partitions.some((partition) =>
                  Object.values(partition).some((summary) => summary.bounds.length !== 1),
                )
              )
                return yield* new Rejected({
                  status: 503,
                  message: "Invalid common-term partition",
                });
              const projection = {
                terms,
                independent: terms.map((term) => catalog.dictionary[term]?.bounds ?? []),
                partitions: partitions.map((partition) =>
                  terms.map((term) => partition[term]?.bounds[0] ?? null),
                ),
              };
              if (Schema.is(CommonTermProjection)(projection)) return projection;
              return null;
            }),
          (object) => {
            if (object === null || object.bodyUsed) return Effect.void;
            return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
          },
        );
      }),
  );

  function bloom(values: ReadonlyArray<string>) {
    return segment_bloom(encodeStrings(values));
  }

  const readBloomPack = Effect.fn("kannin.readBloomPack")(function* (
    descriptor: typeof BloomPack.Type,
  ) {
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => {
          reads.bloomR2Reads += 1;
          return env.STORAGE.get(descriptor.key);
        },
        catch: (cause) => new Cause.UnknownError(cause),
      }),
      (object) =>
        Effect.gen(function* () {
          if (object === null || object.size !== descriptor.bytes)
            return yield* new Rejected({
              status: 503,
              message: "Bloom pack unavailable or size mismatch",
            });
          const bytes = new Uint8Array(
            yield* Effect.tryPromise({
              try: () => object.arrayBuffer(),
              catch: (cause) => new Cause.UnknownError(cause),
            }),
          );
          reads.bloomR2Bytes += bytes.byteLength;
          if (bytes.byteLength !== descriptor.bytes)
            return yield* new Rejected({ status: 503, message: "Truncated Bloom pack" });
          const digest = new Uint8Array(
            yield* Effect.tryPromise({
              try: () => crypto.subtle.digest("SHA-256", bytes),
              catch: (cause) => new Cause.UnknownError(cause),
            }),
          );
          if (descriptor.key.split("/").at(-1)?.slice(0, 64) !== digest.toHex())
            return yield* new Rejected({ status: 503, message: "Bloom pack digest mismatch" });
          const document = bytes.subarray(
            descriptor.document.offset,
            descriptor.document.offset + descriptor.document.length,
          );
          const term = bytes.subarray(
            descriptor.term.offset,
            descriptor.term.offset + descriptor.term.length,
          );
          const documentDigest = new Uint8Array(
            yield* Effect.tryPromise({
              try: () => crypto.subtle.digest("SHA-256", document),
              catch: (cause) => new Cause.UnknownError(cause),
            }),
          );
          const termDigest = new Uint8Array(
            yield* Effect.tryPromise({
              try: () => crypto.subtle.digest("SHA-256", term),
              catch: (cause) => new Cause.UnknownError(cause),
            }),
          );
          if (
            documentDigest.toHex() !== descriptor.document.sha256 ||
            termDigest.toHex() !== descriptor.term.sha256
          )
            return yield* new Rejected({ status: 503, message: "Bloom column digest mismatch" });
          return { document, term };
        }),
      (object) => {
        if (object === null || object.bodyUsed) return Effect.void;
        return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
      },
    );
  });

  const writeBloomPack = Effect.fn("kannin.writeBloomPack")(function* (
    prefix: string,
    segmentKeys: ReadonlyArray<string>,
    documentRows: ReadonlyArray<Uint8Array>,
    termRows: ReadonlyArray<Uint8Array>,
  ) {
    if (
      segmentKeys.length !== documentRows.length ||
      segmentKeys.length !== termRows.length ||
      !validBloomRows(documentRows) ||
      !validBloomRows(termRows)
    )
      return yield* new Rejected({ status: 503, message: "Invalid Bloom pack rows" });
    const document = bloomOffsets(documentRows);
    const term = bloomOffsets(termRows);
    const bytes = new Uint8Array(document.length + term.length);
    writeBloomRows(bytes, 0, documentRows);
    writeBloomRows(bytes, document.length, termRows);
    const documentBytes = bytes.subarray(0, document.length);
    const termBytes = bytes.subarray(document.length);
    const valid = yield* Effect.try({
      try: () =>
        validateBloomBatch(documentBytes, document.offsets) &&
        validateBloomBatch(termBytes, term.offsets),
      catch: () => new Rejected({ status: 503, message: "Invalid Bloom pack framing" }),
    });
    if (!valid) return yield* new Rejected({ status: 503, message: "Invalid Bloom pack framing" });
    const checksum = new Uint8Array(
      yield* Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", bytes),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    );
    const key = `${prefix}/bloom-packs/${runtime.immutableIdentity(checksum.toHex())}.bin`;
    const descriptor = yield* Schema.decodeEffect(BloomPack)({
      key,
      bytes: bytes.byteLength,
      segmentKeys: [...segmentKeys],
      document: {
        offset: 0,
        length: document.length,
        sha256: new Uint8Array(
          yield* Effect.tryPromise({
            try: () => crypto.subtle.digest("SHA-256", documentBytes),
            catch: (cause) => new Cause.UnknownError(cause),
          }),
        ).toHex(),
        offsets: Array.from(document.offsets),
      },
      term: {
        offset: document.length,
        length: term.length,
        sha256: new Uint8Array(
          yield* Effect.tryPromise({
            try: () => crypto.subtle.digest("SHA-256", termBytes),
            catch: (cause) => new Cause.UnknownError(cause),
          }),
        ).toHex(),
        offsets: Array.from(term.offsets),
      },
    }).pipe(
      Effect.mapError(
        () => new Rejected({ status: 503, message: "Invalid Bloom pack descriptor" }),
      ),
    );
    const stored = yield* Effect.tryPromise({
      try: () =>
        env.STORAGE.put(key, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: checksum,
        }),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    if (stored !== null) return descriptor;
    const existing = yield* Effect.tryPromise({
      try: () => env.STORAGE.head(key),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    if (
      existing === null ||
      existing.size !== bytes.byteLength ||
      existing.checksums.sha256 === undefined ||
      new Uint8Array(existing.checksums.sha256).toHex() !== checksum.toHex()
    )
      return yield* new Rejected({ status: 503, message: "Conflicting Bloom pack object" });
    yield* Effect.tryPromise({
      try: async () => env.STORAGE.delete(`${prefix}/retired/${await sha256(key)}.json`),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    return descriptor;
  });

  const pruneBloomPacks = Effect.fn("kannin.pruneBloomPacks")(function* (root: typeof Root.Type) {
    const referenced = new Set(root.segments.map((segment) => segment.bloom.packIndex));
    const indexes: Array<number | undefined> = Array.from(
      { length: root.bloomPacks.length },
      () => undefined,
    );
    const bloomPacks: Array<typeof BloomPack.Type> = [];
    for (const [index, descriptor] of root.bloomPacks.entries())
      if (referenced.has(index)) {
        indexes[index] = bloomPacks.length;
        bloomPacks.push(descriptor);
      }
    const segments: Array<(typeof Root.Type.segments)[number]> = [];
    for (const segment of root.segments) {
      const packIndex = indexes[segment.bloom.packIndex];
      if (packIndex === undefined)
        return yield* new Rejected({ status: 503, message: "Invalid segment Bloom reference" });
      segments.push({ ...segment, bloom: { ...segment.bloom, packIndex } });
    }
    return {
      ...root,
      bloomPacks,
      segments,
    };
  });

  const packBloomRoot = Effect.fn("kannin.packBloomRoot")(function* (
    prefix: string,
    legacy: typeof ConvertedInlineRoot.Type,
  ) {
    const bloomPacks: Array<typeof BloomPack.Type> = [];
    const segments: Array<(typeof Root.Type.segments)[number]> = [];
    const cursor = { start: 0 };
    while (cursor.start < legacy.segments.length) {
      const rows: Array<(typeof legacy.segments)[number]> = [];
      const documentRows: Array<Uint8Array> = [];
      const termRows: Array<Uint8Array> = [];
      while (cursor.start < legacy.segments.length && rows.length < 64) {
        const segment = legacy.segments[cursor.start];
        if (segment === undefined)
          return yield* new Rejected({ status: 503, message: "Legacy Bloom row missing" });
        if (
          segment.documentBloom.length > MAX_BLOOM_BASE64_LENGTH ||
          segment.termBloom.length > MAX_BLOOM_BASE64_LENGTH
        )
          return yield* new Rejected({
            status: 503,
            message: "Legacy Bloom encoding exceeds budget",
          });
        const decoded = yield* Effect.try({
          try: () => ({
            document: Uint8Array.fromBase64(segment.documentBloom),
            term: Uint8Array.fromBase64(segment.termBloom),
          }),
          catch: () => new Rejected({ status: 503, message: "Invalid legacy Bloom encoding" }),
        });
        if (
          decoded.document.byteLength < 8 ||
          decoded.document.byteLength > 16 * 1024 * 1024 ||
          decoded.term.byteLength < 8 ||
          decoded.term.byteLength > 16 * 1024 * 1024
        )
          return yield* new Rejected({
            status: 503,
            message: "Invalid legacy Bloom column length",
          });
        const documentTotal = documentRows.reduce((total, row) => total + row.byteLength, 0);
        const termTotal = termRows.reduce((total, row) => total + row.byteLength, 0);
        if (
          documentTotal + decoded.document.byteLength > 16 * 1024 * 1024 ||
          termTotal + decoded.term.byteLength > 16 * 1024 * 1024
        ) {
          if (rows.length === 0)
            return yield* new Rejected({
              status: 503,
              message: "Legacy Bloom row exceeds pack budget",
            });
          break;
        }
        rows.push(segment);
        documentRows.push(decoded.document);
        termRows.push(decoded.term);
        cursor.start += 1;
      }
      const descriptor = yield* writeBloomPack(
        prefix,
        rows.map((segment) => segment.key),
        documentRows,
        termRows,
      );
      const packIndex = bloomPacks.length;
      bloomPacks.push(descriptor);
      for (const [row, segment] of rows.entries()) {
        const { documentBloom: _documentBloom, termBloom: _termBloom, ...metadata } = segment;
        segments.push({ ...metadata, bloom: { packIndex, row } });
      }
    }
    const { segments: _segments, schema, ...fields } = legacy;
    const schemaFields = Option.match(Option.fromUndefinedOr(schema), {
      onNone: () => ({}),
      onSome: (native) => ({ schema: namespaceColumnsFromNative(native) }),
    });
    return {
      ...fields,
      ...schemaFields,
      bloomPacks,
      segments,
    };
  });

  const appendBloomSegment = Effect.fn("kannin.appendBloomSegment")(function* (
    prefix: string,
    root: typeof Root.Type,
    segment: typeof UnpackedSegment.Type,
    document: Uint8Array,
    term: Uint8Array,
  ) {
    if (!validBloomRows([document]) || !validBloomRows([term]))
      return yield* new Rejected({ status: 503, message: "Invalid Bloom segment framing" });
    const base = yield* pruneBloomPacks(root);
    if (
      base.bloomPacks.some((descriptor) => !descriptor.key.startsWith(`${prefix}/bloom-packs/`)) ||
      base.segments.some((item) => item.key === segment.key)
    )
      return yield* new Rejected({ status: 503, message: "Invalid Bloom append identity" });
    const tailIndex = base.bloomPacks.length - 1;
    const tail = base.bloomPacks[tailIndex];
    const canRewrite =
      tail !== undefined &&
      tail.segmentKeys.length < 64 &&
      tail.document.length + document.byteLength <= 16 * 1024 * 1024 &&
      tail.term.length + term.byteLength <= 16 * 1024 * 1024;
    if (tail !== undefined && canRewrite) {
      return yield* withBloomAdmission(
        bloomColumnBytes,
        16,
        Effect.gen(function* () {
          const existing = yield* withBloomAdmission(bloomColumnReads, 1, readBloomPack(tail));
          const documentRows = Array.from({ length: tail.segmentKeys.length }, (_, row) =>
            existing.document.subarray(
              tail.document.offsets[row] ?? 0,
              tail.document.offsets[row + 1] ?? 0,
            ),
          );
          const termRows = Array.from({ length: tail.segmentKeys.length }, (_, row) =>
            existing.term.subarray(tail.term.offsets[row] ?? 0, tail.term.offsets[row + 1] ?? 0),
          );
          const row = tail.segmentKeys.length;
          const descriptor = yield* writeBloomPack(
            prefix,
            [...tail.segmentKeys, segment.key],
            [...documentRows, document],
            [...termRows, term],
          );
          const bloomPacks = base.bloomPacks.map((item, index) => {
            if (index === tailIndex) return descriptor;
            return item;
          });
          return {
            ...base,
            bloomPacks,
            segments: [...base.segments, { ...segment, bloom: { packIndex: tailIndex, row } }],
          };
        }),
      );
    }
    const descriptor = yield* writeBloomPack(prefix, [segment.key], [document], [term]);
    const bloomPacks = [...base.bloomPacks, descriptor];
    return {
      ...base,
      bloomPacks,
      segments: [
        ...base.segments,
        { ...segment, bloom: { packIndex: bloomPacks.length - 1, row: 0 } },
      ],
    };
  });

  const bloomFilterResult = Schema.decodeSync(
    Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
  );

  const bloomColumnCacheKey = (descriptor: typeof BloomPack.Type, field: "document" | "term") => {
    const column = descriptor[field];
    return `${env.STORAGE_CACHE_SCOPE}:${descriptor.key}:${field}:${column.sha256}:${column.offsets.join(",")}`;
  };

  const readBloomColumn = Effect.fn("kannin.readBloomColumn")(function* (
    descriptor: typeof BloomPack.Type,
    field: "document" | "term",
  ) {
    const column = descriptor[field];
    return yield* withBloomAdmission(
      bloomColumnReads,
      1,
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => {
            reads.bloomR2Reads += 1;
            return env.STORAGE.get(descriptor.key, {
              range: { offset: column.offset, length: column.length },
            });
          },
          catch: (cause) => new Cause.UnknownError(cause),
        }),
        (object) =>
          Effect.gen(function* () {
            if (object === null || object.size !== descriptor.bytes)
              return yield* new Rejected({
                status: 503,
                message: "Bloom pack unavailable or size mismatch",
              });
            const bytes = new Uint8Array(
              yield* Effect.tryPromise({
                try: () => object.arrayBuffer(),
                catch: (cause) => new Cause.UnknownError(cause),
              }),
            );
            reads.bloomR2Bytes += bytes.byteLength;
            if (bytes.byteLength !== column.length)
              return yield* new Rejected({ status: 503, message: "Truncated Bloom column" });
            const digest = new Uint8Array(
              yield* Effect.tryPromise({
                try: () => crypto.subtle.digest("SHA-256", bytes),
                catch: (cause) => new Cause.UnknownError(cause),
              }),
            );
            if (digest.toHex() !== column.sha256)
              return yield* new Rejected({ status: 503, message: "Bloom column digest mismatch" });
            return bytes;
          }),
        (object) => {
          if (object === null || object.bodyUsed) return Effect.void;
          return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
        },
      ),
    );
  });

  const bloomColumnMatches = Effect.fn("kannin.bloomColumnMatches")(function* (
    identity: string,
    descriptor: typeof BloomPack.Type,
    field: "document" | "term",
    input: string,
  ) {
    const cached = yield* Effect.try({
      try: () => {
        const entry = bloomBatches.get(identity);
        if (entry === undefined) return undefined;
        bloomBatches.delete(identity);
        bloomBatches.set(identity, entry);
        return bloomFilterResult(entry.batch.filter(input));
      },
      catch: () => new Rejected({ status: 503, message: "Invalid cached Bloom batch" }),
    });
    if (cached !== undefined) return cached;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const prior = pendingBloomColumns.get(identity);
        if (prior !== undefined) {
          prior.users += 1;
          return { pending: prior, leader: false };
        }
        const completion = Promise.withResolvers<Exit.Exit<Uint8Array, BloomReadFailure>>();
        const pending = {
          completion: completion.promise,
          resolve: completion.resolve,
          cacheable: true,
          users: 1,
        };
        pendingBloomColumns.set(identity, pending);
        return { pending, leader: true };
      }),
      (slot) =>
        Effect.gen(function* () {
          const bytes = yield* Match.value(slot.leader).pipe(
            Match.when(true, () =>
              readBloomColumn(descriptor, field).pipe(
                Effect.onExit((exit) => Effect.sync(() => slot.pending.resolve(exit))),
              ),
            ),
            Match.orElse(() => Effect.promise(() => slot.pending.completion).pipe(Effect.flatten)),
          );
          return yield* rememberBloomBatch(
            identity,
            descriptor.key,
            bytes,
            Uint32Array.from(descriptor[field].offsets),
            input,
            slot.pending,
          );
        }),
      (slot, exit) =>
        Effect.sync(() => {
          if (slot.leader && Exit.isFailure(exit)) slot.pending.resolve(Exit.failCause(exit.cause));
          slot.pending.users -= 1;
          if (slot.pending.users === 0 && pendingBloomColumns.get(identity) === slot.pending)
            pendingBloomColumns.delete(identity);
        }),
    );
  });

  const rememberBloomBatch = Effect.fn("kannin.rememberBloomBatch")(function* (
    key: string,
    packKey: string,
    bytes: Uint8Array,
    offsets: Uint32Array,
    input: string,
    pending: PendingBloomColumn,
  ) {
    const cached = yield* Effect.try({
      try: () => {
        const entry = bloomBatches.get(key);
        if (entry === undefined) return undefined;
        bloomBatches.delete(key);
        bloomBatches.set(key, entry);
        return bloomFilterResult(entry.batch.filter(input));
      },
      catch: () => new Rejected({ status: 503, message: "Invalid cached Bloom batch" }),
    });
    if (cached !== undefined) return cached;
    const retained = { value: false };
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => new BloomBatch(bytes, offsets),
        catch: () => new Rejected({ status: 503, message: "Invalid Bloom column framing" }),
      }),
      (batch) =>
        Effect.try({
          try: () => {
            const current = bloomBatches.get(key);
            if (current !== undefined) {
              bloomBatches.delete(key);
              bloomBatches.set(key, current);
              return bloomFilterResult(current.batch.filter(input));
            }
            const result = bloomFilterResult(batch.filter(input));
            const charge = batch.heap_bytes() + new TextEncoder().encode(key).byteLength * 4 + 128;
            if (pending.cacheable && charge <= 4 * 1024 * 1024) {
              while (bloomBudget.bytes + charge > 4 * 1024 * 1024) {
                const oldest = bloomBatches.entries().next().value;
                if (oldest === undefined) break;
                bloomBatches.delete(oldest[0]);
                bloomBudget.bytes -= oldest[1].bytes;
                oldest[1].batch.free();
              }
              bloomBatches.set(key, { batch, bytes: charge, prefix: packKey });
              bloomBudget.bytes += charge;
              retained.value = true;
            }
            return result;
          },
          catch: () => new Rejected({ status: 503, message: "Invalid Bloom column framing" }),
        }),
      (batch) =>
        Effect.sync(() => {
          if (!retained.value) batch.free();
        }),
    );
  });

  const bloomCandidates = Effect.fn("kannin.bloomCandidates")(function* (
    root: typeof Root.Type,
    values: ReadonlyArray<string>,
    field: "document" | "term",
    start: number = 0,
    count: number = root.segments.length,
  ) {
    const input = encodeStrings(values);
    const selectedSegments = root.segments.slice(start, start + count);
    const selected: Array<ReadonlyArray<string> | undefined> = Array.from(
      { length: selectedSegments.length },
      () => undefined,
    );
    const groups = new Map<number, Array<{ index: number; row: number }>>();
    for (const [index, segment] of selectedSegments.entries()) {
      const descriptor = root.bloomPacks[segment.bloom.packIndex];
      if (
        descriptor === undefined ||
        segment.bloom.row >= descriptor.segmentKeys.length ||
        descriptor.segmentKeys[segment.bloom.row] !== segment.key
      )
        return yield* new Rejected({ status: 503, message: "Invalid segment Bloom reference" });
      const rows = groups.get(segment.bloom.packIndex) ?? [];
      rows.push({ index, row: segment.bloom.row });
      groups.set(segment.bloom.packIndex, rows);
    }
    yield* Effect.forEach(
      [...groups.entries()],
      ([packIndex, rows]) =>
        Effect.gen(function* () {
          const descriptor = root.bloomPacks[packIndex];
          if (descriptor === undefined)
            return yield* new Rejected({ status: 503, message: "Bloom pack descriptor missing" });
          const column = descriptor[field];
          const key = bloomColumnCacheKey(descriptor, field);
          const cached = yield* Effect.sync(() => {
            const entry = bloomBatches.get(key);
            if (entry === undefined) return undefined;
            bloomBatches.delete(key);
            bloomBatches.set(key, entry);
            return bloomFilterResult(entry.batch.filter(input));
          });
          const results =
            cached ??
            (yield* withBloomAdmission(
              bloomColumnBytes,
              Math.max(1, Math.ceil(column.length / (1024 * 1024))),
              bloomColumnMatches(key, descriptor, field, input),
            ));
          for (const { index, row } of rows) {
            const result = results[row];
            if (result === undefined)
              return yield* new Rejected({
                status: 503,
                message: "Bloom batch omitted a segment row",
              });
            selected[index] = result;
          }
          return undefined;
        }),
      { concurrency: 4 },
    );
    return yield* Effect.forEach(selected, (rows) => {
      if (rows === undefined)
        return Effect.fail(new Rejected({ status: 503, message: "Bloom batch omitted a segment" }));
      return Effect.succeed(rows);
    });
  });

  async function readDocumentBytes(
    key: string,
    headerBytes: number,
    offset: number,
    length: number,
    readAheadEnd: number,
  ) {
    const identity = `${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${length}`;
    const windowBytes = SMALL_RANGE_LIMIT / 16;
    if (length > windowBytes || buffers.has(identity)) return range(key, offset, length);
    const start = headerBytes + Math.floor((offset - headerBytes) / windowBytes) * windowBytes;
    const end = Math.min(
      readAheadEnd,
      headerBytes + Math.ceil((offset - headerBytes + length) / windowBytes) * windowBytes,
    );
    const bytes = await range(key, start, end - start);
    const frame = bytes.slice(offset - start, offset - start + length);
    remember(identity, frame);
    return frame;
  }

  async function readDocumentFrame(
    key: string,
    headerBytes: number,
    data: typeof DataRange.Type,
    objectBytes: number,
    readAheadEnd: number,
    payload?: Uint8Array,
  ) {
    const offset = headerBytes + data.offset;
    if (
      readAheadEnd < headerBytes ||
      readAheadEnd > objectBytes ||
      offset < headerBytes ||
      offset + data.length > readAheadEnd ||
      data.length < 8
    )
      throw new Rejected({ status: 503, message: "Invalid segment document range" });
    if (payload !== undefined) {
      if (data.offset + data.length > payload.byteLength)
        throw new Rejected({ status: 503, message: "Truncated segment document payload" });
      return payload.subarray(data.offset, data.offset + data.length);
    }
    return readDocumentBytes(key, headerBytes, offset, data.length, readAheadEnd);
  }

  async function readDocument(
    key: string,
    headerBytes: number,
    data: typeof DataRange.Type,
    objectBytes: number,
    vectorData: typeof LocatedDocument.Type.vectorData,
    payload?: Uint8Array,
  ) {
    if (vectorData !== null) {
      if (
        vectorData.offset < data.offset + data.length ||
        vectorData.length < 8 ||
        headerBytes + vectorData.offset + vectorData.length > objectBytes
      )
        throw new Rejected({ status: 503, message: "Invalid segment vector range" });
      if (payload !== undefined && vectorData.offset + vectorData.length > payload.byteLength)
        throw new Rejected({ status: 503, message: "Truncated segment vector payload" });
    }
    const metadata = readDocumentFrame(
      key,
      headerBytes,
      data,
      objectBytes,
      headerBytes + data.offset + data.length,
      payload,
    );
    if (vectorData === null)
      return decodeStoredDocument(segment_document(await metadata, new Uint8Array()));
    if (payload !== undefined) {
      return decodeStoredDocument(
        segment_document(
          await metadata,
          payload.subarray(vectorData.offset, vectorData.offset + vectorData.length),
        ),
      );
    }
    const [frame, vector] = await Promise.all([
      metadata,
      range(key, headerBytes + vectorData.offset, vectorData.length),
    ]);
    return decodeStoredDocument(segment_document(frame, vector));
  }

  const MAX_DOCUMENT_BATCH_PAGES = 16;
  const MAX_DOCUMENT_ACQUISITION_BYTES = 128 * 1024;

  const readDocumentHits = Effect.fn("raio.readDocumentHits")(function* (
    locations: ReadonlyArray<
      readonly [
        Pick<(typeof Root.Type.segments)[number], "key" | "headerBytes" | "bytes" | "metadataEnd">,
        typeof DataRange.Type,
        typeof Row.Type.score,
      ]
    >,
  ) {
    const indexed = locations.map((location, index) => [index, location] as const);
    const grouped = new Map<string, (typeof indexed)[number][]>();
    for (const entry of indexed) {
      const segment = entry[1][0];
      const identity = `${segment.key}/${segment.headerBytes}/${segment.bytes}/${segment.metadataEnd}`;
      const entries = grouped.get(identity) ?? [];
      entries.push(entry);
      grouped.set(identity, entries);
    }
    const windows: (typeof indexed)[] = [];
    for (const entries of grouped.values()) {
      if (entries.length === 1) {
        windows.push(entries);
        continue;
      }
      const groupStart = windows.length;
      const span = { start: 0, end: 0, requested: 0 };
      const sorted = entries.toSorted((left, right) => left[1][1].offset - right[1][1].offset);
      for (const entry of sorted) {
        const page = entry[1][1];
        const window = windows.at(-1);
        const end = Math.max(span.end, page.offset + page.length);
        const requested = span.requested + page.length;
        if (
          windows.length > groupStart &&
          window !== undefined &&
          window.length < MAX_DOCUMENT_BATCH_PAGES &&
          end - span.start <= 1024 * 1024 &&
          end - span.start - requested <= 64 * 1024
        ) {
          window.push(entry);
          span.end = end;
          span.requested = requested;
          continue;
        }
        windows.push([entry]);
        span.start = page.offset;
        span.end = page.offset + page.length;
        span.requested = page.length;
      }
    }

    const acquisitions = windows.map((window) => {
      const first = window[0];
      const segment = first?.[1][0];
      const start = first?.[1][1].offset ?? 0;
      const span = { end: start, requested: 0, fresh: segment !== undefined };
      if (
        segment !== undefined &&
        (segment.metadataEnd < segment.headerBytes || segment.metadataEnd > segment.bytes)
      )
        span.fresh = false;
      for (const entry of window) {
        if (!span.fresh) break;
        const page = entry[1][1];
        const source = entry[1][0];
        const offset = source.headerBytes + page.offset;
        if (
          page.offset < span.end ||
          page.length < 8 ||
          offset < source.headerBytes ||
          offset + page.length > source.metadataEnd ||
          buffers.has(`${env.STORAGE_CACHE_SCOPE}:${source.key}/${offset}/${page.length}`)
        )
          span.fresh = false;
        span.end = Math.max(span.end, page.offset + page.length);
        span.requested += page.length;
      }
      if (span.end - start - span.requested > 64 * 1024) span.fresh = false;
      if (segment !== undefined && span.fresh) {
        const length = span.end - start;
        const offset = segment.headerBytes + start;
        if (buffers.has(`${env.STORAGE_CACHE_SCOPE}:${segment.key}/${offset}/${length}`))
          span.fresh = false;
        if (length <= SMALL_RANGE_LIMIT / 16) {
          const windowBytes = SMALL_RANGE_LIMIT / 16;
          const alignedStart = segment.headerBytes + Math.floor(start / windowBytes) * windowBytes;
          const alignedEnd = Math.min(
            segment.metadataEnd,
            segment.headerBytes + Math.ceil(span.end / windowBytes) * windowBytes,
          );
          if (
            buffers.has(
              `${env.STORAGE_CACHE_SCOPE}:${segment.key}/${alignedStart}/${alignedEnd - alignedStart}`,
            )
          )
            span.fresh = false;
        }
      }
      return {
        windows: [window],
        segment,
        start,
        end: span.end,
        requested: span.requested,
        fresh: span.fresh,
      };
    });
    const groupedAcquisitions: typeof acquisitions = [];
    for (const acquisition of acquisitions) {
      const previous = groupedAcquisitions.at(-1);
      const segment = acquisition.segment;
      const previousSegment = previous?.segment;
      if (
        previous !== undefined &&
        segment !== undefined &&
        previousSegment !== undefined &&
        previous.fresh &&
        acquisition.fresh &&
        segment.key === previousSegment.key &&
        segment.headerBytes === previousSegment.headerBytes &&
        segment.bytes === previousSegment.bytes &&
        segment.metadataEnd === previousSegment.metadataEnd &&
        acquisition.start >= previous.end &&
        acquisition.end - previous.start <= MAX_DOCUMENT_ACQUISITION_BYTES &&
        acquisition.end - previous.start - previous.requested - acquisition.requested <= 64 * 1024
      ) {
        previous.windows.push(...acquisition.windows);
        previous.end = acquisition.end;
        previous.requested += acquisition.requested;
      } else groupedAcquisitions.push(acquisition);
    }
    const concurrency = documentReadConcurrency(locations.map((location) => location[1]));
    const permits = yield* Semaphore.make(concurrency);
    const batches = yield* Effect.forEach(
      groupedAcquisitions,
      (acquisition) =>
        Effect.gen(function* () {
          const segment = acquisition.segment;
          if (segment === undefined) return [];
          const physical = { start: acquisition.start, end: acquisition.end };
          const payload = yield* Effect.gen(function* () {
            const blockBytes = 131072;
            const start = Math.floor(acquisition.start / blockBytes) * blockBytes;
            const end = Math.min(
              segment.metadataEnd - segment.headerBytes,
              Math.ceil(acquisition.end / blockBytes) * blockBytes,
            );
            if (
              acquisition.fresh &&
              acquisition.windows.reduce((total, window) => total + window.length, 0) >= 2 &&
              end - start <= MAX_DOCUMENT_ACQUISITION_BYTES &&
              end - start <= 4 * (acquisition.end - acquisition.start) &&
              end - start - (acquisition.end - acquisition.start) <= 16 * 1024 &&
              end - start - acquisition.requested <= 64 * 1024
            ) {
              physical.start = start;
              physical.end = end;
            }
            if (
              acquisition.windows.length < 2 &&
              physical.start === acquisition.start &&
              physical.end === acquisition.end
            )
              return undefined;
            return yield* permits.withPermit(
              Effect.tryPromise({
                try: () =>
                  range(
                    segment.key,
                    segment.headerBytes + physical.start,
                    physical.end - physical.start,
                    false,
                    false,
                  ),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              }),
            );
          });
          const result: Array<readonly [number, typeof Row.Type]> = [];
          for (const window of acquisition.windows) {
            const documents = yield* readDocuments(
              segment.key,
              segment.headerBytes,
              window.map((location) => location[1][1]),
              segment.bytes,
              segment.metadataEnd,
              permits,
              payload,
              physical.start,
            );
            for (const [index, document] of documents.entries()) {
              const hit = window[index];
              if (hit === undefined)
                return yield* new Rejected({
                  status: 503,
                  message: "Document batch omitted its hit",
                });
              result.push([
                hit[0],
                {
                  id: document.id,
                  title: document.title ?? "",
                  text: document.text,
                  attributes: document.attributes,
                  revision: document.revision,
                  score: hit[1][2],
                },
              ] as const);
            }
          }
          return result;
        }),
      { concurrency },
    );
    return batches
      .flat()
      .toSorted((left, right) => left[0] - right[0])
      .map(([, hit]) => hit);
  });

  const readDocuments = Effect.fn("raio.readDocuments")(function* (
    key: string,
    headerBytes: number,
    pages: ReadonlyArray<typeof DataRange.Type>,
    objectBytes: number,
    metadataEnd: number,
    permits: Semaphore.Semaphore,
    payload?: Uint8Array,
    payloadOffset: number = 0,
  ) {
    const identity = `${env.STORAGE_CACHE_SCOPE}:${key}`;
    const cached = directories.get(identity);
    if (cached !== undefined) {
      directories.delete(identity);
      directories.set(identity, cached);
    }
    if (metadataEnd < headerBytes || metadataEnd > objectBytes)
      return yield* new Rejected({ status: 503, message: "Invalid segment metadata boundary" });
    if (pages.length > MAX_DOCUMENT_BATCH_PAGES)
      return yield* new Rejected({
        status: 503,
        message: `Document batch exceeds ${MAX_DOCUMENT_BATCH_PAGES} pages`,
      });
    const ordered = pages.toSorted((left, right) => left.offset - right.offset);
    const first = ordered[0];
    if (first === undefined) return [];
    const span = {
      end: first.offset,
      contiguous: true,
      cached: false,
      requested: 0,
      overlap: false,
    };
    for (const page of ordered) {
      const offset = headerBytes + page.offset;
      if (offset < headerBytes || offset + page.length > metadataEnd || page.length < 8)
        return yield* new Rejected({ status: 503, message: "Invalid segment document range" });
      if (page.offset !== span.end) span.contiguous = false;
      if (page.offset < span.end) span.overlap = true;
      span.end = Math.max(span.end, page.offset + page.length);
      span.requested += page.length;
      if (buffers.has(`${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${page.length}`))
        span.cached = true;
    }
    if (
      payload !== undefined &&
      (!Number.isSafeInteger(payloadOffset) ||
        payloadOffset < 0 ||
        payload.byteLength > MAX_DOCUMENT_ACQUISITION_BYTES ||
        headerBytes + payloadOffset + payload.byteLength > metadataEnd ||
        first.offset < payloadOffset ||
        span.end - payloadOffset > payload.byteLength ||
        span.end - first.offset - span.requested > 64 * 1024 ||
        span.overlap)
    )
      return yield* new Rejected({ status: 503, message: "Invalid acquired document payload" });
    if (
      pages.every((page) =>
        buffers.has(
          `${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes + page.offset}/${page.length}`,
        ),
      )
    ) {
      const frames = [];
      for (const page of pages) {
        const frame = cachedRange(
          `${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes + page.offset}/${page.length}`,
        );
        if (frame === undefined)
          return yield* new Cause.UnknownError("Cached document range disappeared");
        frames.push(frame);
      }
      if (pages.length >= 2 && !span.overlap && span.requested <= 64 * 1024) {
        const packed = new Uint8Array(span.requested);
        const ranges = new Uint32Array(pages.length * 2);
        const cursor = { offset: 0 };
        for (const [index, frame] of frames.entries()) {
          packed.set(frame, cursor.offset);
          ranges[index * 2] = cursor.offset;
          ranges[index * 2 + 1] = frame.byteLength;
          cursor.offset += frame.byteLength;
        }
        const encoded = yield* Effect.try({
          try: () => segment_query_documents(packed, ranges),
          catch: (cause) => new Cause.UnknownError(cause),
        });
        if (encoded !== undefined)
          return yield* decodeQueryDocumentsEffect(encoded).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause)),
          );
      }
      return yield* Effect.forEach(frames, (frame) =>
        Effect.gen(function* () {
          const encoded = yield* Effect.try({
            try: () => segment_query_document(frame),
            catch: (cause) => new Cause.UnknownError(cause),
          });
          return yield* decodeQueryDocumentEffect(encoded).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause)),
          );
        }),
      );
    }
    if (
      (pages.length < 2 && payload === undefined) ||
      span.overlap ||
      span.cached ||
      span.end - first.offset > 1024 * 1024 ||
      span.end - first.offset - span.requested > 64 * 1024
    )
      return yield* Effect.forEach(
        pages,
        (page) =>
          Effect.gen(function* () {
            if (payload !== undefined) {
              const cacheKey = `${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes + page.offset}/${page.length}`;
              const cachedFrame = cachedRange(cacheKey);
              const start = page.offset - payloadOffset;
              const frame = cachedFrame ?? payload.subarray(start, start + page.length);
              const document = yield* Effect.try({
                try: () => decodeQueryDocument(segment_query_document(frame)),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
              if (cachedFrame === undefined) remember(cacheKey, frame.slice());
              return document;
            }
            return yield* permits.withPermit(
              Effect.tryPromise({
                try: async () =>
                  decodeQueryDocument(
                    segment_query_document(
                      await readDocumentFrame(key, headerBytes, page, objectBytes, metadataEnd),
                    ),
                  ),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              }),
            );
          }),
        { concurrency: 4 },
      );
    const bytes = yield* Effect.gen(function* () {
      if (payload !== undefined)
        return payload.subarray(first.offset - payloadOffset, span.end - payloadOffset);
      return yield* permits.withPermit(
        Effect.tryPromise({
          try: () => {
            if (span.contiguous)
              return readDocumentBytes(
                key,
                headerBytes,
                headerBytes + first.offset,
                span.end - first.offset,
                metadataEnd,
              );
            return range(key, headerBytes + first.offset, span.end - first.offset, false, false);
          },
          catch: (cause) => {
            if (Schema.is(Rejected)(cause)) return cause;
            return new Cause.UnknownError(cause);
          },
        }),
      );
    });
    const batchEncoded = yield* Effect.try({
      try: () =>
        segment_query_documents(
          bytes,
          new Uint32Array(pages.flatMap((page) => [page.offset - first.offset, page.length])),
        ),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    if (batchEncoded !== undefined) {
      const documents = yield* decodeQueryDocumentsEffect(batchEncoded);
      for (const page of pages) {
        const start = page.offset - first.offset;
        remember(
          `${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes + page.offset}/${page.length}`,
          bytes.slice(start, start + page.length),
        );
      }
      return documents;
    }
    const documents = yield* Effect.forEach(pages, (page) =>
      Effect.gen(function* () {
        const start = page.offset - first.offset;
        const frame = bytes.slice(start, start + page.length);
        const encoded = yield* Effect.try({
          try: () => segment_query_document(frame),
          catch: (cause) => new Cause.UnknownError(cause),
        });
        const document = yield* decodeQueryDocumentEffect(encoded);
        remember(
          `${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes + page.offset}/${page.length}`,
          frame,
        );
        return document;
      }),
    );

    return documents;
  });

  function textPlan(key: string) {
    const entry = textPlans.get(key);
    if (entry !== undefined) {
      textPlans.delete(key);
      textPlans.set(key, entry);
      reads.textPlanCacheHits += 1;
      return entry.plan;
    }
    return undefined;
  }

  function rememberTextPlan(key: string, plan: typeof TextPlan.Type) {
    const encoded = encodeTextPlan(plan);
    const bytes = encoded.length * 4 + key.length * 4 + 128;
    const previous = textPlans.get(key);
    if (previous !== undefined) {
      textPlans.delete(key);
      textPlanBudget.bytes -= previous.bytes;
    }
    if (bytes > MAX_TEXT_PLAN_BYTES) return;
    while (textPlanBudget.bytes + bytes > MAX_TEXT_PLAN_BYTES) {
      const oldest = textPlans.entries().next().value;
      if (oldest === undefined) break;
      textPlans.delete(oldest[0]);
      textPlanBudget.bytes -= oldest[1].bytes;
    }
    textPlans.set(key, { plan, bytes });
    textPlanBudget.bytes += bytes;
  }

  function segmentScoreBound(key: string) {
    const bound = scoreBounds.get(key);
    if (bound !== undefined) {
      scoreBounds.delete(key);
      scoreBounds.set(key, bound);
    }
    return bound;
  }

  function rememberSegmentScoreBound(key: string, bound: typeof SegmentScoreBound.Type) {
    const prior = scoreBounds.get(key);
    const retained = { value: bound };
    if (
      prior !== undefined &&
      (prior.bound < bound.bound ||
        (prior.bound === bound.bound && prior.minimumId >= bound.minimumId))
    )
      retained.value = prior;
    const charge = (key.length + retained.value.minimumId.length) * 4 + 128;
    if (charge > MAX_SCORE_BOUND_BYTES) return;
    if (prior !== undefined) {
      scoreBounds.delete(key);
      scoreBoundBudget.bytes -= (key.length + prior.minimumId.length) * 4 + 128;
    }
    while (scoreBoundBudget.bytes + charge > MAX_SCORE_BOUND_BYTES) {
      const oldest = scoreBounds.entries().next().value;
      if (oldest === undefined) break;
      scoreBounds.delete(oldest[0]);
      scoreBoundBudget.bytes -= (oldest[0].length + oldest[1].minimumId.length) * 4 + 128;
    }
    scoreBounds.set(key, retained.value);
    scoreBoundBudget.bytes += charge;
  }

  function clearImmutableCache(prefix: string) {
    const identity = `${env.STORAGE_CACHE_SCOPE}:${prefix}`;
    for (const [key, entry] of textPlans)
      if (key.startsWith(`${identity}/`)) {
        textPlans.delete(key);
        textPlanBudget.bytes -= entry.bytes;
      }
    for (const [key, bound] of scoreBounds)
      if (key.startsWith(`${identity}/`)) {
        scoreBounds.delete(key);
        scoreBoundBudget.bytes -= (key.length + bound.minimumId.length) * 4 + 128;
      }
    for (const [key, bytes] of overviewBuffers)
      if (key.startsWith(`${identity}/`)) {
        overviewBuffers.delete(key);
        overviewBudget.bytes -=
          bytes.byteLength + new TextEncoder().encode(key).byteLength * 4 + 128;
      }
    for (const [key, entry] of termCatalogs)
      if (key.startsWith(`${identity}/`)) {
        termCatalogs.delete(key);
        termBudget.bytes -= entry.bytes;
      }
    for (const key of admissionCounts.keys())
      if (key.startsWith(`${identity}/`)) {
        admissionCounts.delete(key);
        admissionBudget.bytes -= key.length * 4 + 128;
      }
    for (const [key, frame] of encodedDirectories)
      if (key.startsWith(`${identity}/`)) {
        encodedDirectories.delete(key);
        encodedBudget.bytes -= frame.heap_bytes() + key.length * 4 + 128;
        frame.free();
      }
    for (const [key, bytes] of buffers)
      if (key.startsWith(`${identity}/`)) {
        buffers.delete(key);
        cacheOrder.delete(`r:${key}`);
        budget.bytes -= bytes.byteLength + key.length * 4 + 128;
        budget.payloadBytes -= bytes.byteLength;
      }
    for (const [key, entry] of frequencyPages)
      if (key.startsWith(`${identity}/`)) {
        frequencyPages.delete(key);
        cacheOrder.delete(`p:${key}`);
        frequencyBudget.bytes -= entry.bytes;
        entry.page.free();
      }
    for (const [key, entry] of bloomBatches)
      if (key.startsWith(`${env.STORAGE_CACHE_SCOPE}:`) && entry.prefix.startsWith(`${prefix}/`)) {
        bloomBatches.delete(key);
        bloomBudget.bytes -= entry.bytes;
        entry.batch.free();
      }
    for (const [key, pending] of pendingBloomColumns)
      if (key.startsWith(`${env.STORAGE_CACHE_SCOPE}:${prefix}/bloom-packs/`)) {
        pending.cacheable = false;
        pendingBloomColumns.delete(key);
      }
    for (const [key, entry] of directories)
      if (key.startsWith(`${identity}/`)) {
        directories.delete(key);
        decodedBudget.bytes -= entry.bytes;
        entry.directory.free();
      }
  }

  function cacheUsage() {
    return {
      rangeCacheBytes: budget.payloadBytes,
      rangeCacheChargedBytes: budget.bytes,
      postingCacheBytes: frequencyBudget.bytes,
      directoryCacheChargedBytes: decodedBudget.bytes,
      scoreBoundCacheChargedBytes: scoreBoundBudget.bytes,
      scoreBoundCacheEntries: scoreBounds.size,
      textPlanCacheChargedBytes: textPlanBudget.bytes,
      textPlanCacheEntries: textPlans.size,
      encodedDirectoryCacheChargedBytes: encodedBudget.bytes + admissionBudget.bytes,
      encodedDirectoryAdmissionChargedBytes: admissionBudget.bytes,
      encodedDirectoryCacheEntries: encodedDirectories.size,
      bloomCacheBytes: bloomBudget.bytes,
      termCacheBytes: termBudget.bytes,
      overviewCacheBytes: overviewBudget.bytes,
      ...reads,
    };
  }

  return {
    publishQueryCache,
    addFrequencyPosting,
    readSegmentCache,
    acquireDirectoryFrame,
    waitDirectoryFrame,
    publishDirectoryFrame,
    range,
    withDirectory,
    warmTermBatch,
    readTermProjections,
    readTermCatalogs,
    storeSegmentCaches,
    buildSegment,
    rebuildEligibility,
    rebuildCommonProjection,
    bloom,
    pruneBloomPacks,
    packBloomRoot,
    appendBloomSegment,
    bloomCandidates,
    readDocument,
    documentReadConcurrency,
    readDocumentHits,
    readDocuments,
    textPlan,
    rememberTextPlan,
    segmentScoreBound,
    rememberSegmentScoreBound,
    clearImmutableCache,
    cacheUsage,
    sha256,
  };
}

export type Storage = ReturnType<typeof createStorage>;
