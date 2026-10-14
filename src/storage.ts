import { Cause, Effect, Schema } from "effect";
import { env, exports } from "cloudflare:workers";
import {
  Segment,
  Directory,
  segment_document,
  segment_bloom,
  segment_bloom_filter_many,
  segment_overview_project,
} from "../dist/wasm/raio_engine";
import type { DataRange, TermProjectionRange } from "./protocol";
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
const budget = { bytes: 0 };
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
const directories = new Map<string, { directory: Directory; bytes: number }>();
const decodedBudget = { bytes: 0 };
const MAX_DECODED_BYTES = 40 * 1024 * 1024;
const termCatalogs = new Map<string, { catalog: typeof TermCatalog.Type; bytes: number }>();
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
const bloomBuffers = new Map<string, Uint8Array>();
const bloomBudget = { bytes: 0 };
const strings = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStrings = Schema.encodeSync(strings);

function remember(key: string, bytes: Uint8Array) {
  const previous = buffers.get(key);
  if (previous !== undefined) budget.bytes -= previous.byteLength;
  buffers.delete(key);
  if (bytes.byteLength > MAX_CACHE_BYTES) return;
  buffers.set(key, bytes);
  budget.bytes += bytes.byteLength;
  while (budget.bytes > MAX_CACHE_BYTES) {
    const oldest = buffers.entries().next().value;
    if (oldest === undefined) break;
    buffers.delete(oldest[0]);
    budget.bytes -= oldest[1].byteLength;
  }
}

