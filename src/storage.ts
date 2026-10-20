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
import { env, exports, waitUntil } from "cloudflare:workers";
import {
  Segment,
  Directory,
  CompressedDirectory,
  pack,
  unpack,
  directory_compress,
  segment_document,
  segment_bloom,
  BloomBatch,
  FrequencyPage,
  EligibilityQuery,
  segment_overview_project,
  segment_correlated_overview,
} from "../dist/wasm/raio_engine";
import type { Ranker } from "../dist/wasm/raio_engine";
import type { DataRange, Root } from "./protocol";
import {
  StoredDocument,
  SegmentHeader,
  CommonTerms,
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
  Rejected,
  NamespaceSchema,
  TextPlan,
  type SegmentScoreBound,
} from "./protocol";

const pendingQueryPublications = new Map<string, number>();
const queryPublicationBudget = { bytes: 0 };
const MAX_QUERY_PUBLICATION_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_PUBLICATIONS = 16;

export function publishQueryCache(
  identity: string,
  charge: number,
  publication: Effect.Effect<void, Cause.UnknownError>,
  ctx?: ExecutionContext | DurableObjectState,
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
const directoryFrameFailures = { epoch: 0n };
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
const directories = new Map<string, { directory: Directory; bytes: number; headerBytes: number }>();
const activeDirectories = new Map<
  string,
  {
    readers: number;
    directory: Directory | undefined;
    fingerprint: ArrayBuffer | undefined;
    canonical: Option.Option<Promise<Exit.Exit<void, Cause.UnknownError | Rejected>>>;
  }
>();
const decodedBudget = { bytes: 0 };
const MAX_DECODED_BYTES = 40 * 1024 * 1024;
const MAX_DECODED_CACHE_BYTES = 29 * 1024 * 1024;
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
  encodedDirectoryCacheHits: 0,
  textPlanCacheHits: 0,
  workerCacheHits: 0,
  workerCacheMisses: 0,
  cacheApiHits: 0,
};
const bloomBatches = new Map<string, { batch: BloomBatch; bytes: number; prefix: string }>();
const bloomBudget = { bytes: 0 };
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
const encodeEligibilityFields = Schema.encodeSync(
  Schema.fromJsonString(EligibilityProjection.fields.fields),
);
const decodeEligibilityMinimum = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum));
const storedDocumentJson = Schema.fromJsonString(StoredDocument);
const decodeStoredDocument = Schema.decodeSync(storedDocumentJson);
const decodeStoredDocumentEffect = Schema.decodeEffect(storedDocumentJson);

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

