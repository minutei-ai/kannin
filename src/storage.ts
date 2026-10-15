import { Cause, Clock, Effect, Match, Schema, Semaphore } from "effect";
import { env, exports } from "cloudflare:workers";
import {
  Segment,
  Directory,
  segment_document,
  segment_bloom,
  BloomBatch,
  FrequencyPage,
  segment_overview_project,
  segment_correlated_overview,
} from "../dist/wasm/raio_engine";
import type { Ranker } from "../dist/wasm/raio_engine";
import type { DataRange, TermProjectionRange, Root } from "./protocol";
import {
  StoredDocument,
  SegmentHeader,
  SegmentRange,
  TermCatalog,
  TermSummaries,
  TermProjection,
  CorrelatedOverview,
  CatalogTelemetry,
  EligibleMinimum,
  TermCatalogBatch,
  OverviewBatch,
  TermProjectionProps,
  SegmentCacheProps,
  Rejected,
  TextPlan,
} from "./protocol";

const buffers = new Map<string, Uint8Array>();
const frequencyPages = new Map<string, { page: FrequencyPage; bytes: number }>();
const frequencyBudget = { bytes: 0 };
const cacheOrder = new Map<string, "range" | "frequency">();
const pendingRanges = new Map<string, Promise<Uint8Array>>();
const MAX_PENDING_RANGES = 64;
const budget = { bytes: 0, payloadBytes: 0 };
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
const encodedDirectories = new Map<string, Uint8Array>();
const encodedBudget = { bytes: 0 };
const MAX_ENCODED_DIRECTORY_BYTES = 18 * 1024 * 1024;
const textPlans = new Map<string, { plan: typeof TextPlan.Type; bytes: number }>();
const textPlanBudget = { bytes: 0 };
const MAX_TEXT_PLAN_BYTES = 1024 * 1024;
const scoreBounds = new Map<string, number>();
const scoreBoundBudget = { bytes: 0 };
const MAX_SCORE_BOUND_BYTES = 1024 * 1024;
const admissionCounts = new Map<string, number>();
const admissionBudget = { bytes: 0, requests: 0 };
const MAX_ADMISSION_BYTES = 1024 * 1024;
const directories = new Map<string, { directory: Directory; bytes: number }>();
const decodedBudget = { bytes: 0 };
const MAX_DECODED_BYTES = 40 * 1024 * 1024;
const MAX_DECODED_CACHE_BYTES = 20 * 1024 * 1024;
const CachedTermCatalogs = Schema.Struct({
  projections: Schema.Record(Schema.String, TermProjection),
  minima: Schema.Record(Schema.String, EligibleMinimum),
});
const termCatalogs = new Map<string, { value: typeof CachedTermCatalogs.Type; bytes: number }>();
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
  termCacheApiHits: 0,
  rangeReads: 0,
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
const decodeTermCatalog = Schema.decodeEffect(Schema.fromJsonString(TermCatalog));
const decodeCatalogTelemetry = Schema.decodeEffect(Schema.fromJsonString(CatalogTelemetry));
const correlatedOverviewJson = Schema.fromJsonString(CorrelatedOverview);
const decodeCorrelatedOverview = Schema.decodeEffect(correlatedOverviewJson);
const encodeCorrelatedOverview = Schema.encodeEffect(correlatedOverviewJson);
const overviewBatchJson = Schema.fromJsonString(OverviewBatch);
const decodeOverviewBatch = Schema.decodeEffect(overviewBatchJson);
const encodeOverviewBatch = Schema.encodeEffect(overviewBatchJson);
const decodeTermSummaries = Schema.decodeEffect(Schema.fromJsonString(TermSummaries));
const decodeEligibleMinimum = Schema.decodeEffect(Schema.fromJsonString(EligibleMinimum));
const decodeTermCatalogBatch = Schema.decodeEffect(Schema.fromJsonString(TermCatalogBatch));
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