export async function range(key: string, offset: number, length: number) {
  const cacheKey = `${env.STORAGE_CACHE_SCOPE}:${key}/${offset}/${length}`;
  const cached = buffers.get(cacheKey);
  if (cached !== undefined) {
    reads.rangeCacheHits += 1;
    buffers.delete(cacheKey);
    buffers.set(cacheKey, cached);
    return cached;
  }
  const input = Schema.encodeSync(SegmentRange)({ key, offset, length });
  const url = new URL("https://segments.internal/range");
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
    throw new Rejected({ status: 503, message: "Committed R2 segment unavailable" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  reads.rangeBytes += bytes.byteLength;
  if (bytes.byteLength !== length)
    throw new Rejected({ status: 503, message: "R2 range returned a truncated segment" });
  remember(cacheKey, bytes);
  return bytes;
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
  const bytes = await range(key, 0, headerBytes);
  const concurrent = directories.get(identity);
  if (concurrent !== undefined) return concurrent.directory.retain();
  const decoded = new Directory(bytes);
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
  ) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireDirectory(key, headerBytes),
        catch: (cause) => {
          if (Schema.is(Rejected)(cause)) return cause;
          return new Cause.UnknownError(cause);
        },
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
        const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}\0${filters}`;
        const bytes = overviewBuffers.get(identity);
        if (bytes === undefined) continue;
        const catalog = yield* Effect.try(() => segment_overview_project(bytes, terms)).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TermCatalog))),
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
      const cacheKey = new URL("https://overviews.internal/batch-v1");
      cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
      const encodedRanges = yield* Schema.encodeEffect(
        Schema.fromJsonString(TermProjectionProps.fields.ranges),
      )(ranges);
      cacheKey.searchParams.set("ranges", yield* Effect.tryPromise(() => sha256(encodedRanges)));
      cacheKey.searchParams.set("filters", yield* Effect.tryPromise(() => sha256(filters)));
      const cache = yield* Effect.tryPromise(() => caches.open("raio-overview-batches-v1")).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (cache !== undefined) {
        reads.overviewCacheApiLookups += 1;
        const cached = yield* Effect.tryPromise(() => cache.match(cacheKey)).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (cached !== undefined) {
          const candidate = yield* Effect.tryPromise(() => cached.text()).pipe(
            Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(OverviewBatch))),
            Effect.orElseSucceed(() => undefined),
          );
          if (candidate !== undefined && candidate.length === ranges.length) {
            const projected = yield* Effect.forEach(
              candidate,
              (bytes) =>
                Effect.try(() => segment_overview_project(bytes, terms)).pipe(
                  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TermCatalog))),
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
                  `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}\0${filters}`,
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
        const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}\0${filters}`;
        const hit = hits.find((entry) => entry.index === index);
        const selected = { bytes: hit?.bytes, catalog: hit?.catalog };
        if (selected.bytes === undefined || selected.catalog === undefined) {
          const projection = yield* withDirectory(input.key, input.headerBytes, (directory) =>
            Effect.gen(function* () {
              const dictionary = yield* Effect.try(() => directory.summary(terms)).pipe(
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TermSummaries))),
              );
              const minimum = yield* Effect.try(() => directory.minimum(filters)).pipe(
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(EligibleMinimum))),
              );
              const bytes = yield* Effect.try(() => directory.overview(filters));
              return { bytes, catalog: { dictionary, minimum } };
            }),
          );
          selected.bytes = projection.bytes;
          selected.catalog = projection.catalog;
          reads.overviewBuilds += 1;
        } else reads.overviewMemoryHits += 1;
        const bytes = selected.bytes;
        rememberOverview(identity, bytes);
        catalogs.push(selected.catalog);
        admission.bytes += bytes.byteLength;
        if (admission.bytes > 3 * 1024 * 1024) {
          admission.enabled = false;
          sources.length = 0;
        }
        if (admission.enabled) sources.push(bytes);
      }
      if (cache !== undefined && admission.enabled) {
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OverviewBatch))(sources);
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
            const hits = [];
            for (const input of window) {
              const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}/${terms}\0${filters}`;
              const entry = termCatalogs.get(identity);
              if (entry === undefined) break;
              hits.push({ identity, entry });
            }
            if (hits.length === window.length) {
              reads.termMemoryHits += hits.length;
              for (const hit of hits) {
                termCatalogs.delete(hit.identity);
                termCatalogs.set(hit.identity, hit.entry);
              }
              return hits.map((hit) => hit.entry.catalog);
            }
            const props = {
              bucket: env.STORAGE_CACHE_SCOPE,
              terms,
              filters,
              ranges: window.map((input) => ({ key: input.key, headerBytes: input.headerBytes })),
            };
            const response = yield* Effect.tryPromise({
              try: () => exports.Terms({ props }).fetch("https://terms.internal/catalog-v4"),
              catch: (cause) => {
                if (Schema.is(Rejected)(cause)) return cause;
                return new Cause.UnknownError(cause);
              },
            });
            reads.termReads += window.length;
            reads.termRequests += 1;
            const status = response.headers.get("cf-cache-status");
            if (status === "HIT") reads.termWorkerCacheHits += window.length;
            if (status !== "HIT" && response.headers.get("x-raio-cache") === "terms-api-hit")
              reads.termCacheApiHits += window.length;
            const text = yield* Effect.tryPromise(() => response.text());
            if (!response.ok)
              return yield* new Rejected({
                status: 503,
                message: "Immutable term catalog unavailable",
              });
            const catalogs = yield* Schema.decodeEffect(Schema.fromJsonString(TermCatalogBatch))(
              text,
            );
            if (catalogs.length !== window.length)
              return yield* new Rejected({
                status: 503,
                message: "Term projection batch omitted a segment",
              });
            reads.termBytes += new TextEncoder().encode(text).byteLength;
            for (const [index, catalog] of catalogs.entries()) {
              const input = window[index];
              if (input === undefined)
                return yield* new Rejected({
                  status: 503,
                  message: "Term projection batch added a segment",
                });
              const identity = `${env.STORAGE_CACHE_SCOPE}:${input.key}/${input.headerBytes}/${terms}\0${filters}`;
              const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(TermCatalog))(
                catalog,
              );
              const length = new TextEncoder().encode(encoded).byteLength;
              const bytes = 4 * (length + new TextEncoder().encode(identity).byteLength) + 256;
              if (bytes > MAX_TERM_CACHE_BYTES) continue;
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
              termCatalogs.set(identity, { catalog, bytes });
              termBudget.bytes += bytes;
            }
            return catalogs;
          }),
        { concurrency: 4 },
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

export function bloomCandidates(encoded: ReadonlyArray<string>, values: ReadonlyArray<string>) {
  const input = encodeStrings(values);
  const selected = [];
  for (const offset of Array.from(
    { length: Math.ceil(encoded.length / 64) },
    (_, index) => index * 64,
  )) {
    const bitsets = encoded.slice(offset, offset + 64).map((value) => {
      const cached = bloomBuffers.get(value);
      if (cached !== undefined) {
        bloomBuffers.delete(value);
        bloomBuffers.set(value, cached);
        return cached;
      }
      const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
      bloomBuffers.set(value, bytes);
      bloomBudget.bytes += bytes.byteLength;
      while (bloomBudget.bytes > 4 * 1024 * 1024) {
        const oldest = bloomBuffers.entries().next().value;
        if (oldest === undefined) break;
        bloomBuffers.delete(oldest[0]);
        bloomBudget.bytes -= oldest[1].byteLength;
      }
      return bytes;
    });
    const packed = new Uint8Array(bitsets.reduce((total, bytes) => total + bytes.byteLength, 0));
    const offsets = new Uint32Array(bitsets.length + 1);
    const layout = { offset: 0 };
    for (const [index, bytes] of bitsets.entries()) {
      offsets[index] = layout.offset;
      packed.set(bytes, layout.offset);
      layout.offset += bytes.byteLength;
    }
    offsets[bitsets.length] = layout.offset;
    selected.push(
      ...Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))))(
        segment_bloom_filter_many(packed, offsets, input),
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
  return Schema.decodeSync(Schema.fromJsonString(StoredDocument))(segment_document(bytes));
}

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
      budget.bytes -= bytes.byteLength;
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
