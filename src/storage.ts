import { Cause, Effect, Match, Schema } from "effect";
import type { Semaphore } from "effect";
import { env, exports } from "cloudflare:workers";
import {
  Segment,
  Directory,
  segment_document,
  segment_bloom,
  BloomBatch,
  FrequencyPage,
  segment_overview_project,
} from "../dist/wasm/raio_engine";
import type { Ranker } from "../dist/wasm/raio_engine";
import type { DataRange, TermProjectionRange, Root } from "./protocol";
import {
  StoredDocument,
  SegmentHeader,
  SegmentRange,
  TermCatalog,
  TermSummaries,
  EligibleMinimum,
  TermCatalogBatch,
  OverviewBatch,
  TermProjectionProps,
  SegmentCacheProps,
  Rejected,
} from "./protocol";

const buffers = new Map<string, Uint8Array>();
const frequencyPages = new Map<string, { page: FrequencyPage; bytes: number }>();
const frequencyBudget = { bytes: 0 };
const cacheOrder = new Map<string, "range" | "frequency">();
const pendingRanges = new Map<string, Promise<Uint8Array>>();
const MAX_PENDING_RANGES = 64;
const budget = { bytes: 0 };
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
const directories = new Map<string, { directory: Directory; bytes: number }>();
const decodedBudget = { bytes: 0 };
const MAX_DECODED_BYTES = 40 * 1024 * 1024;
const CachedTermCatalogs = Schema.Struct({
  dictionaries: Schema.Record(Schema.String, TermSummaries),
  minima: Schema.Record(Schema.String, EligibleMinimum),
});
const termCatalogs = new Map<string, { value: typeof CachedTermCatalogs.Type; bytes: number }>();
const termBudget = { bytes: 0 };
const MAX_TERM_CACHE_BYTES = 4 * 1024 * 1024;
const overviewBuffers = new Map<string, Uint8Array>();
const overviewBudget = { bytes: 0 };
const MAX_OVERVIEW_BYTES = 4 * 1024 * 1024;
const reads = {
  overviewMemoryHits: 0,
  overviewCacheApiHits: 0,
  overviewCacheApiLookups: 0,
  overviewBuilds: 0,
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
  workerCacheHits: 0,
  workerCacheMisses: 0,
  cacheApiHits: 0,
};
const bloomBatches = new Map<string, { batch: BloomBatch; bytes: number; prefix: string }>();
const bloomBudget = { bytes: 0 };
const strings = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStrings = Schema.encodeSync(strings);
const decodeTermCatalog = Schema.decodeEffect(Schema.fromJsonString(TermCatalog));
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
      if (prior !== undefined) budget.bytes -= prior.byteLength;
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
  if (previous !== undefined) budget.bytes -= previous.byteLength;
  buffers.delete(key);
  cacheOrder.delete(`r:${key}`);
  if (bytes.byteLength > MAX_CACHE_BYTES) return;
  evictFor(bytes.byteLength);
  buffers.set(key, bytes);
  cacheOrder.set(`r:${key}`, "range");
  budget.bytes += bytes.byteLength;
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
  const cached = buffers.get(cacheKey);
  if (cached !== undefined) {
    reads.rangeCacheHits += 1;
    buffers.delete(cacheKey);
    buffers.set(cacheKey, cached);
    cacheOrder.delete(`r:${cacheKey}`);
    cacheOrder.set(`r:${cacheKey}`, "range");
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
    remember(cacheKey, bytes);
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
  while (decodedBudget.bytes + entry.bytes > MAX_DECODED_BYTES) {
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
      const hits = [];
      for (const [index, input] of ranges.entries()) {
        const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`;
        const bytes = overviewBuffers.get(identity);
        if (bytes === undefined) continue;
        const catalog = yield* Effect.try(() =>
          segment_overview_project(bytes, terms, filters),
        ).pipe(
          Effect.flatMap(decodeTermCatalog),
          Effect.orElseSucceed(() => undefined),
        );
        if (catalog === undefined) {
          overviewBuffers.delete(identity);
          overviewBudget.bytes -=
            bytes.byteLength + new TextEncoder().encode(identity).byteLength * 4 + 128;
          continue;
        }
        hits.push({ index, identity, bytes, catalog });
      }
      if (hits.length === ranges.length) {
        for (const hit of hits) rememberOverview(hit.identity, hit.bytes);
        reads.overviewMemoryHits += hits.length;
        return hits.map((hit) => hit.catalog);
      }
      const cacheKey = new URL("https://overviews.internal/batch-v2");
      cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
      const encodedRanges = yield* Schema.encodeEffect(
        Schema.fromJsonString(TermProjectionProps.fields.ranges),
      )(ranges);
      cacheKey.searchParams.set("ranges", yield* Effect.tryPromise(() => sha256(encodedRanges)));
      const cache = yield* Effect.tryPromise(() => caches.open("raio-overview-batches-v2")).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (cache !== undefined) {
        reads.overviewCacheApiLookups += 1;
        const cached = yield* Effect.tryPromise(() => cache.match(cacheKey)).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (cached !== undefined) {
          const candidate = yield* Effect.tryPromise(() => cached.text()).pipe(
            Effect.flatMap(decodeOverviewBatch),
            Effect.orElseSucceed(() => undefined),
          );
          if (candidate !== undefined && candidate.length === ranges.length) {
            const projected = yield* Effect.forEach(
              candidate,
              (bytes) =>
                Effect.try(() => segment_overview_project(bytes, terms, filters)).pipe(
                  Effect.flatMap(decodeTermCatalog),
                ),
              { concurrency: 1 },
            ).pipe(Effect.orElseSucceed(() => undefined));
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
              return projected;
            }
          }
          yield* Effect.tryPromise(() => cache.delete(cacheKey)).pipe(
            Effect.orElseSucceed(() => false),
          );
        }
      }
      const catalogs = [];
      const sources = [];
      const admission = { bytes: 0, enabled: true };
      for (const [index, input] of ranges.entries()) {
        const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}`;
        const hit = hits.find((entry) => entry.index === index);
        const selected = { bytes: hit?.bytes, catalog: hit?.catalog };
        if (selected.bytes === undefined || selected.catalog === undefined) {
          const projection = yield* withDirectory(input.key, input.headerBytes, (directory) =>
            Effect.gen(function* () {
              const dictionary = yield* Effect.try(() => directory.summary(terms)).pipe(
                Effect.flatMap(decodeTermSummaries),
              );
              const minimum = yield* Effect.try(() => directory.minimum(filters)).pipe(
                Effect.flatMap(decodeEligibleMinimum),
              );
              const bytes = yield* Effect.try(() => directory.overview()).pipe(
                Effect.orElseSucceed(() => undefined),
              );
              return { bytes, catalog: { dictionary, minimum } };
            }),
          );
          selected.bytes = projection.bytes;
          selected.catalog = projection.catalog;
          if (projection.bytes !== undefined) reads.overviewBuilds += 1;
        } else reads.overviewMemoryHits += 1;
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
      if (cache !== undefined && admission.enabled) {
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
      }
      return catalogs;
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
  (ranges: ReadonlyArray<typeof TermProjectionRange.Type>, terms: string, filters: string) =>
    Effect.gen(function* () {
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
                dictionary: entry?.value.dictionaries[terms],
                minimum: entry?.value.minima[filters],
              };
            });
            reads.termMemoryHits += selected.filter(
              (entry) => entry.dictionary !== undefined && entry.minimum !== undefined,
            ).length;
            const groups = [
              {
                terms,
                filters,
                entries: selected.filter(
                  (entry) => entry.dictionary === undefined && entry.minimum === undefined,
                ),
              },
              {
                terms,
                filters: "[]",
                entries: selected.filter(
                  (entry) => entry.dictionary === undefined && entry.minimum !== undefined,
                ),
              },
              {
                terms: "[]",
                filters,
                entries: selected.filter(
                  (entry) => entry.dictionary !== undefined && entry.minimum === undefined,
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
              const response = yield* Effect.tryPromise({
                try: () => exports.Terms({ props }).fetch("https://terms.internal/catalog-v4"),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
              reads.termReads += group.entries.length;
              reads.termRequests += 1;
              const status = response.headers.get("cf-cache-status");
              if (status === "HIT") reads.termWorkerCacheHits += group.entries.length;
              if (status !== "HIT" && response.headers.get("x-raio-cache") === "terms-api-hit")
                reads.termCacheApiHits += group.entries.length;
              const text = yield* Effect.tryPromise(() => response.text());
              if (!response.ok)
                return yield* new Rejected({
                  status: 503,
                  message: "Immutable term catalog unavailable",
                });
              const catalogs = yield* decodeTermCatalogBatch(text);
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
                if (entry.dictionary === undefined) entry.dictionary = catalog.dictionary;
                if (entry.minimum === undefined) entry.minimum = catalog.minimum;
                const previous = termCatalogs.get(entry.identity);
                const dictionaries = new Map(Object.entries(previous?.value.dictionaries ?? {}));
                const minima = new Map(Object.entries(previous?.value.minima ?? {}));
                dictionaries.set(terms, entry.dictionary);
                minima.set(filters, entry.minimum);
                rememberTermCatalogs(entry.identity, {
                  dictionaries: Object.fromEntries(dictionaries),
                  minima: Object.fromEntries(minima),
                });
              }
            }
            return yield* Effect.forEach(selected, (entry) => {
              if (entry.dictionary === undefined || entry.minimum === undefined)
                return Effect.fail(
                  new Rejected({ status: 503, message: "Term projection omitted a segment" }),
                );
              return Effect.succeed({ dictionary: entry.dictionary, minimum: entry.minimum });
            });
          }),
        { concurrency: 8 },
      );
      return batches.flat();
    }),
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

export function clearImmutableCache(prefix: string) {
  const identity = `${env.STORAGE_CACHE_SCOPE}:${prefix}`;
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
  for (const [key, bytes] of buffers)
    if (key.startsWith(`${identity}/`)) {
      buffers.delete(key);
      cacheOrder.delete(`r:${key}`);
      budget.bytes -= bytes.byteLength;
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
    rangeCacheBytes: budget.bytes,
    postingCacheBytes: frequencyBudget.bytes,
    directoryCacheChargedBytes: decodedBudget.bytes,
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