function rememberEncodedDirectory(key: string, bytes: Uint8Array, expected: number) {
  if (encodedDirectories.has(key)) return;
  const maximum = MAX_ENCODED_DIRECTORY_BYTES - MAX_ADMISSION_BYTES;
  if (bytes.byteLength + key.length * 4 + 128 > maximum) return;
  using frame = new CompressedDirectory(bytes, expected);
  const charge = frame.heap_bytes() + key.length * 4 + 128;
  if (charge > maximum) return;
  const victims = [];
  const remaining = { bytes: encodedBudget.bytes };
  const frequency = admissionCounts.get(key) ?? 0;
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

export function addFrequencyPosting(
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
) {
  const bytes = directory.heap_bytes();
  const active = activeDirectories.get(`${identity}/0/${headerBytes}/directory-v3`);
  if (active !== undefined && active.directory === undefined && bytes <= MAX_DECODED_BYTES) {
    active.directory = directory.retain();
    active.fingerprint = fingerprint;
  }
  if (directories.has(identity)) return;
  if (bytes > MAX_DECODED_CACHE_BYTES) return;
  const frequency = admissionCounts.get(`${identity}/0/${headerBytes}/directory-v3`) ?? 1;
  const victims = [];
  const remaining = { bytes: decodedBudget.bytes };
  for (const [key, entry] of directories) {
    if (remaining.bytes + bytes <= MAX_DECODED_CACHE_BYTES) break;
    if (frequency <= (admissionCounts.get(`${key}/0/${entry.headerBytes}/directory-v3`) ?? 0))
      return;
    victims.push(key);
    remaining.bytes -= entry.bytes;
  }
  for (const key of victims) {
    const entry = directories.get(key);
    directories.delete(key);
    entry?.directory.free();
  }
  directories.set(identity, { directory: directory.retain(), bytes, headerBytes });
  decodedBudget.bytes = remaining.bytes + bytes;
}

export const acquireDirectoryFrame = Effect.fn("kannin.acquireDirectoryFrame")(
  (key: string, length: number) =>
    Effect.gen(function* () {
      if (length > MAX_DIRECTORY_CACHE_LENGTH)
        return yield* Effect.forkDetach(Effect.succeed(Option.none<Uint8Array>()));
      const units = Math.min(DIRECTORY_CACHE_UNITS, Math.ceil(length / DIRECTORY_CACHE_UNIT));
      const acquisition = directoryFrameAttempts.withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeNanos;
          const observedFailure = directoryFrameFailures.epoch;
          const acquired = yield* Effect.gen(function* () {
            if (
              (yield* Clock.currentTimeNanos) - started >= DIRECTORY_FRAME_BUDGET ||
              directoryFrameFailures.epoch !== observedFailure
            )
              return Option.some(Option.none<Uint8Array>());
            return yield* directoryCacheReads.withPermitsIfAvailable(units)(
              Effect.gen(function* () {
                reads.directoryR2CacheReads += 1;
                const object = yield* Effect.tryPromise(() =>
                  env.STORAGE.get(`cache/directory-v3/${key}/${length}`),
                );
                if (object === null) return Option.none<Uint8Array>();
                const source = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(TermProjectionRange),
                )(object.customMetadata?.source).pipe(Effect.option);
                if (
                  object.size > Math.min(length + 8192, MAX_DIRECTORY_CACHE_BYTES) ||
                  Option.isNone(source) ||
                  source.value.key !== key ||
                  source.value.headerBytes !== length
                ) {
                  yield* Effect.tryPromise(() => object.body.cancel());
                  reads.directoryR2CacheRejected += 1;
                  return Option.none<Uint8Array>();
                }
                const bytes = new Uint8Array(yield* Effect.tryPromise(() => object.arrayBuffer()));
                reads.directoryR2CacheBytes += bytes.byteLength;
                const fingerprint = yield* Effect.tryPromise(() =>
                  crypto.subtle.digest("SHA-256", bytes),
                );
                const checked = yield* Effect.try(() => {
                  using directory = Directory.compressed(bytes, length, MAX_DECODED_BYTES);
                  rememberDirectory(
                    `${env.STORAGE_CACHE_SCOPE}:${key}`,
                    length,
                    directory,
                    fingerprint,
                  );
                  return bytes;
                }).pipe(Effect.option);
                if (Option.isSome(checked)) reads.directoryR2CacheHits += 1;
                else reads.directoryR2CacheRejected += 1;
                return checked;
              }).pipe(
                Effect.orElseSucceed(() => Option.none<Uint8Array>()),
                Effect.tap((frame) =>
                  Effect.sync(() => {
                    if (Option.isNone(frame)) directoryFrameFailures.epoch += 1n;
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

export const waitDirectoryFrame = Effect.fn("kannin.waitDirectoryFrame")(
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

export function publishDirectoryFrame(
  key: string,
  length: number,
  bytes: Uint8Array,
  ctx?: ExecutionContext | DurableObjectState,
) {
  if (
    length > MAX_DIRECTORY_CACHE_LENGTH ||
    bytes.byteLength > Math.min(length + 8192, MAX_DIRECTORY_CACHE_BYTES)
  )
    return false;
  const identity = `cache/directory-v3/${key}/${length}`;
  const published = publishQueryCache(
    `${env.STORAGE_CACHE_SCOPE}:${identity}`,
    bytes.byteLength * 4 + identity.length * 4 + 128,
    Schema.encodeEffect(Schema.fromJsonString(TermProjectionRange))({
      key,
      headerBytes: length,
    }).pipe(
      Effect.orDie,
      Effect.flatMap((source) =>
        Effect.tryPromise(() =>
          env.STORAGE.put(identity, new Uint8Array(bytes), {
            customMetadata: { source },
          }),
        ),
      ),
      Effect.asVoid,
    ),
    ctx,
  );
  if (published) reads.directoryR2CachePublications += 1;
  return published;
}

export async function range(
  key: string,
  offset: number,
  length: number,
  compressedDirectory = false,
) {
  const resource = Match.value(compressedDirectory).pipe(
    Match.when(true, () => "directory-v3"),
    Match.orElse(() => "range"),
  );
  const rawIdentity = `${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${length}`;
  const cacheKey = Match.value(compressedDirectory).pipe(
    Match.when(true, () => `${rawIdentity}/directory-v3`),
    Match.orElse(() => rawIdentity),
  );
  const cached = Match.value(compressedDirectory).pipe(
    Match.when(true, () => {
      const frame = cachedEncodedDirectory(cacheKey);
      if (frame === undefined) return undefined;
      return frame.bytes();
    }),
    Match.orElse(() => {
      const bytes = buffers.get(cacheKey);
      if (bytes === undefined) return undefined;
      buffers.delete(cacheKey);
      buffers.set(cacheKey, bytes);
      return bytes;
    }),
  );
  if (cached !== undefined) {
    if (!compressedDirectory) {
      reads.rangeCacheHits += 1;
      cacheOrder.delete(`r:${cacheKey}`);
      cacheOrder.set(`r:${cacheKey}`, "range");
    }
    return cached;
  }
  if (compressedDirectory) noteDirectoryRequest(cacheKey);
  const pending = pendingRanges.get(cacheKey);
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
    reads.rangeReads += 1;
    const cachedRead = Effect.tryPromise({
      try: async (signal) => {
        const response = await exports.Segments({ props }).fetch(url, { signal });
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
        return yield* Effect.tryPromise(() => env.STORAGE.get(key, { range: { offset, length } }));
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
            const frame = yield* Effect.try(() => directory_compress(new Uint8Array(body)).slice());
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
          if (length > SMALL_RANGE_LIMIT) return cachedRead;
          return smallRangeReads
            .withPermitsIfAvailable(Math.max(1, Math.ceil((length * 4) / SMALL_RANGE_BODY_UNIT)))(
              boundedRead,
            )
            .pipe(
              Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("1 millis") }),
              Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
            );
        }),
      ),
    );
    reads.rangeBytes += bytes.byteLength;
    if (!compressedDirectory && bytes.byteLength !== length)
      throw new Rejected({ status: 503, message: "R2 range returned a truncated segment" });
    if (compressedDirectory) rememberEncodedDirectory(cacheKey, bytes, length);
    else remember(cacheKey, bytes);
    return bytes;
  })();
  if (pendingRanges.size >= MAX_PENDING_RANGES) return acquisition;
  const shared = acquisition.then(
    (bytes) => {
      pendingRanges.delete(cacheKey);
      return bytes;
    },
    (cause: unknown) => {
      pendingRanges.delete(cacheKey);
      return Promise.reject(cause);
    },
  );
  pendingRanges.set(cacheKey, shared);
  return shared;
}

const acquireDirectory = Effect.fn("kannin.acquireDirectory")(
  (key: string, headerBytes: number, canonical: boolean) =>
    Effect.gen(function* () {
      const identity = `${env.STORAGE_CACHE_SCOPE}:${key}`;
      const admissionIdentity = `${identity}/0/${headerBytes}/directory-v3`;
      const cached = directories.get(identity);
      if (cached !== undefined) {
        noteDirectoryRequest(admissionIdentity);
        reads.directoryCacheHits += 1;
        directories.delete(identity);
        directories.set(identity, cached);
        return cached.directory.retain();
      }
      const retained = activeDirectories.get(admissionIdentity);
      if (retained?.directory !== undefined) {
        noteDirectoryRequest(admissionIdentity);
        return retained.directory.retain();
      }
      if (canonical && retained !== undefined && Option.isSome(retained.canonical)) {
        const completion = retained.canonical.value;
        const exit = yield* Effect.promise(() => completion);
        yield* exit;
        const shared = activeDirectories.get(admissionIdentity)?.directory;
        if (shared === undefined)
          return yield* new Rejected({
            status: 503,
            message: "Canonical directory acquisition did not retain metadata",
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
        const frame = yield* Effect.gen(function* () {
          if (!canonical) return Option.none<Uint8Array>();
          return yield* acquireDirectoryFrame(key, headerBytes).pipe(
            Effect.flatMap(waitDirectoryFrame),
            Effect.map(Option.flatten),
          );
        });
        if (Option.isSome(frame)) {
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
                try: () => range(key, 0, headerBytes, true),
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
            if (canonical && Option.isNone(frame)) return Directory.canonical(bytes, headerBytes);
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
      if (canonical) {
        if (retained === undefined) return yield* acquire;
        const completion = Promise.withResolvers<Exit.Exit<void, Cause.UnknownError | Rejected>>();
        retained.canonical = Option.some(completion.promise);
        return yield* acquire.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => completion.resolve(Exit.map(exit, () => undefined))),
          ),
        );
      }
      return yield* acquire;
    }),
);

export const withDirectory = Effect.fn("raio.withDirectory")(
  <A, E, R>(
    key: string,
    headerBytes: number,
    use: (directory: Directory) => Effect.Effect<A, E, R>,
    permits?: Semaphore.Semaphore,
    canonical = false,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const identity = `${env.STORAGE_CACHE_SCOPE}:${key}/0/${headerBytes}/directory-v3`;
        const existing = activeDirectories.get(identity);
        if (existing !== undefined) {
          existing.readers += 1;
          return { identity, active: existing };
        }
        const active = {
          readers: 1,
          directory: undefined,
          fingerprint: undefined,
          canonical: Option.none<Promise<Exit.Exit<void, Cause.UnknownError | Rejected>>>(),
        };
        if (activeDirectories.size < MAX_PENDING_RANGES) activeDirectories.set(identity, active);
        return { identity, active };
      }),
      () =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const acquire = acquireDirectory(
              key,
              headerBytes,
              canonical && headerBytes <= MAX_DIRECTORY_CACHE_LENGTH,
            );
            if (permits === undefined) return yield* acquire;
            return yield* permits.withPermit(acquire);
          }),
          use,
          (directory) => Effect.sync(() => directory.free()),
        ),
      ({ identity, active }) =>
        Effect.sync(() => {
          active.readers -= 1;
          if (active.readers === 0) {
            if (activeDirectories.get(identity) === active) activeDirectories.delete(identity);
            active.directory?.free();
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

export const warmTermBatch = Effect.fn("kannin.warmTermBatch")(
  (segments: Readonly<typeof Root.Type.segments>, ctx: DurableObjectState) =>
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
      const identity = new URL("https://overviews.internal/batch-v6");
      identity.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
      identity.searchParams.set("ranges", digest);
      publishQueryCache(
        identity.href,
        bytes.byteLength * 4 + identity.href.length * 4 + 128,
        storeOverviewBatch(`cache/correlated-pool-batches-v1/${first.key}/${digest}`, encoded),
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
  ctx: ExecutionContext,
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

export const readTermProjections = Effect.fn("kannin.readTermProjections")(
  (
    ranges: ReadonlyArray<typeof TermProjectionRange.Type>,
    terms: string,
    filters: string,
    ctx: ExecutionContext,
  ) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeNanos;
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
            if (catalog === undefined) {
              overviewBuffers.delete(identity);
              overviewBudget.bytes -=
                bytes.byteLength + new TextEncoder().encode(identity).byteLength * 4 + 128;
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
        return { catalogs: hits.map((hit) => hit.catalog), telemetry };
      }
      const cacheKey = new URL("https://overviews.internal/batch-v6");
      cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
      const encodedRanges = yield* Schema.encodeEffect(
        Schema.fromJsonString(TermProjectionProps.fields.ranges),
      )(ranges);
      const rangesDigest = yield* Effect.tryPromise(() => sha256(encodedRanges));
      cacheKey.searchParams.set("ranges", rangesDigest);
      const cacheStarted = yield* Clock.currentTimeNanos;
      const cache = yield* Effect.tryPromise(() => caches.open("raio-overview-batches-v6")).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (cache !== undefined) {
        reads.overviewCacheApiLookups += 1;
        telemetry.overviewCacheLookups += 1;
        const cached = yield* Effect.tryPromise(() => cache.match(cacheKey)).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (cached !== undefined) {
          const candidate = yield* Effect.tryPromise(() => cached.text()).pipe(
            Effect.flatMap(decodeOverviewBatch),
            Effect.orElseSucceed(() => undefined),
          );
          if (
            candidate !== undefined &&
            candidate.overviews.length === ranges.length &&
            candidate.bucket === env.STORAGE_CACHE_SCOPE &&
            (yield* Schema.encodeEffect(Schema.fromJsonString(TermProjectionProps.fields.ranges))(
              candidate.ranges,
            )) === encodedRanges
          ) {
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
            if (projected !== undefined) {
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
              return { catalogs: projected, telemetry };
            }
          }
          yield* Effect.tryPromise(() => cache.delete(cacheKey)).pipe(
            Effect.orElseSucceed(() => false),
          );
        }
      }
      if (telemetry.overviewCacheMs === 0)
        telemetry.overviewCacheMs = Number((yield* Clock.currentTimeNanos) - cacheStarted) / 1e6;
      const first = ranges[0];
      const batch = { key: Option.none<string>() };
      if (first !== undefined && ranges.length >= 8) {
        const identity = `cache/correlated-pool-batches-v1/${first.key}/${rangesDigest}`;
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
          if (projected !== undefined) {
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
            return { catalogs: projected, telemetry };
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
                  Effect.tryPromise(() => env.STORAGE.get(`cache/correlated-pool-v1/${input.key}`)),
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
                telemetry.projectMs += Number((yield* Clock.currentTimeNanos) - projectedAt) / 1e6;
                if (catalog.partitions === null) return undefined;
                telemetry.r2Hits += 1;
                reads.correlatedHits += 1;
                return { bytes, catalog };
              }).pipe(Effect.orElseSucceed(() => undefined));
              const fallbackStarted = yield* Clock.currentTimeNanos;
              const projection =
                derived ??
                (yield* fallbackReads.withPermits(
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
                ));
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
      return { catalogs, telemetry };
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

export const readTermCatalogs = Effect.fn("kannin.readTermCatalogs")(
  (
    ranges: ReadonlyArray<typeof TermProjectionRange.Type>,
    terms: ReadonlyArray<typeof TermProjectionProps.Type.terms>,
    filters: typeof TermFilters.Type,
    timings: Headers,
  ) =>
    Effect.gen(function* () {
      if (ranges.length !== terms.length)
        return yield* new Rejected({ status: 503, message: "Bloom projection omitted a segment" });
      const encodedFilters = yield* Schema.encodeEffect(TermFilters)(filters);
      const fieldSelector = encodeEligibilityFields(
        [...new Set(filters.map((filter) => filter.field))].toSorted(),
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
        ),
      );
      const batches = yield* Effect.forEach(
        windows,
        (window) =>
          Effect.gen(function* () {
            const selected = yield* Effect.forEach(
              window,
              ([input, requested]) =>
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
                        if (Option.isSome(projected)) termCatalogs.set(eligibilityIdentity, cached);
                        else termBudget.bytes -= cached.bytes;
                      }
                    }
                  }
                  return {
                    input,
                    terms: requested,
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
              const props = {
                bucket: env.STORAGE_CACHE_SCOPE,
                terms: encodeProjectionTerms([...requested].toSorted()),
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
                  fields: [...new Set(actual.map((filter) => filter.field))].toSorted(),
                };
                headers.set("x-kannin-filters", filterHeader);
              }
              const encodedSelection = yield* Schema.encodeEffect(
                TermProjectionProps.fields.selection,
              )(selection.value);
              const fetchedAt = yield* Clock.currentTimeNanos;
              const response = yield* Effect.tryPromise({
                try: () =>
                  exports
                    .Terms({ props: { ...props, selection: encodedSelection } })
                    .fetch("https://terms.internal/catalog-v9", { headers }),
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
                const expectedFilterDigest = yield* Effect.tryPromise(() => sha256(group.filters));
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
                  rememberTermCatalog(entry.projectionIdentity, {
                    kind: "projection",
                    projection: entry.projection,
                  });
                }
                if (entry.minimum === undefined) {
                  if (catalog.selection.kind === "minimum") {
                    entry.minimum = catalog.selection.minimum;
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

export const storeSegmentCaches = Effect.fn("kannin.storeSegmentCaches")(
  (key: string, headerBytes: number, bytes: Uint8Array) =>
    Effect.gen(function* () {
      if (headerBytes <= MAX_DIRECTORY_CACHE_LENGTH) {
        const frame = yield* Effect.try(() =>
          directory_compress(bytes.subarray(0, headerBytes)).slice(),
        );
        publishDirectoryFrame(key, headerBytes, frame);
      }
      const overview = yield* Effect.try(() => segment_correlated_overview(bytes));
      if (overview === undefined) return;
      const encoded = yield* encodeCorrelatedOverview({
        bucket: env.STORAGE_CACHE_SCOPE,
        source: { key, headerBytes },
        overview,
      });
      yield* Effect.tryPromise(() =>
        env.STORAGE.put(`cache/correlated-pool-v1/${key}`, encoded, {
          httpMetadata: { contentType: "application/json" },
        }),
      );
      rememberOverview(`${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes}`, overview);
    }).pipe(Effect.orElseSucceed(() => undefined)),
);

export const buildSegment = Effect.fn("raio.buildSegment")(
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
          const commonLeaders = yield* Schema.decodeEffect(Schema.fromJsonString(CommonLeaders))(
            segment.common_leaders(),
          );
          return { bytes: segment.bytes(), header, commonTerms, commonLeaders };
        }),
      (segment) => Effect.sync(() => segment.free()),
    ),
);

export function bloom(values: ReadonlyArray<string>) {
  const bytes = segment_bloom(encodeStrings(values));
  return bytes.toBase64();
}

export function bloomCandidates(
  segments: Readonly<typeof Root.Type.segments>,
  values: ReadonlyArray<string>,
  field: "termBloom" | "documentBloom",
  start = 0,
  count = segments.length,
) {
  const input = encodeStrings(values);
  const selected = [];
  for (const offset of Array.from(
    { length: Math.ceil(Math.min(count, segments.length - start) / 64) },
    (_, index) => start + index * 64,
  )) {
    const window = segments.slice(offset, Math.min(offset + 64, start + count));
    const first = window[0];
    if (first === undefined) throw new Rejected({ status: 503, message: "Empty Bloom batch" });
    const key = `${env.STORAGE_CACHE_SCOPE}:${field}:${encodeStrings(window.map((segment) => segment.key))}`;
    const cached = bloomBatches.get(key);
    if (cached !== undefined) {
      bloomBatches.delete(key);
      bloomBatches.set(key, cached);
      selected.push(
        ...Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))))(
          cached.batch.filter(input),
        ),
      );
      continue;
    }
    const bitsets = window.map((segment) => Uint8Array.fromBase64(segment[field]));
    const packed = new Uint8Array(bitsets.reduce((total, bytes) => total + bytes.byteLength, 0));
    const offsets = new Uint32Array(bitsets.length + 1);
    const layout = { offset: 0 };
    for (const [index, bytes] of bitsets.entries()) {
      offsets[index] = layout.offset;
      packed.set(bytes, layout.offset);
      layout.offset += bytes.byteLength;
    }
    offsets[bitsets.length] = layout.offset;
    const batch = new BloomBatch(packed, offsets);
    const bytes =
      batch.heap_bytes() +
      (new TextEncoder().encode(key).byteLength + new TextEncoder().encode(first.key).byteLength) *
        4 +
      128;
    if (bytes <= 4 * 1024 * 1024) {
      while (bloomBudget.bytes + bytes > 4 * 1024 * 1024) {
        const oldest = bloomBatches.entries().next().value;
        if (oldest === undefined) break;
        bloomBatches.delete(oldest[0]);
        bloomBudget.bytes -= oldest[1].bytes;
        oldest[1].batch.free();
      }
      bloomBatches.set(key, { batch, bytes, prefix: first.key });
      bloomBudget.bytes += bytes;
    }
    if (bytes > 4 * 1024 * 1024) {
      selected.push(
        ...Effect.runSync(
          Effect.acquireUseRelease(
            Effect.succeed(batch),
            (borrowed) =>
              Effect.sync(() => borrowed.filter(input)).pipe(
                Effect.flatMap(
                  Schema.decodeEffect(
                    Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
                  ),
                ),
              ),
            (borrowed) => Effect.sync(() => borrowed.free()),
          ),
        ),
      );
    } else
      selected.push(
        ...Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))))(
          batch.filter(input),
        ),
      );
  }
  return selected;
}

async function readDocumentBytes(key: string, offset: number, length: number, totalBytes: number) {
  const identity = `${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${length}`;
  const windowBytes = SMALL_RANGE_LIMIT / 2;
  if (length > windowBytes || buffers.has(identity)) return range(key, offset, length);
  const start = Math.floor(offset / windowBytes) * windowBytes;
  const end = Math.min(totalBytes, Math.ceil((offset + length) / windowBytes) * windowBytes);
  const bytes = await range(key, start, end - start);
  const frame = bytes.slice(offset - start, offset - start + length);
  remember(identity, frame);
  return frame;
}

export async function readDocument(
  key: string,
  headerBytes: number,
  data: typeof DataRange.Type,
  totalBytes: number,
  payload?: Uint8Array,
) {
  const offset = headerBytes + data.offset;
  if (offset < headerBytes || offset + data.length > totalBytes || data.length < 8)
    throw new Rejected({ status: 503, message: "Invalid segment document range" });
  const page: { bytes: Uint8Array } = { bytes: new Uint8Array(0) };
  if (payload !== undefined) page.bytes = payload.subarray(data.offset, data.offset + data.length);
  else page.bytes = await readDocumentBytes(key, offset, data.length, totalBytes);
  const bytes = page.bytes;
  return decodeStoredDocument(segment_document(bytes));
}

export function documentReadConcurrency(pages: ReadonlyArray<typeof DataRange.Type>) {
  if (pages.reduce((total, page) => total + page.length, 0) <= 64 * 1024) return 8;
  return 4;
}

export const readDocuments = Effect.fn("raio.readDocuments")(function* (
  key: string,
  headerBytes: number,
  pages: ReadonlyArray<typeof DataRange.Type>,
  totalBytes: number,
  permits: Semaphore.Semaphore,
) {
  const identity = `${env.STORAGE_CACHE_SCOPE}:${key}`;
  const cached = directories.get(identity);
  if (cached !== undefined) {
    directories.delete(identity);
    directories.set(identity, cached);
  }
  if (pages.length > 4)
    return yield* new Rejected({ status: 503, message: "Document batch exceeds four pages" });
  const ordered = pages.toSorted((left, right) => left.offset - right.offset);
  const first = ordered[0];
  if (first === undefined) return [];
  const span = { end: first.offset, contiguous: true, cached: false };
  for (const page of ordered) {
    const offset = headerBytes + page.offset;
    if (offset < headerBytes || offset + page.length > totalBytes || page.length < 8)
      return yield* new Rejected({ status: 503, message: "Invalid segment document range" });
    if (page.offset !== span.end) span.contiguous = false;
    span.end = page.offset + page.length;
    if (buffers.has(`${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${page.length}`))
      span.cached = true;
  }
  if (pages.length < 2 || !span.contiguous || span.cached || span.end - first.offset > 1024 * 1024)
    return yield* Effect.forEach(
      pages,
      (page) =>
        permits.withPermit(
          Effect.tryPromise({
            try: () => readDocument(key, headerBytes, page, totalBytes),
            catch: (cause) => {
              if (Schema.is(Rejected)(cause)) return cause;
              return new Cause.UnknownError(cause);
            },
          }),
        ),
      { concurrency: 4 },
    );
  const bytes = yield* permits.withPermit(
    Effect.tryPromise({
      try: () =>
        readDocumentBytes(key, headerBytes + first.offset, span.end - first.offset, totalBytes),
      catch: (cause) => {
        if (Schema.is(Rejected)(cause)) return cause;
        return new Cause.UnknownError(cause);
      },
    }),
  );
  const documents = yield* Effect.forEach(pages, (page) =>
    Effect.gen(function* () {
      const start = page.offset - first.offset;
      const frame = bytes.slice(start, start + page.length);
      const encoded = yield* Effect.try({
        try: () => segment_document(frame),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const document = yield* decodeStoredDocumentEffect(encoded);
      remember(
        `${env.STORAGE_CACHE_SCOPE}:${key}/${headerBytes + page.offset}/${page.length}`,
        frame,
      );
      return document;
    }),
  );

  return documents;
});

export function textPlan(key: string) {
  const entry = textPlans.get(key);
  if (entry !== undefined) {
    textPlans.delete(key);
    textPlans.set(key, entry);
    reads.textPlanCacheHits += 1;
    return entry.plan;
  }
  return undefined;
}

export function rememberTextPlan(key: string, plan: typeof TextPlan.Type) {
  const encoded = Schema.encodeSync(Schema.fromJsonString(TextPlan))(plan);
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

export function segmentScoreBound(key: string) {
  const bound = scoreBounds.get(key);
  if (bound !== undefined) {
    scoreBounds.delete(key);
    scoreBounds.set(key, bound);
  }
  return bound;
}

export function rememberSegmentScoreBound(key: string, bound: typeof SegmentScoreBound.Type) {
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

export function clearImmutableCache(prefix: string) {
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
      overviewBudget.bytes -= bytes.byteLength + new TextEncoder().encode(key).byteLength * 4 + 128;
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
  for (const [key, entry] of directories)
    if (key.startsWith(`${identity}/`)) {
      directories.delete(key);
      decodedBudget.bytes -= entry.bytes;
      entry.directory.free();
    }
}

export function cacheUsage() {
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

export async function sha256(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