function rememberEncodedDirectory(key: string, bytes: Uint8Array) {
  if (encodedDirectories.has(key)) return;
  const charge = bytes.byteLength + key.length * 4 + 128;
  const maximum = MAX_ENCODED_DIRECTORY_BYTES - MAX_ADMISSION_BYTES;
  if (charge > maximum) return;
  const victims = [];
  const remaining = { bytes: encodedBudget.bytes };
  const frequency = admissionCounts.get(key) ?? 0;
  for (const [identity, value] of encodedDirectories) {
    if (remaining.bytes + charge <= maximum) break;
    if (frequency <= (admissionCounts.get(identity) ?? 0)) return;
    victims.push(identity);
    remaining.bytes -= value.byteLength + identity.length * 4 + 128;
  }
  for (const identity of victims) encodedDirectories.delete(identity);
  encodedDirectories.set(key, bytes);
  encodedBudget.bytes = remaining.bytes + charge;
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

export async function range(
  key: string,
  offset: number,
  length: number,
  compressedDirectory = false,
) {
  const resource = Match.value(compressedDirectory).pipe(
    Match.when(true, () => "directory-v1"),
    Match.orElse(() => "range"),
  );
  const rawIdentity = `${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${length}`;
  const cacheKey = Match.value(compressedDirectory).pipe(
    Match.when(true, () => `${rawIdentity}/directory-v1`),
    Match.orElse(() => rawIdentity),
  );
  if (compressedDirectory) noteDirectoryRequest(cacheKey);
  const cache = Match.value(compressedDirectory).pipe(
    Match.when(true, () => encodedDirectories),
    Match.orElse(() => buffers),
  );
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    reads.rangeCacheHits += 1;
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    if (compressedDirectory) reads.encodedDirectoryCacheHits += 1;
    else {
      cacheOrder.delete(`r:${cacheKey}`);
      cacheOrder.set(`r:${cacheKey}`, "range");
    }
    return cached;
  }
  const pending = pendingRanges.get(cacheKey);
  if (pending !== undefined) return pending;
  const acquisition = (async () => {
    const input = Schema.encodeSync(SegmentRange)({ key, offset, length });
    const url = new URL(`https://segments.internal/${resource}`);
    url.searchParams.set("key", input.key);
    url.searchParams.set("offset", String(input.offset));
    url.searchParams.set("length", String(input.length));
    const props = Schema.encodeSync(SegmentCacheProps)({ bucket: env.STORAGE_CACHE_SCOPE });
    const response = await exports.Segments({ props }).fetch(url);
    const status = response.headers.get("cf-cache-status");
    if (status === "HIT") reads.workerCacheHits += 1;
    else if (status === "MISS") reads.workerCacheMisses += 1;
    if (status !== "HIT" && response.headers.get("x-raio-cache") === "api-hit")
      reads.cacheApiHits += 1;
    reads.rangeReads += 1;
    if (!response.ok)
      throw new Rejected({
        status: 503,
        message: "Committed R2 segment unavailable",
        upstreamStatus: response.status,
        upstreamRay: response.headers.get("cf-ray"),
      });
    const bytes = new Uint8Array(await response.arrayBuffer());
    reads.rangeBytes += bytes.byteLength;
    if (!compressedDirectory && bytes.byteLength !== length)
      throw new Rejected({ status: 503, message: "R2 range returned a truncated segment" });
    if (compressedDirectory) rememberEncodedDirectory(cacheKey, bytes);
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

async function acquireDirectory(key: string, headerBytes: number) {
  const identity = `${env.STORAGE_CACHE_SCOPE}:${key}`;
  const cached = directories.get(identity);
  if (cached !== undefined) {
    reads.directoryCacheHits += 1;
    directories.delete(identity);
    directories.set(identity, cached);
    return cached.directory.retain();
  }
  const bytes = await range(key, 0, headerBytes, true);
  const concurrent = directories.get(identity);
  if (concurrent !== undefined) return concurrent.directory.retain();
  const decoded = Directory.compressed(bytes, headerBytes);
  const entry = { directory: decoded, bytes: decoded.heap_bytes() };
  if (entry.bytes > MAX_DECODED_BYTES) {
    decoded.free();
    throw new Rejected({
      status: 503,
      message: "Segment directory exceeds the decoded-memory budget",
    });
  }
  if (entry.bytes > MAX_DECODED_CACHE_BYTES) return decoded;
  while (decodedBudget.bytes + entry.bytes > MAX_DECODED_CACHE_BYTES) {
    const oldest = directories.entries().next().value;
    if (oldest === undefined) break;
    directories.delete(oldest[0]);
    decodedBudget.bytes -= oldest[1].bytes;
    oldest[1].directory.free();
  }
  directories.set(identity, entry);
  decodedBudget.bytes += entry.bytes;
  return decoded.retain();
}

export const withDirectory = Effect.fn("raio.withDirectory")(
  <A, E, R>(
    key: string,
    headerBytes: number,
    use: (directory: Directory) => Effect.Effect<A, E, R>,
    permits?: Semaphore.Semaphore,
  ) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const acquire = Effect.tryPromise({
          try: () => acquireDirectory(key, headerBytes),
          catch: (cause) => {
            if (Schema.is(Rejected)(cause)) return cause;
            return new Cause.UnknownError(cause);
          },
        });
        if (permits === undefined) return yield* acquire;
        return yield* permits.withPermit(acquire);
      }),
      use,
      (directory) => Effect.sync(() => directory.free()),
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

export const readTermProjections = Effect.fn("kannin.readTermProjections")(
  (ranges: ReadonlyArray<typeof TermProjectionRange.Type>, terms: string, filters: string) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeNanos;
      const telemetry = {
        memoryHits: 0,
        overviewCacheHits: 0,
        overviewCacheLookups: 0,
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
      const cacheKey = new URL("https://overviews.internal/batch-v4");
      cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
      const encodedRanges = yield* Schema.encodeEffect(
        Schema.fromJsonString(TermProjectionProps.fields.ranges),
      )(ranges);
      cacheKey.searchParams.set("ranges", yield* Effect.tryPromise(() => sha256(encodedRanges)));
      const cacheStarted = yield* Clock.currentTimeNanos;
      const cache = yield* Effect.tryPromise(() => caches.open("raio-overview-batches-v4")).pipe(
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
          if (candidate !== undefined && candidate.length === ranges.length) {
            telemetry.overviewCacheMs +=
              Number((yield* Clock.currentTimeNanos) - cacheStarted) / 1e6;
            const projectedAt = yield* Clock.currentTimeNanos;
            const projected = yield* Effect.forEach(
              candidate,
              (bytes) =>
                Effect.try(() => segment_overview_project(bytes, terms, filters)).pipe(
                  Effect.flatMap(decodeTermCatalog),
                ),
              { concurrency: 1 },
            ).pipe(Effect.orElseSucceed(() => undefined));
            telemetry.projectMs += Number((yield* Clock.currentTimeNanos) - projectedAt) / 1e6;
            if (projected !== undefined) {
              for (const [index, bytes] of candidate.entries()) {
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
              reads.overviewCacheApiHits += candidate.length;
              telemetry.overviewCacheHits = candidate.length;
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
      const catalogs = [];
      const sources = [];
      const admission = { bytes: 0, enabled: true };
      const r2Activity = { count: 0 };
      for (const start of Array.from(
        { length: Math.ceil(ranges.length / 4) },
        (_, index) => index * 4,
      )) {
        const window = ranges.slice(start, start + 4);
        const prefetched = yield* Effect.forEach(
          window,
          (input, offset) =>
            Effect.gen(function* () {
              if (hits.some((hit) => hit.index === start + offset)) return undefined;
              reads.correlatedReads += 1;
              telemetry.r2Reads += 1;
              r2Activity.count += 1;
              telemetry.r2Peak = Math.max(telemetry.r2Peak, r2Activity.count);
              const r2Started = yield* Clock.currentTimeNanos;
              const cached = yield* Effect.acquireUseRelease(
                Effect.tryPromise(() => env.STORAGE.get(`cache/correlated-v2/${input.key}`)),
                (object) =>
                  Effect.gen(function* () {
                    if (object === null || object.size > 2 * 1024 * 1024) return undefined;
                    const units = Math.min(
                      MAX_OVERVIEW_BODY_UNITS,
                      Math.max(1, Math.ceil((object.size * 4) / OVERVIEW_BODY_UNIT)),
                    );
                    return yield* overviewBodyReads.withPermits(units)(
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
                    );
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
            }).pipe(Effect.orElseSucceed(() => undefined)),
          { concurrency: 4 },
        );
        for (const [offset, input] of window.entries()) {
          const index = start + offset;
          const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`;
          const hit = hits.find((entry) => entry.index === index);
          const selected = { bytes: hit?.bytes, catalog: hit?.catalog };
          if (selected.bytes === undefined || selected.catalog === undefined) {
            const derived = yield* Effect.gen(function* () {
              const bytes = prefetched[offset];
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
              (yield* withDirectory(input.key, input.headerBytes, (directory) =>
                Effect.gen(function* () {
                  telemetry.fallbackDirectories += 1;
                  const dictionary = yield* Effect.try(() => directory.summary(terms)).pipe(
                    Effect.flatMap(decodeTermSummaries),
                  );
                  const minimum = yield* Effect.try(() => directory.minimum(filters)).pipe(
                    Effect.flatMap(decodeEligibleMinimum),
                  );
                  const bytes = yield* Effect.try(() => directory.overview()).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  return { bytes, catalog: { dictionary, minimum, partitions: null } };
                }),
              ));
            if (derived === undefined)
              telemetry.fallbackMs +=
                Number((yield* Clock.currentTimeNanos) - fallbackStarted) / 1e6;
            selected.bytes = projection.bytes;
            selected.catalog = projection.catalog;
            if (derived === undefined && projection.bytes !== undefined) reads.overviewBuilds += 1;
          } else {
            reads.overviewMemoryHits += 1;
            telemetry.memoryHits += 1;
          }
          const bytes = selected.bytes;
          catalogs.push(selected.catalog);
          if (bytes === undefined) {
            admission.enabled = false;
            sources.length = 0;
            continue;
          }
          rememberOverview(identity, bytes);
          admission.bytes += bytes.byteLength;
          if (admission.bytes > 3 * 1024 * 1024) {
            admission.enabled = false;
            sources.length = 0;
          }
          if (admission.enabled) sources.push(bytes);
        }
      }
      if (cache !== undefined && admission.enabled) {
        const publishedAt = yield* Clock.currentTimeNanos;
        const encoded = yield* encodeOverviewBatch(sources);
        yield* Effect.tryPromise(() =>
          cache.put(
            cacheKey,
            new Response(encoded, {
              headers: {
                "cache-control": "public, max-age=31536000, immutable",
                "content-type": "application/json",
              },
            }),
          ),
        ).pipe(Effect.orElseSucceed(() => undefined));
        telemetry.publishMs += Number((yield* Clock.currentTimeNanos) - publishedAt) / 1e6;
      }
      telemetry.totalMs = Number((yield* Clock.currentTimeNanos) - started) / 1e6;
      return { catalogs, telemetry };
    }),
);

function rememberTermCatalogs(identity: string, value: typeof CachedTermCatalogs.Type) {
  const encoded = Schema.encodeSync(Schema.fromJsonString(CachedTermCatalogs))(value);
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
    terms: string,
    filters: string,
    timings: Headers,
  ) =>
    Effect.gen(function* () {
      const metrics = {
        requests: 0,
        nativeHits: 0,
        apiHits: 0,
        originResponses: 0,
        fetchMs: 0,
        fetchMaxMs: 0,
        bodyMs: 0,
        decodeMs: 0,
        sourceTotalMs: 0,
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
      const windows = Array.from({ length: Math.ceil(ranges.length / 16) }, (_, index) =>
        ranges.slice(index * 16, index * 16 + 16),
      );
      const batches = yield* Effect.forEach(
        windows,
        (window) =>
          Effect.gen(function* () {
            const selected = window.map((input) => {
              const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`;
              const entry = termCatalogs.get(identity);
              if (entry !== undefined) {
                termCatalogs.delete(identity);
                termCatalogs.set(identity, entry);
              }
              return {
                input,
                identity,
                projection: entry?.value.projections[terms],
                minimum: entry?.value.minima[filters],
              };
            });
            reads.termMemoryHits += selected.filter(
              (entry) => entry.projection !== undefined && entry.minimum !== undefined,
            ).length;
            const groups = [
              {
                terms,
                filters,
                entries: selected.filter(
                  (entry) => entry.projection === undefined && entry.minimum === undefined,
                ),
              },
              {
                terms,
                filters: "[]",
                entries: selected.filter(
                  (entry) => entry.projection === undefined && entry.minimum !== undefined,
                ),
              },
              {
                terms: "[]",
                filters,
                entries: selected.filter(
                  (entry) => entry.projection !== undefined && entry.minimum === undefined,
                ),
              },
            ];
            for (const group of groups) {
              if (group.entries.length === 0) continue;
              const props = {
                bucket: env.STORAGE_CACHE_SCOPE,
                terms: group.terms,
                filters: group.filters,
                ranges: group.entries.map(({ input }) => ({
                  key: input.key,
                  headerBytes: input.headerBytes,
                })),
              };
              const fetchedAt = yield* Clock.currentTimeNanos;
              const response = yield* Effect.tryPromise({
                try: () => exports.Terms({ props }).fetch("https://terms.internal/catalog-v6"),
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
              if (status !== "HIT" && response.headers.get("x-raio-cache") === "terms-api-hit")
                reads.termCacheApiHits += group.entries.length;
              const bodyAt = yield* Clock.currentTimeNanos;
              const text = yield* Effect.tryPromise(() => response.text());
              metrics.bodyMs += Number((yield* Clock.currentTimeNanos) - bodyAt) / 1e6;
              if (!response.ok)
                return yield* new Rejected({
                  status: 503,
                  message: "Immutable term catalog unavailable",
                });
              const decodedAt = yield* Clock.currentTimeNanos;
              const catalogs = yield* decodeTermCatalogBatch(text);
              metrics.decodeMs += Number((yield* Clock.currentTimeNanos) - decodedAt) / 1e6;
              if (status !== "HIT" && response.headers.get("x-raio-cache") === "terms-api-hit")
                metrics.apiHits += 1;
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
                if (entry.projection === undefined)
                  entry.projection = {
                    dictionary: catalog.dictionary,
                    partitions: catalog.partitions,
                  };
                if (entry.minimum === undefined) entry.minimum = catalog.minimum;
                const previous = termCatalogs.get(entry.identity);
                const projections = new Map(Object.entries(previous?.value.projections ?? {}));
                const minima = new Map(Object.entries(previous?.value.minima ?? {}));
                projections.set(terms, entry.projection);
                minima.set(filters, entry.minimum);
                rememberTermCatalogs(entry.identity, {
                  projections: Object.fromEntries(projections),
                  minima: Object.fromEntries(minima),
                });
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
          `catalog_rpc_sum;dur=${metrics.fetchMs};desc="requests=${metrics.requests} native_hits=${metrics.nativeHits} api_hits=${metrics.apiHits} origins=${metrics.originResponses}"`,
          `catalog_rpc_max;dur=${metrics.fetchMaxMs}`,
          `catalog_body_sum;dur=${metrics.bodyMs}`,
          `catalog_decode_sum;dur=${metrics.decodeMs}`,
          `catalog_origin_sum;dur=${metrics.sourceTotalMs}`,
          `catalog_entry_sum;dur=${metrics.sourceEntryMs}`,
          `catalog_publish_sum;dur=${metrics.sourcePublishMs}`,
          `catalog_source_cache_sum;dur=${metrics.sourceCacheMs};desc="memory=${metrics.sourceMemoryHits} api=${metrics.sourceApiHits}"`,
          `catalog_source_r2_sum;dur=${metrics.sourceR2Ms};desc="reads=${metrics.sourceR2Reads} hits=${metrics.sourceR2Hits} bytes=${metrics.sourceR2Bytes} batch_peak=${metrics.sourceR2Peak}"`,
          `catalog_source_project_sum;dur=${metrics.sourceProjectMs}`,
          `catalog_source_fallback_sum;dur=${metrics.sourceFallbackMs};desc="directories=${metrics.sourceFallbacks}"`,
        ].join(", "),
      );
      return batches.flat();
    }),
);

export const storeCorrelatedOverview = Effect.fn("kannin.storeCorrelatedOverview")(
  (key: string, headerBytes: number, bytes: Uint8Array) =>
    Effect.gen(function* () {
      const overview = yield* Effect.try(() => segment_correlated_overview(bytes));
      if (overview === undefined) return;
      const encoded = yield* encodeCorrelatedOverview({
        bucket: env.STORAGE_CACHE_SCOPE,
        source: { key, headerBytes },
        overview,
      });
      yield* Effect.tryPromise(() =>
        env.STORAGE.put(`cache/correlated-v2/${key}`, encoded, {
          httpMetadata: { contentType: "application/json" },
        }),
      );
    }).pipe(Effect.orElseSucceed(() => undefined)),
);

export const buildSegment = Effect.fn("raio.buildSegment")(
  (documents: ReadonlyArray<typeof StoredDocument.Type>) =>
    Effect.acquireUseRelease(
      Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents).pipe(
        Effect.map((encoded) => new Segment(encoded)),
      ),
      (segment) =>
        Schema.decodeEffect(Schema.fromJsonString(SegmentHeader))(segment.header_json()).pipe(
          Effect.map((header) => ({ bytes: segment.bytes(), header })),
        ),
      (segment) => Effect.sync(() => segment.free()),
    ),
);

export function bloom(values: ReadonlyArray<string>) {
  const bytes = segment_bloom(encodeStrings(values));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
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
    const bitsets = window.map((segment) =>
      Uint8Array.from(atob(segment[field]), (character) => character.charCodeAt(0)),
    );
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
  else page.bytes = await range(key, offset, data.length);
  const bytes = page.bytes;
  return decodeStoredDocument(segment_document(bytes));
}

export const readDocuments = Effect.fn("raio.readDocuments")(function* (
  key: string,
  headerBytes: number,
  pages: ReadonlyArray<typeof DataRange.Type>,
  totalBytes: number,
  permits: Semaphore.Semaphore,
) {
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
      try: () => range(key, headerBytes + first.offset, span.end - first.offset),
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

export function rememberSegmentScoreBound(key: string, bound: number) {
  const charge = key.length * 4 + 128;
  if (charge > MAX_SCORE_BOUND_BYTES) return;
  const prior = scoreBounds.get(key);
  if (prior !== undefined) {
    scoreBounds.delete(key);
    scoreBounds.set(key, Math.min(prior, bound));
    return;
  }
  while (scoreBoundBudget.bytes + charge > MAX_SCORE_BOUND_BYTES) {
    const oldest = scoreBounds.keys().next().value;
    if (oldest === undefined) break;
    scoreBounds.delete(oldest);
    scoreBoundBudget.bytes -= oldest.length * 4 + 128;
  }
  scoreBounds.set(key, bound);
  scoreBoundBudget.bytes += charge;
}

export function clearImmutableCache(prefix: string) {
  const identity = `${env.STORAGE_CACHE_SCOPE}:${prefix}`;
  for (const [key, entry] of textPlans)
    if (key.startsWith(`${identity}/`)) {
      textPlans.delete(key);
      textPlanBudget.bytes -= entry.bytes;
    }
  for (const key of scoreBounds.keys())
    if (key.startsWith(`${identity}/`)) {
      scoreBounds.delete(key);
      scoreBoundBudget.bytes -= key.length * 4 + 128;
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
  for (const [key, bytes] of encodedDirectories)
    if (key.startsWith(`${identity}/`)) {
      encodedDirectories.delete(key);
      encodedBudget.bytes -= bytes.byteLength + key.length * 4 + 128;
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
