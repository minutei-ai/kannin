import { encodeCanonicalDocuments } from "./segment-fixture";
import { env } from "cloudflare:workers";
import { Effect, Match, Option, Schema, Semaphore } from "effect";
import {
  cacheUsage,
  clearImmutableCache,
  range,
  addFrequencyPosting,
  withDirectory,
  readDocuments,
  documentReadConcurrency,
} from "../src/storage";
import { Segment, Directory } from "../dist/wasm/raio_engine";
import {
  SegmentHeader,
  RankingInput,
  StoredDocument,
  CanonicalQueryDocument,
  canonicalToNativeDocument,
} from "../src/protocol";
import {
  RangeProbeInput,
  RangeProbeResult,
  DirectoryScanInput,
  DirectoryScanResult,
  DirectoryAgingInput,
  DirectoryAgingResult,
  DecodedDirectoryScanResult,
  DocumentPageProbeInput,
} from "./range-contract";

export { Segments, SearchNamespace } from "../src/worker";

export default {
  async fetch(request: Request) {
    if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
      return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (new URL(request.url).pathname === "/document-pages") {
      const input = Schema.decodeUnknownSync(DocumentPageProbeInput)(await request.json());
      const before = cacheUsage();
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          const permits = yield* Semaphore.make(documentReadConcurrency(input.pages));
          const documents = yield* readDocuments(
            input.source.key,
            input.source.headerBytes,
            input.pages,
            input.bytes,
            input.metadataEnd,
            permits,
          );
          return yield* Schema.decodeUnknownEffect(Schema.Array(CanonicalQueryDocument))(documents);
        }).pipe(
          Effect.match({
            onFailure: () => new Response(null, { status: 503 }),
            onSuccess: (documents) =>
              Response.json(
                Schema.encodeSync(Schema.Array(StoredDocument))(
                  documents.map(canonicalToNativeDocument),
                ),
              ),
          }),
        ),
      );
      const after = cacheUsage();
      response.headers.set("x-reads", String(after.rangeReads - before.rangeReads));
      response.headers.set("x-bytes", String(after.rangeBytes - before.rangeBytes));
      response.headers.set("x-charged", String(after.rangeCacheChargedBytes));
      response.headers.set("x-cache-hits", String(after.rangeCacheHits - before.rangeCacheHits));
      return response;
    }
    if (new URL(request.url).pathname === "/decoded-directory-scan") {
      const inputs = Schema.decodeUnknownSync(DirectoryScanInput)(await request.json());
      clearImmutableCache("namespaces");
      const reports = [];
      for (const cycle of [0, 1, 2]) {
        const before = cacheUsage();
        const metadata = [];
        for (const input of inputs)
          metadata.push(
            await Effect.runPromise(
              withDirectory(input.key, input.length, (directory) =>
                Effect.try(() => directory.terms('["alpha"]')).pipe(
                  Effect.flatMap(
                    Schema.decodeEffect(Schema.fromJsonString(SegmentHeader.fields.terms)),
                  ),
                ),
              ),
            ),
          );
        const after = cacheUsage();
        reports[cycle] = {
          hits: after.directoryCacheHits - before.directoryCacheHits,
          bytes: after.directoryCacheChargedBytes,
          history: after.encodedDirectoryAdmissionChargedBytes,
          metadata,
        };
      }
      return new Response(
        Schema.encodeSync(Schema.fromJsonString(DecodedDirectoryScanResult))(reports),
      );
    }
    if (new URL(request.url).pathname === "/directory-aging") {
      const inputs = Schema.decodeUnknownSync(DirectoryAgingInput)(await request.json());
      clearImmutableCache("namespaces");
      for (const directoryRange of inputs)
        await range(directoryRange.key, directoryRange.offset, directoryRange.length, true);
      const before = cacheUsage();
      const hot = inputs[0];
      for (const directoryRange of Array.from({ length: 4096 }, () => hot))
        await range(directoryRange.key, directoryRange.offset, directoryRange.length, true);
      const after = cacheUsage();
      return new Response(
        Schema.encodeSync(Schema.fromJsonString(DirectoryAgingResult))({
          before: before.encodedDirectoryAdmissionChargedBytes,
          after: after.encodedDirectoryAdmissionChargedBytes,
          reads: after.rangeReads - before.rangeReads,
          hits: after.encodedDirectoryCacheHits - before.encodedDirectoryCacheHits,
        }),
      );
    }
    if (new URL(request.url).pathname === "/directory-scan") {
      const inputs = Schema.decodeUnknownSync(DirectoryScanInput)(await request.json());
      clearImmutableCache("namespaces");
      const reports = [];
      for (const cycle of [0, 1, 2]) {
        const before = cacheUsage();
        for (const directoryRange of inputs)
          await range(directoryRange.key, directoryRange.offset, directoryRange.length, true);
        const after = cacheUsage();
        reports[cycle] = {
          reads: after.rangeReads - before.rangeReads,
          encodedDirectoryCacheEntries: after.encodedDirectoryCacheEntries,
          encodedDirectoryAdmissionChargedBytes: after.encodedDirectoryAdmissionChargedBytes,
          encodedDirectoryCacheChargedBytes: after.encodedDirectoryCacheChargedBytes,
        };
      }
      return new Response(Schema.encodeSync(Schema.fromJsonString(DirectoryScanResult))(reports));
    }
    const input = Schema.decodeUnknownSync(RangeProbeInput)(await request.json());
    clearImmutableCache(input.key.slice(0, input.key.indexOf("/segments/")));
    if (input.preloadFrequency === true) {
      using segment = new Segment(
        encodeCanonicalDocuments([{ id: "a", text: "alpha", attributes: {} }]),
      );
      const bytes = segment.bytes();
      const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
      using directory = new Directory(bytes);
      using ranker = directory.ranker(
        Schema.encodeSync(Schema.fromJsonString(RankingInput))({
          text: "alpha",
          mode: "any",
          top_k: 1,
          dead: [],
          filters: [],
          statistics: { documents: 1, title_length: 0, body_length: 1, frequencies: { alpha: 1 } },
        }),
      );
      const block = header.terms.alpha?.blocks[0];
      if (block === undefined) throw new Error("Missing fixture posting");
      const start = 16 + new DataView(bytes.buffer).getUint32(8, true) + block.data.offset;
      addFrequencyPosting(
        ranker,
        input.key,
        "alpha",
        start,
        bytes.subarray(start, start + block.data.length),
      );
    }
    if (input.evictionRanges !== undefined) {
      await range(input.key, input.offset, input.length, true);
      for (const pressure of input.evictionRanges)
        await range(pressure.key, pressure.offset, pressure.length);
    }
    const decodedDirectoryBytes = await Effect.runPromise(
      Match.value(input.decodeDirectory).pipe(
        Match.when(true, () =>
          withDirectory(input.key, input.length, (directory) =>
            Effect.sync(() => directory.heap_bytes()),
          ).pipe(Effect.asSome),
        ),
        Match.orElse(() => Effect.succeedNone),
      ),
    );
    const before = cacheUsage();
    const results = await Promise.allSettled(
      Array.from({ length: input.count }, () =>
        range(input.key, input.offset, input.length, input.evictionRanges !== undefined),
      ),
    );
    const after = cacheUsage();
    const successes = results.filter((result) => result.status === "fulfilled");
    const first = successes.at(0);
    return new Response(
      Schema.encodeSync(Schema.fromJsonString(RangeProbeResult))({
        postingBefore: before.postingCacheBytes,
        rangeBefore: before.rangeCacheBytes,
        rangeChargedAfter: after.rangeCacheChargedBytes,
        decodedDirectoryBytes: Option.getOrUndefined(decodedDirectoryBytes),
        directoryCacheChargedBytes: after.directoryCacheChargedBytes,
        encodedDirectoryCacheChargedBytes: after.encodedDirectoryCacheChargedBytes,
        postingAfter: after.postingCacheBytes,
        rangeAfter: after.rangeCacheBytes,
        reads: after.rangeReads - before.rangeReads,
        bytes: after.rangeBytes - before.rangeBytes,
        successes: successes.length,
        failures: results.length - successes.length,
        distinctBodies: new Set(successes.map((result) => result.value)).size,
        matchingContents: successes.every((result) => {
          if (first === undefined) return false;
          if (result.value === first.value) return true;
          return (
            result.value.byteLength === first.value.byteLength &&
            result.value.every((byte, index) => byte === first.value[index])
          );
        }),
        lengths: successes.map((result) => result.value.byteLength),
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
