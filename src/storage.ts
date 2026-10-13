import { Cause, Effect, Schema } from "effect";
import { exports } from "cloudflare:workers";
import {
  Segment,
  Directory,
  segment_document,
  segment_bloom,
  segment_bloom_filter,
} from "../dist/wasm/raio_engine";
import type { DataRange } from "./protocol";
import { StoredDocument, SegmentHeader, SegmentRange, Rejected } from "./protocol";

const buffers = new Map<string, Uint8Array>();
const budget = { bytes: 0 };
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
const directories = new Map<string, { directory: Directory; bytes: number }>();
const decodedBudget = { bytes: 0 };
const MAX_DECODED_BYTES = 40 * 1024 * 1024;
const reads = {
  rangeReads: 0,
  rangeBytes: 0,
  rangeCacheHits: 0,
  directoryCacheHits: 0,
  workerCacheHits: 0,
  workerCacheMisses: 0,
  cacheApiHits: 0,
};
const bucketIds = new WeakMap<R2Bucket, number>();
const bucketSequence = { value: 0 };
const bloomBuffers = new Map<string, Uint8Array>();
const bloomBudget = { bytes: 0 };
const strings = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStrings = Schema.encodeSync(strings);
const decodeStrings = Schema.decodeSync(strings);

function cachePrefix(bucket: R2Bucket, key: string) {
  const existing = bucketIds.get(bucket);
  if (existing !== undefined) return `${existing}:${key}`;
  bucketSequence.value += 1;
  bucketIds.set(bucket, bucketSequence.value);
  return `${bucketSequence.value}:${key}`;
}

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

export async function range(bucket: R2Bucket, key: string, offset: number, length: number) {
  const cacheKey = cachePrefix(bucket, `${key}/${offset}/${length}`);
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
  const response = await exports.Segments.fetch(url);
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

async function acquireDirectory(bucket: R2Bucket, key: string, headerBytes: number) {
  const identity = cachePrefix(bucket, key);
  const cached = directories.get(identity);
  if (cached !== undefined) {
    reads.directoryCacheHits += 1;
    directories.delete(identity);
    directories.set(identity, cached);
    return cached.directory.retain();
  }
  const bytes = await range(bucket, key, 0, headerBytes);
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
    bucket: R2Bucket,
    key: string,
    headerBytes: number,
    use: (directory: Directory) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireDirectory(bucket, key, headerBytes),
        catch: (cause) => {
          if (Schema.is(Rejected)(cause)) return cause;
          return new Cause.UnknownError(cause);
        },
      }),
      use,
      (directory) => Effect.sync(() => directory.free()),
    ),
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

export function bloomCandidates(encoded: string, values: ReadonlyArray<string>) {
  const cached = bloomBuffers.get(encoded);
  if (cached !== undefined) {
    bloomBuffers.delete(encoded);
    bloomBuffers.set(encoded, cached);
    return decodeStrings(segment_bloom_filter(cached, encodeStrings(values)));
  }
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  bloomBuffers.set(encoded, bytes);
  bloomBudget.bytes += bytes.byteLength;
  while (bloomBudget.bytes > 4 * 1024 * 1024) {
    const oldest = bloomBuffers.entries().next().value;
    if (oldest === undefined) break;
    bloomBuffers.delete(oldest[0]);
    bloomBudget.bytes -= oldest[1].byteLength;
  }
  return decodeStrings(segment_bloom_filter(bytes, encodeStrings(values)));
}

export async function readDocument(
  bucket: R2Bucket,
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
  else page.bytes = await range(bucket, key, offset, data.length);
  const bytes = page.bytes;
  return Schema.decodeSync(Schema.fromJsonString(StoredDocument))(segment_document(bytes));
}

export function clearImmutableCache(bucket: R2Bucket, prefix: string) {
  const identity = cachePrefix(bucket, prefix);
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
    ...reads,
  };
}

export async function sha256(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
