import { sha256Bytes } from "../hash";
import { listNamespaces, namespaceCatalogPrefix, namespaceCatalogReadyKey } from "../namespaces";
import { TextExecutions } from "../text-executions";
import {
  captureReaderLease,
  finishStrongRead,
  ownedRead,
  rejectExpiredReader,
  strongQueryFailure,
} from "./read-lease";
import {
  decodeRoot,
  encodeRoot,
  decodeRootEffect,
  encodeVectorRebuildSnapshot,
  decodeVectorRebuildSnapshot,
  decodeRootForMigration,
  decodeVectorRebuildSnapshotForMigration,
} from "../manifest";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  Match,
  Option,
  Schema,
  Schedule,
  Semaphore,
} from "effect";
import {
  initSync,
  pack,
  unpack,
  tokenize,
  segment_document_terms,
  segment_migrate,
  segment_header,
  segment_term_bounds,
  segment_term_bounds_compact,
  segment_term_bounds_compact_minimum,
  EligibilityQuery,
  VectorRanker,
  PreparedQuery,
  directory_compress,
} from "../../dist/wasm/raio_engine";
import type { Snapshot, TextPlan, NativeVectorLocation } from "../protocol";
import {
  compareFieldNames,
  Filter,
  DEFAULT_VECTOR_DIMENSIONS,
  CanonicalDocument,
  nativeToCanonicalDocument,
  ErrorBody,
  Log,
  Metadata,
  CacheWarmHintResult,
  Health,
  NamespaceName,
  Operation,
  Query,
  QueryResult,
  RpcCommand,
  NamespaceCommand,
  type RpcValue,
  RpcReply,
  RebuildResult,
  Receipt,
  Rejected,
  Root,
  type LegacyPackedRoot,
  type ConvertedInlineRoot,
  SegmentHeader,
  type LegacyInlineRoot,
  CommonTerms,
  TermSummaries,
  CommonTermProjection,
  CompactTermBounds,
  CompactMinimumTermBounds,
  EligibleMinimum,
  EligibilityProjection,
  CommonLeaders,
  ConstantAttributes,
  SnapshotCacheHeaders,
  SegmentDocument,
  SegmentHits,
  PostingSpans,
  TermCatalog,
  TermCatalogBatch,
  TermFilters,
  TermFilterHeader,
  CatalogTelemetry,
  LocatedDocument,
  RankingInput,
  SearchStatistics,
  TextPlanIdentity,
  SharedTextPlan,
  SharedTextPlanCacheHeaders,
  Write,
  WriteResult,
  VectorMessage,
  VectorSyncResult,
  NamespaceSchema,
  namespaceColumnsFromNative,
  nativeSchemaFromColumns,
  filterableNames,
  vectorFilterNames,
  resolvedVectorDimensions,
  TextTerms,
  NativeVectorHits,
  NativeVectorPage,
  type VectorRebuild,
  VectorRebuildCheckpointMetadata,
  VECTOR_REBUILD_CHECKPOINT_BYTES,
  RootMigrationResult,
  VectorRebuildResult,
  NamespacePage,
  NamespaceCatalogActivation,
  NamespaceRpcCommand,
  NamespacesQuery,
  Collection,
  CollectionCursor,
  CollectionResult,
  Retirement,
  IndexMessage,
  SegmentRange,
  DirectoryCacheMiss,
  TermProjectionProps,
  SegmentCacheProps,
} from "../protocol";

import { snapshotFrameHeader, readSnapshotFrame } from "../snapshot";

import type { Storage } from "./storage";
import { RuntimeEntry } from "../platform";
import type {
  CachePort,
  BackgroundContext,
  Environment,
  SearchRuntime,
  ObjectBody,
  ObjectListOptions,
  ObjectCondition,
  JobBatch,
} from "../platform";
import type { ObjectVersion } from "../protocol";
type ObjectVersionType = typeof ObjectVersion.Type;

function excludesPhrase(
  dictionary: typeof TermSummaries.Type,
  occurrences: ReadonlyMap<string, number>,
) {
  for (const [term, required] of occurrences) {
    if (required < 2 || !Object.hasOwn(dictionary, term)) continue;
    const summary = dictionary[term];
    if (
      summary !== undefined &&
      summary.bounds.length > 0 &&
      summary.bounds.every(([title, body]) => title + body < required)
    )
      return true;
  }
  return false;
}

function queryRangeSignal(outer: AbortSignal | undefined, fiber: AbortSignal) {
  if (outer === undefined) return fiber;
  return AbortSignal.any([outer, fiber]);
}

function runQueryEffect<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const options: { value: { readonly signal: AbortSignal } | undefined } = { value: undefined };
  if (signal !== undefined) options.value = { signal };
  return Effect.runPromise(effect, options.value);
}

export function createApplication(runtime: SearchRuntime, searchStorage: Storage) {
  const workerEnv = runtime.env;
  const caches = runtime.cache;
  const warming = new Set<string>();
  const {
    range,
    publishQueryCache,
    acquireDirectoryFrame,
    readSegmentCache,
    waitDirectoryFrame,
    publishDirectoryFrame,
    withDirectory,
    readTermCatalogs,
    addFrequencyPosting,
    readTermProjections,
    buildSegment,
    rebuildEligibility,
    rebuildCommonProjection,
    storeSegmentCaches,
    warmTermBatch,
    bloom,
    bloomCandidates,
    appendBloomSegment,
    packBloomRoot,
    pruneBloomPacks,
    readDocument,
    readDocumentHits,
    sha256,
    clearImmutableCache,
    cacheUsage,
    segmentScoreBound,
    rememberSegmentScoreBound,
    textPlan,
    rememberTextPlan,
  } = searchStorage;
  const wasm = initSync({ module: runtime.engineModule });
  const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const SEGMENT_RETIREMENT_MS = 24 * 60 * 60 * 1000;

  class Segments extends RuntimeEntry<Environment, typeof SegmentCacheProps.Type> {
    override async fetch(request: Request) {
      const url = new URL(request.url);
      const props = Schema.decodeExit(SegmentCacheProps)(this.ctx.props);
      const directoryMiss = Schema.decodeUnknownExit(Schema.NullOr(DirectoryCacheMiss))(
        request.headers.get("x-kannin-directory-miss"),
      );
      const decoded = Schema.decodeUnknownExit(SegmentRange)({
        key: url.searchParams.get("key"),
        offset: Number(url.searchParams.get("offset")),
        length: Number(url.searchParams.get("length")),
      });
      if (
        decoded._tag === "Failure" ||
        directoryMiss._tag === "Failure" ||
        (directoryMiss.value !== null && url.pathname !== "/directory-v5") ||
        request.method !== "GET" ||
        props._tag === "Failure" ||
        props.value.bucket !== this.env.STORAGE_CACHE_SCOPE ||
        (url.pathname !== "/range" && url.pathname !== "/directory-v5") ||
        (url.pathname === "/directory-v5" && decoded.value.offset !== 0)
      )
        return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
      const input = decoded.value;
      const selected = await Effect.runPromise(readSegmentCache(url, props.value), {
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      const cacheKey = selected.key;
      const cache = selected.cache;
      if (selected.response !== undefined) {
        const response = new Response(selected.response.body, selected.response);
        response.headers.delete("cf-cache-status");
        response.headers.set("x-raio-cache", "api-hit");
        return response;
      }
      const storage = this.env.STORAGE;
      const context = this.ctx;
      const pending = Effect.runPromise(
        ownedRead((originSignal) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const canonical = Effect.acquireUseRelease(
                Effect.tryPromise(() =>
                  storage.get(input.key, {
                    range: { offset: input.offset, length: input.length },
                    signal: originSignal,
                  }),
                ),
                (object) =>
                  Effect.gen(function* () {
                    if (object === null)
                      return new Response(null, {
                        status: 404,
                        headers: { "cache-control": "no-store" },
                      });
                    const bytes = yield* Effect.tryPromise(() => object.arrayBuffer()).pipe(
                      Effect.uninterruptible,
                    );
                    originSignal.throwIfAborted();
                    if (bytes.byteLength !== input.length)
                      return new Response(null, {
                        status: 503,
                        headers: { "cache-control": "no-store" },
                      });
                    const encoded = yield* Effect.try(() =>
                      Match.value(url.pathname).pipe(
                        Match.when("/directory-v5", () =>
                          directory_compress(new Uint8Array(bytes)).slice(),
                        ),
                        Match.orElse(() => bytes),
                      ),
                    );
                    if (url.pathname === "/directory-v5")
                      publishDirectoryFrame(
                        input.key,
                        input.length,
                        new Uint8Array(encoded),
                        context,
                      );
                    return new Response(encoded, {
                      headers: {
                        "content-type": "application/octet-stream",
                        "cache-control": "public, max-age=31536000, immutable",
                        "content-length": String(encoded.byteLength),
                        etag: object.httpEtag,
                      },
                    });
                  }),
                (object) => {
                  if (object === null || object.bodyUsed) return Effect.void;
                  return Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore);
                },
              );
              if (url.pathname !== "/directory-v5" || directoryMiss.value !== null)
                return yield* canonical;
              const reader = yield* acquireDirectoryFrame(input.key, input.length);
              const observed = yield* waitDirectoryFrame(reader);
              const cached = Fiber.join(reader).pipe(
                Effect.map(
                  Option.map(
                    (bytes) =>
                      new Response(new Uint8Array(bytes), {
                        headers: {
                          "content-type": "application/octet-stream",
                          "cache-control": "public, max-age=31536000, immutable",
                          "content-length": String(bytes.byteLength),
                          "x-raio-cache": "r2-directory-hit",
                        },
                      }),
                  ),
                ),
              );
              if (Option.isSome(observed)) {
                const result = yield* cached;
                if (Option.isSome(result)) return result.value;
                return yield* canonical;
              }
              return yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const fallback = yield* Effect.forkDetach(restore(canonical));
                  context.waitUntil(
                    new Promise<void>((resolve) => fallback.addObserver(() => resolve())),
                  );
                  return yield* restore(
                    Effect.race(
                      Fiber.join(fallback),
                      cached.pipe(
                        Effect.flatMap(
                          Option.match({
                            onSome: Effect.succeed,
                            onNone: () => Fiber.join(fallback),
                          }),
                        ),
                      ),
                    ),
                  ).pipe(
                    Effect.ensuring(
                      Effect.gen(function* () {
                        const stopped = yield* Effect.forkDetach(
                          Fiber.interruptAll([reader, fallback]),
                        );
                        context.waitUntil(
                          new Promise<void>((resolve) => stopped.addObserver(() => resolve())),
                        );
                      }),
                    ),
                  );
                }),
              );
            }),
            { signal: originSignal },
          ),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              new Rejected({
                status: 503,
                message: "Immutable cache fill exceeded its read budget",
              }),
          }),
        ),
      );
      context.waitUntil(
        pending.then(async (response) => {
          if (cache !== undefined && response.ok)
            await Effect.runPromise(
              Effect.tryPromise(() => cache.put(cacheKey, response.clone())).pipe(
                Effect.timeoutOption("5 seconds"),
                Effect.ignore,
              ),
            );
        }),
      );
      return pending;
    }
  }
  const decodeLog = Schema.decodeSync(Schema.fromJsonString(Log));
  const encodeLog = Schema.encodeSync(Schema.fromJsonString(Log));
  const decodeQuery = Schema.decodeEffect(Schema.fromJsonString(Query), {
    onExcessProperty: "error",
  });
  const encodeQueryResult = Schema.encodeSync(QueryResult);
  const decodePostingSpans = Schema.decodeEffect(Schema.fromJsonString(PostingSpans));
  const decodeSegmentHits = Schema.decodeEffect(Schema.fromJsonString(SegmentHits));
  const encodeRankingInput = Schema.encodeSync(Schema.fromJsonString(RankingInput));
  const encodeConstantAttributes = Schema.encodeSync(Schema.fromJsonString(ConstantAttributes));
  const encodeCompactBoundIdentity = Schema.encodeSync(
    Schema.fromJsonString(
      Schema.Tuple([
        CommonTermProjection.fields.terms,
        CompactTermBounds.value.elements[1],
        EligibleMinimum,
      ]),
    ),
  );
  const isNamespaceName = Schema.is(NamespaceName);
  const isOperation = Schema.is(Operation);
  const encodeCatalogTelemetry = Schema.encodeEffect(Schema.fromJsonString(CatalogTelemetry));

  class Terms extends RuntimeEntry<Environment, typeof TermProjectionProps.Encoded> {
    override async fetch(request: Request) {
      const entryStarted = Effect.runSync(Clock.currentTimeNanos);
      const props = Schema.decodeExit(TermProjectionProps)(this.ctx.props);
      const url = new URL(request.url);
      if (
        request.method !== "GET" ||
        props._tag === "Failure" ||
        url.pathname !== "/catalog-v12" ||
        props.value.bucket !== this.env.STORAGE_CACHE_SCOPE
      )
        return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
      const filters = {
        value: Schema.decodeUnknownExit(TermFilterHeader)(request.headers.get("x-kannin-filters")),
      };
      if (props.value.selection.kind === "filters")
        filters.value = Exit.succeed(props.value.selection.filters);
      if (filters.value._tag === "Failure")
        return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
      const actual = filters.value.value;
      const fields = [...new Set(actual.map((filter) => filter.field))].toSorted(compareFieldNames);
      const selection = props.value.selection;
      const prefixes = props.value.prefixes;
      if (
        prefixes !== undefined &&
        (actual.length > 0 || prefixes.length !== props.value.ranges.length)
      )
        return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
      if (
        selection.kind === "fields" &&
        (fields.length !== selection.fields.length ||
          fields.some((field, index) => field !== selection.fields[index]))
      )
        return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
      const encodedFilters = Schema.encodeSync(TermFilters)(actual);
      return Effect.runPromise(
        readTermProjections(
          props.value.ranges,
          props.value.terms,
          actual,
          prefixes,
          this.ctx,
          request.signal,
        ).pipe(
          Effect.flatMap(({ catalogs, telemetry, rootFallback }) =>
            Effect.gen(function* () {
              const entryEnded = yield* Clock.currentTimeNanos;
              const hasMinimum = catalogs.some((catalog) => catalog.eligibility === null);
              const filterDigest = { value: Option.none<string>() };
              if (hasMinimum)
                filterDigest.value = yield* Effect.tryPromise(() => sha256(encodedFilters)).pipe(
                  Effect.asSome,
                );
              const wire = catalogs.map((catalog) => {
                const projection = {
                  dictionary: catalog.dictionary,
                  partitions: catalog.partitions,
                };
                if (catalog.eligibility === null)
                  return {
                    ...projection,
                    selection: { kind: "minimum" as const, minimum: catalog.minimum },
                  };
                return {
                  ...projection,
                  selection: { kind: "model" as const, eligibility: catalog.eligibility },
                };
              });
              const cacheControl = { value: "public, max-age=31536000, immutable" };
              if (
                rootFallback ||
                (props.value.selection.kind === "fields" && actual.length > 0 && hasMinimum)
              )
                cacheControl.value = "no-store";
              return yield* Effect.all([
                Schema.encodeEffect(TermCatalogBatch)({
                  catalogs: wire,
                  filterDigest: Option.getOrNull(filterDigest.value),
                  rootFallback,
                }),
                encodeCatalogTelemetry({
                  ...telemetry,
                  entryMs: Number(entryEnded - entryStarted) / 1e6,
                }),
                Effect.succeed(cacheControl.value),
              ]);
            }),
          ),
          Effect.map(([dictionary, telemetry, cacheControl]) => {
            const headers = new Headers({
              "cache-control": cacheControl,
              "x-raio-cache": "terms-origin",
              "x-kannin-catalog-telemetry": telemetry,
            });
            if (cacheControl === "no-store") headers.set("vary", "x-kannin-filters");
            return Response.json(dictionary, { headers });
          }),
          Effect.tapError((error) =>
            Effect.logError("kannin.termProjection", { ranges: props.value.ranges, error }),
          ),
          Effect.orElseSucceed(() =>
            Response.json(
              Schema.encodeSync(ErrorBody)({
                status: "error",
                error: "Immutable term catalog unavailable",
              }),
              { status: 503, headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      );
    }
  }

  const strings = Schema.fromJsonString(Schema.Array(Schema.String));
  const integers = Schema.fromJsonString(Schema.Array(Schema.Int));
  const Located = LocatedDocument.mapFields((fields) => ({
    ...fields,
    segment: Root.fields.segments.value,
  }));

  const readBody = Effect.fn("raio.readBody")(function* (
    request: Pick<Request, "headers" | "body">,
  ) {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
      return yield* new Rejected({ status: 415, message: "Expected application/json" });
    if (request.body === null) return yield* new Rejected({ status: 400, message: "Missing body" });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    const count = { bytes: 0 };
    while (true) {
      const chunk = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (cause) => {
          if (Schema.is(Rejected)(cause)) return cause;
          return new Cause.UnknownError(cause);
        },
      });
      if (chunk.done) break;
      const value = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(chunk.value);
      count.bytes += value.byteLength;
      if (count.bytes > 1_900_000) {
        yield* Effect.tryPromise({
          try: () => reader.cancel(),
          catch: (cause) => {
            if (Schema.is(Rejected)(cause)) return cause;
            return new Cause.UnknownError(cause);
          },
        });
        return yield* new Rejected({ status: 413, message: "JSON body exceeds 1900000 bytes" });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(count.bytes);
    const cursor = { offset: 0 };
    for (const chunk of chunks) {
      bytes.set(chunk, cursor.offset);
      cursor.offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  });

  async function locate(
    ids: ReadonlyArray<string>,
    root: typeof Root.Type,
    preferR2: boolean = false,
  ) {
    const found = new Map<string, typeof Located.Type>();
    for (const offset of Array.from(
      { length: Math.ceil(root.segments.length / 64) },
      (_, index) => (Math.ceil(root.segments.length / 64) - index - 1) * 64,
    )) {
      const segments = root.segments.slice(offset, offset + 64).toReversed();
      const remaining = ids.filter((id) => !found.has(id));
      if (remaining.length === 0) break;
      const matches = (
        await Effect.runPromise(bloomCandidates(root, remaining, "document", offset, 64))
      ).toReversed();
      for (const [index, segment] of segments.entries()) {
        const selected = matches[index];
        if (selected === undefined)
          throw new Rejected({ status: 503, message: "Bloom batch omitted a segment" });
        const candidates = selected.filter((id) => !found.has(id));
        if (candidates.length === 0) continue;
        const rows = await Effect.runPromise(
          withDirectory(
            segment.key,
            segment.headerBytes,
            (decoded) =>
              Effect.gen(function* () {
                const lookup = yield* Schema.encodeEffect(strings)(candidates);
                const dead = yield* Schema.encodeEffect(integers)(segment.dead);
                return yield* Schema.decodeEffect(
                  Schema.fromJsonString(Schema.Array(LocatedDocument)),
                )(decoded.lookup(lookup, dead));
              }),
            undefined,
            false,
            preferR2,
            undefined,
            true,
          ),
        );
        for (const row of rows) found.set(row.document.id, { ...row, segment });
        if (found.size === ids.length) break;
      }
    }
    return found;
  }

  async function vectorId(epoch: string, id: string, sequence: number) {
    return sha256(`${epoch}\0${id}\0${sequence}`);
  }

  const SHARED_PLAN_READ_BUDGET = 250_000_000n;
  const SHARED_PLAN_BODY_UNIT = 64 * 1024;
  const sharedPlanBodies = Semaphore.makeUnsafe(64);
  const readSharedTextPlan = Effect.fn("raio.readSharedTextPlan")(function* (cacheKey: string) {
    const started = yield* Clock.currentTimeNanos;
    const cache = yield* Effect.tryPromise(() => caches.open("kannin-text-plans-v1")).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const result = { cache, plan: Option.none<typeof SharedTextPlan.Type>(), expired: false };
    if (cache === undefined) return result;
    if ((yield* Clock.currentTimeNanos) - started >= SHARED_PLAN_READ_BUDGET) {
      result.expired = true;
      return result;
    }
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise(() => cache.match(cacheKey)).pipe(Effect.orElseSucceed(() => undefined)),
      (cached) =>
        Effect.gen(function* () {
          if (cached === undefined) return result;
          if ((yield* Clock.currentTimeNanos) - started >= SHARED_PLAN_READ_BUDGET) {
            result.expired = true;
            return result;
          }
          const metadata = yield* Schema.decodeUnknownEffect(SharedTextPlanCacheHeaders)({
            "content-length": cached.headers.get("content-length"),
            "x-kannin-plan-bytes": cached.headers.get("x-kannin-plan-bytes"),
          }).pipe(Effect.option);
          if (Option.isNone(metadata)) return result;
          const length = metadata.value["content-length"];
          const decodedLength = metadata.value["x-kannin-plan-bytes"];
          const units = Math.ceil(Math.max(length, decodedLength * 4) / SHARED_PLAN_BODY_UNIT);
          const acquired = yield* sharedPlanBodies
            .withPermitsIfAvailable(units)(
              Effect.gen(function* () {
                if ((yield* Clock.currentTimeNanos) - started >= SHARED_PLAN_READ_BUDGET) {
                  result.expired = true;
                  return result;
                }
                const buffer = yield* Effect.tryPromise(() => cached.arrayBuffer());
                if ((yield* Clock.currentTimeNanos) - started >= SHARED_PLAN_READ_BUDGET) {
                  result.expired = true;
                  return result;
                }
                result.plan = yield* Effect.try(() => {
                  if (
                    buffer.byteLength !== length ||
                    buffer.byteLength < 16 ||
                    new DataView(buffer).getUint32(8, true) !== decodedLength
                  )
                    return undefined;
                  return unpack(new Uint8Array(buffer));
                }).pipe(
                  Effect.flatMap((encoded) => {
                    if (encoded === undefined || encoded.length > 1024 * 1024)
                      return Effect.succeed(Option.none<typeof SharedTextPlan.Type>());
                    return Schema.decodeEffect(Schema.fromJsonString(SharedTextPlan))(encoded).pipe(
                      Effect.asSome,
                    );
                  }),
                  Effect.orElseSucceed(() => Option.none()),
                );
                return result;
              }),
            )
            .pipe(
              Effect.repeat({
                while: Option.isNone,
                schedule: Schedule.exponential("1 millis").pipe(
                  Schedule.upTo({ duration: SHARED_PLAN_READ_BUDGET }),
                ),
              }),
            );
          if (Option.isNone(acquired)) {
            result.expired = true;
            return result;
          }
          return acquired.value;
        }),
      (cached) => {
        if (cached === undefined || cached.bodyUsed) return Effect.void;
        const body = cached.body;
        if (body === null) return Effect.void;
        return Effect.tryPromise(() => body.cancel()).pipe(Effect.ignore);
      },
    );
  });
  const pendingSharedTextPlans = new Map<
    string,
    Promise<
      Exit.Exit<
        Option.Option<Effect.Success<ReturnType<typeof readSharedTextPlan>>>,
        Cause.UnknownError
      >
    >
  >();

  async function acquireSharedTextPlan(cacheKey: URL, ctx: BackgroundContext, timings: Headers) {
    const identity = cacheKey.href;
    const selected = { completion: pendingSharedTextPlans.get(identity) };
    if (selected.completion === undefined) {
      if (pendingSharedTextPlans.size >= 16) {
        timings.append("server-timing", "text_plan_cache_admission");
        return undefined;
      }
      const source = Effect.runPromise(readSharedTextPlan(identity));
      const completion = Effect.runPromiseExit(
        Effect.tryPromise(() => source).pipe(Effect.timeoutOption(SHARED_PLAN_READ_BUDGET)),
      );
      selected.completion = completion;
      pendingSharedTextPlans.set(identity, completion);
      ctx.waitUntil(
        source
          .finally(() => {
            if (pendingSharedTextPlans.get(identity) === completion)
              pendingSharedTextPlans.delete(identity);
          })
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    } else timings.append("server-timing", "text_plan_cache_shared");
    const completed = await selected.completion;
    if (completed._tag === "Failure") {
      timings.append("server-timing", "text_plan_cache_unavailable");
      return undefined;
    }
    if (Option.isNone(completed.value)) {
      timings.append("server-timing", "text_plan_cache_timeout");
      return undefined;
    }
    const acquired = completed.value.value;
    if (acquired.expired) timings.append("server-timing", "text_plan_cache_timeout");
    return acquired;
  }

  const rootEligibilityMinimums = new WeakMap<
    typeof EligibilityProjection.Type,
    ReadonlyMap<string, typeof EligibleMinimum.Type>
  >();

  function rootEligibilityMinimum(
    model: typeof EligibilityProjection.Type,
    filters: (typeof Query.Type)["filters"],
  ) {
    const encodedFilters = Schema.encodeSync(TermFilters)(filters);
    const retained = rootEligibilityMinimums.get(model)?.get(encodedFilters);
    if (retained !== undefined) return retained;
    using modelQuery = new EligibilityQuery(encodedFilters);
    const minimum = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(
      modelQuery.minimum(Schema.encodeSync(Schema.fromJsonString(EligibilityProjection))(model)),
    );
    if (encodedFilters.length <= 512)
      rootEligibilityMinimums.set(model, new Map([[encodedFilters, minimum]]));
    return minimum;
  }

  async function rankText(
    input: typeof Query.Type,
    root: typeof Root.Type,
    timings: Headers,
    ctx: BackgroundContext,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const started = Effect.runSync(Clock.currentTimeNanos);
    if (input.kind === "vector") return [];
    timings.append("server-timing", 'text_phase;desc="catalog"');
    const words = tokenize(input.text).split(" ").filter(Boolean);
    const terms = [...new Set(words)];
    if (!Schema.is(TextTerms)(terms))
      throw new Rejected({ status: 400, message: "Query exceeds 512 normalized terms" });
    if (input.match === "phrase" && words.length > 64)
      throw new Rejected({ status: 400, message: "Phrase exceeds 64 normalized tokens" });
    if (terms.length === 0 || root.documents === 0) return [];
    const phraseOccurrences = new Map<string, number>();
    if (input.match === "phrase" && words.length > terms.length) {
      for (const word of words) phraseOccurrences.set(word, (phraseOccurrences.get(word) ?? 0) + 1);
      if (
        root.segments.length > 0 &&
        root.segments.every((segment) => {
          const dictionary = segment.commonTerms;
          if (dictionary === undefined) return false;
          return excludesPhrase(dictionary, phraseOccurrences);
        })
      ) {
        timings.append("server-timing", 'text_phrase_frequency;desc="manifest"');
        timings.append("server-timing", 'text_score;dur=0;desc="segments=0"');
        return [];
      }
    }
    const covered = root.segments.every((segment) => {
      const dictionary = segment.commonTerms;
      if (dictionary === undefined) return false;
      return terms.every((term) => Object.hasOwn(dictionary, term));
    });
    const bloomMatches = await runQueryEffect(
      Match.value(covered).pipe(
        Match.when(true, () => {
          timings.append("server-timing", 'text_membership;desc="manifest"');
          return Effect.succeed(root.segments.map(() => terms));
        }),
        Match.orElse(() => bloomCandidates(root, terms, "term")),
      ),
      signal,
    );
    const unrestricted = new Map<string, string>();
    if (input.filters.length > 0) {
      const encodedFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(
        input.filters,
      );
      using constantQuery = new EligibilityQuery(encodedFilters);
      for (const [index, segment] of root.segments.entries()) {
        const requested = bloomMatches[index];
        if (requested === undefined || requested.length === 0) continue;
        const attributes = segment.constantAttributes;
        if (
          attributes === undefined ||
          !input.filters.every((filter) => Object.hasOwn(attributes, filter.field))
        )
          continue;
        const encoded = encodeConstantAttributes(
          Object.fromEntries(
            Object.entries(attributes).filter(([field]) =>
              input.filters.some((filter) => filter.field === field),
            ),
          ),
        );
        if (constantQuery.matches(encoded)) unrestricted.set(segment.key, encoded);
      }
    }
    const localRanking =
      covered &&
      (input.match !== "phrase" || words.length === 1) &&
      root.segments.every((segment) => {
        const leaders = segment.commonLeaders;
        if (input.filters.length > 0 && !unrestricted.has(segment.key)) return false;
        if (segment.dead.length !== 0 || leaders === undefined) return false;
        return leaders.some(
          (leader) =>
            leader.documents.length >= Math.min(input.topK, segment.count) &&
            terms.every((term) => leader.terms.includes(term)),
        );
      });
    const candidates = root.segments.map((segment, index) => {
      const selected = bloomMatches[index];
      if (selected === undefined)
        throw new Rejected({ status: 503, message: "Bloom batch omitted a segment" });
      return { segment, terms: selected };
    });
    if (
      (input.match === "all" || input.match === "phrase") &&
      !candidates.some((candidate) => candidate.terms.length === terms.length)
    )
      return [];
    const selections = candidates.filter((candidate) => candidate.terms.length > 0);
    if (selections.length === 0) return [];
    const selected = selections.map((candidate) => candidate.segment);
    const correlatedPhrase =
      input.match === "phrase" &&
      !localRanking &&
      selected.length > 1 &&
      input.filters.length === 0;
    const rootCorrelated =
      correlatedPhrase &&
      selections.every(({ segment, terms: requested }) => {
        const projection = segment.commonProjection;
        const dictionary = segment.commonTerms;
        return (
          projection !== undefined &&
          projection !== null &&
          dictionary !== undefined &&
          requested.every(
            (term) => Object.hasOwn(dictionary, term) && projection.terms.includes(term),
          )
        );
      });
    const filterFields = [...new Set(input.filters.map((filter) => filter.field))].toSorted(
      compareFieldNames,
    );
    const rootFiltered =
      input.filters.length > 0 &&
      selections.every(({ segment, terms: requested }) => {
        const model = segment.eligibility;
        const projection = segment.commonProjection;
        const dictionary = segment.commonTerms;
        return (
          model !== undefined &&
          model !== null &&
          filterFields.every((field) => model.fields.includes(field)) &&
          projection !== undefined &&
          projection !== null &&
          dictionary !== undefined &&
          requested.every(
            (term) => Object.hasOwn(dictionary, term) && projection.terms.includes(term),
          )
        );
      });
    const rootMinimums = new Map<string, typeof EligibleMinimum.Type>();
    const rootBounded = rootCorrelated || rootFiltered;
    const sharedEligibility = selections[0]?.segment.eligibility;
    if (
      rootFiltered &&
      sharedEligibility !== undefined &&
      sharedEligibility !== null &&
      selections.every(({ segment }) => segment.eligibility === sharedEligibility)
    ) {
      const minimum = rootEligibilityMinimum(sharedEligibility, input.filters);
      if (minimum === null) {
        timings.append("server-timing", 'text_root_eligibility;desc="early-none"');
        timings.append("server-timing", 'text_score;dur=0;desc="segments=0"');
        return [];
      }
      for (const { segment } of selections) rootMinimums.set(segment.key, minimum);
    }
    const identityText = Match.value(input.match).pipe(
      Match.when("phrase", () => words.join(" ")),
      Match.orElse(() =>
        [...new Set(selections.flatMap((candidate) => candidate.terms))].toSorted().join(" "),
      ),
    );
    const reuse = { plan: "bypass", bounds: 0 };
    const shared: { cache: CachePort | undefined; key: URL | undefined } = {
      cache: undefined,
      key: undefined,
    };
    const planning: { key: string | undefined; value: typeof TextPlan.Type | undefined } = {
      key: undefined,
      value: undefined,
    };
    const firstSelected = selected[0];
    if (selected.length > 4 && firstSelected !== undefined) {
      const identity = Schema.encodeSync(Schema.fromJsonString(TextPlanIdentity))({
        correlatedRoot: rootBounded,
        text: identityText,
        mode: input.match ?? "any",
        filters: input.filters,
        documents: root.documents,
        titleLength: root.titleLength,
        bodyLength: root.bodyLength,
        segments: selected,
      });
      planning.key = `${workerEnv.STORAGE_CACHE_SCOPE}:${firstSelected.key}/plan:${await sha256(identity)}`;
      planning.value = textPlan(planning.key);
      if (!localRanking) {
        shared.key = new URL("https://raio-cache.internal/text-plans-v1");
        shared.key.searchParams.set("identity", planning.key);
        shared.key.searchParams.set("version", runtime.version);
      }
      reuse.plan = "memory";
      if (planning.value === undefined) reuse.plan = "miss";
      if (planning.value === undefined && shared.key !== undefined) {
        const acquired = await acquireSharedTextPlan(shared.key, ctx, timings);
        if (acquired !== undefined) {
          shared.cache = acquired.cache;
          const decoded = acquired.plan;
          if (
            Option.isSome(decoded) &&
            decoded.value.identity === planning.key &&
            decoded.value.version === runtime.version &&
            decoded.value.plan.segments.length === selected.length &&
            decoded.value.plan.statistics.documents === root.documents &&
            decoded.value.plan.statistics.title_length === root.titleLength &&
            decoded.value.plan.statistics.body_length === root.bodyLength
          ) {
            planning.value = decoded.value.plan;
            rememberTextPlan(planning.key, decoded.value.plan);
            reuse.plan = "shared";
          }
        }
      }
    }
    if (planning.value === undefined) {
      if (rootFiltered && rootMinimums.size !== selected.length) {
        const encodedFilters = Schema.encodeSync(TermFilters)(input.filters);
        const modelMinimums = new Map<
          typeof EligibilityProjection.Type,
          typeof EligibleMinimum.Type
        >();
        const minimums = Effect.runSync(
          Effect.acquireUseRelease(
            Effect.sync(() => new EligibilityQuery(encodedFilters)),
            (modelQuery) =>
              Effect.sync(() =>
                selections.map(({ segment }) => {
                  const model = segment.eligibility;
                  if (model === undefined || model === null)
                    throw new Rejected({ status: 503, message: "Missing Root eligibility model" });
                  const retained = modelMinimums.get(model);
                  if (retained !== undefined) return [segment.key, retained] as const;
                  const minimum = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(
                    modelQuery.minimum(
                      Schema.encodeSync(Schema.fromJsonString(EligibilityProjection))(model),
                    ),
                  );
                  modelMinimums.set(model, minimum);
                  return [segment.key, minimum] as const;
                }),
              ),
            (modelQuery) => Effect.sync(() => modelQuery.free()),
          ),
        );
        for (const [key, minimum] of minimums) rootMinimums.set(key, minimum);
      }
      const common = selections.flatMap(({ segment, terms: requested }) => {
        if (
          (input.filters.length > 0 && !rootFiltered && !unrestricted.has(segment.key)) ||
          segment.commonTerms === undefined
        )
          return [];
        const saved = segment.commonTerms;
        const projection = segment.commonProjection;
        const dictionary = Object.fromEntries(
          requested.flatMap((term) => {
            if (!Object.hasOwn(saved, term)) return [];
            const summary = saved[term];
            if (summary === undefined) return [];
            if (rootBounded && projection !== undefined && projection !== null) {
              const bounds = projection.independent[projection.terms.indexOf(term)];
              if (bounds === undefined) return [];
              return [[term, { df: summary.df, bounds }] as const];
            }
            return [[term, summary] as const];
          }),
        );
        if (Object.keys(dictionary).length !== requested.length) return [];
        const minimum = rootMinimums.get(segment.key);
        if (minimum !== undefined) return [{ dictionary, minimum, partitions: null }];
        return [{ dictionary, minimum: [0, 0] as const, partitions: null }];
      });
      const rootPrefixes = Match.value(
        correlatedPhrase &&
          !rootCorrelated &&
          common.length === selected.length &&
          common.every((projection) =>
            terms.every((term) => Object.hasOwn(projection.dictionary, term)),
          ),
      ).pipe(
        Match.when(true, () => common.map((projection) => projection.dictionary)),
        Match.orElse(() => undefined),
      );
      const projections = await runQueryEffect(
        Match.value(common.length === selected.length && (!correlatedPhrase || rootBounded)).pipe(
          Match.when(true, () =>
            Effect.sync(() => {
              if (rootFiltered)
                timings.append("server-timing", 'catalog_root_eligibility;desc="hit"');
              else if (rootCorrelated)
                timings.append("server-timing", 'catalog_root_joint;desc="hit"');
              else timings.append("server-timing", 'catalog_root_prefix;desc="hit"');
              return common;
            }),
          ),
          Match.orElse(() =>
            readTermCatalogs(
              selected,
              selections.map((candidate) => candidate.terms),
              input.filters,
              timings,
              rootPrefixes,
              signal,
            ),
          ),
        ),
        signal,
      );
      const catalog = selected.map((segment, index) => {
        const projection = projections[index];
        if (projection === undefined)
          throw new Rejected({ status: 503, message: "Term projection batch omitted a segment" });
        return { segment, ...projection };
      });
      const frequencies = new Map<string, number>();
      for (const { segment, dictionary } of catalog) {
        for (const [term, metadata] of Object.entries(dictionary)) {
          const frequency = (frequencies.get(term) ?? 0) + metadata.df;
          if (Object.hasOwn(segment.removedFrequencies, term)) {
            frequencies.set(term, frequency - (segment.removedFrequencies[term] ?? 0));
            continue;
          }
          frequencies.set(term, frequency);
        }
      }
      const statistics = {
        documents: root.documents,
        title_length: root.titleLength,
        body_length: root.bodyLength,
        frequencies: Object.fromEntries(frequencies),
      };
      const encodedStatistics = Schema.encodeSync(Schema.fromJsonString(SearchStatistics))(
        statistics,
      );
      const segments = [];
      const compactResults = new Map<typeof CommonTermProjection.Type, Map<string, number>>();
      const compactReuse = { inputs: 0, unique: 0, batches: 0 };
      for (const offset of Array.from(
        { length: Math.ceil(catalog.length / 64) },
        (_, index) => index * 64,
      )) {
        const window = catalog.slice(offset, offset + 64);
        const values = Match.value(rootBounded).pipe(
          Match.when(true, () => {
            const compact: Array<(typeof CompactMinimumTermBounds.Type)[number]> = [];
            const pending = new Map<typeof CommonTermProjection.Type, Map<string, number>>();
            compactReuse.inputs += window.length;
            const references = window.map((entry) => {
              const projection = entry.segment.commonProjection;
              if (projection === undefined || projection === null)
                throw new Rejected({ status: 503, message: "Missing Root joint projection" });
              const selectedTerms = projection.terms.filter((term) =>
                Object.hasOwn(entry.dictionary, term),
              );
              const summaries = selectedTerms.map((term) => {
                const summary = entry.dictionary[term];
                if (summary === undefined)
                  throw new Rejected({ status: 503, message: "Missing Root joint term" });
                return summary;
              });
              const segmentFrequencies = summaries.map((summary) => summary.df);
              const key = encodeCompactBoundIdentity([
                selectedTerms,
                segmentFrequencies,
                entry.minimum,
              ]);
              const retained = compactResults.get(projection) ?? new Map<string, number>();
              compactResults.set(projection, retained);
              const bound = retained.get(key);
              if (bound !== undefined) return { retained, key, bound, index: undefined };
              const indexes = pending.get(projection) ?? new Map<string, number>();
              pending.set(projection, indexes);
              const queued = indexes.get(key);
              if (queued !== undefined) return { retained, key, bound: undefined, index: queued };
              const index = compact.length;
              indexes.set(key, index);
              if (selectedTerms.length === projection.terms.length) {
                compact.push([projection, segmentFrequencies, entry.minimum]);
                return { retained, key, bound: undefined, index };
              }
              const columns = selectedTerms.map((term) => projection.terms.indexOf(term));
              compact.push([
                {
                  terms: selectedTerms,
                  independent: columns.map((column) => {
                    const bounds = projection.independent[column];
                    if (bounds === undefined)
                      throw new Rejected({
                        status: 503,
                        message: "Missing Root independent column",
                      });
                    return bounds;
                  }),
                  partitions: projection.partitions.map((partition) =>
                    columns.map((column) => {
                      const cell = partition[column];
                      if (cell === undefined)
                        throw new Rejected({ status: 503, message: "Missing Root joint column" });
                      return cell;
                    }),
                  ),
                },
                segmentFrequencies,
                entry.minimum,
              ]);
              return { retained, key, bound: undefined, index };
            });
            const decoded: number[] = [];
            if (compact.length > 0) {
              compactReuse.unique += compact.length;
              compactReuse.batches += 1;
              const nativeBounds = Match.value(rootFiltered).pipe(
                Match.when(true, () =>
                  segment_term_bounds_compact_minimum(
                    encodedStatistics,
                    Schema.encodeSync(Schema.fromJsonString(CompactMinimumTermBounds))(compact),
                  ),
                ),
                Match.orElse(() =>
                  segment_term_bounds_compact(
                    encodedStatistics,
                    Schema.encodeSync(Schema.fromJsonString(CompactTermBounds), {
                      disableChecks: true,
                    })(
                      compact.map(
                        ([projection, physicalDfs]) => [projection, physicalDfs] as const,
                      ),
                    ),
                  ),
                ),
              );
              decoded.push(
                ...Schema.decodeSync(Schema.Array(Schema.Finite))(Array.from(nativeBounds)),
              );
              if (decoded.length !== compact.length)
                throw new Rejected({
                  status: 503,
                  message: "Term bound batch omitted a unique input",
                });
            }
            return references.map((reference) => {
              if (reference.bound !== undefined) return reference.bound;
              if (reference.index === undefined)
                throw new Rejected({ status: 503, message: "Missing compact bound reference" });
              const bound = decoded[reference.index];
              if (bound === undefined)
                throw new Rejected({ status: 503, message: "Missing compact bound output" });
              reference.retained.set(reference.key, bound);
              return bound;
            });
          }),
          Match.orElse(() =>
            segment_term_bounds(
              encodedStatistics,
              Schema.encodeSync(Schema.fromJsonString(Schema.Array(TermCatalog)))(
                window.map((entry) => ({
                  dictionary: entry.dictionary,
                  minimum: entry.minimum,
                  partitions: entry.partitions,
                })),
              ),
            ),
          ),
        );
        const bounds = Schema.decodeSync(Schema.Array(Schema.Finite))(Array.from(values));
        if (bounds.length !== window.length)
          throw new Rejected({ status: 503, message: "Term bound batch omitted a segment" });
        segments.push(
          ...window.map((entry, index) => {
            const bound = bounds[index];
            if (bound === undefined)
              throw new Rejected({ status: 503, message: "Term bound batch omitted a segment" });
            const liveCount = entry.segment.count - entry.segment.dead.length;
            if (liveCount < 0)
              throw new Rejected({ status: 503, message: "Invalid live segment cardinality" });
            const matches = { maximum: liveCount, union: 0, frequency: 0 };
            for (const term of terms) {
              matches.frequency = 0;
              if (Object.hasOwn(entry.dictionary, term))
                matches.frequency = entry.dictionary[term]?.df ?? 0;
              if (Object.hasOwn(entry.segment.removedFrequencies, term))
                matches.frequency -= entry.segment.removedFrequencies[term] ?? 0;
              if (matches.frequency < 0 || matches.frequency > liveCount)
                throw new Rejected({ status: 503, message: "Invalid live term cardinality" });
              matches.maximum = Math.min(matches.maximum, matches.frequency);
              matches.union += matches.frequency;
            }
            if (input.match !== "all" && input.match !== "phrase")
              matches.maximum = Math.min(liveCount, matches.union);
            if (excludesPhrase(entry.dictionary, phraseOccurrences)) matches.maximum = 0;
            if (entry.minimum === null) matches.maximum = 0;
            return {
              bound,
              minimumId: entry.segment.minimumId,
              eligible: matches.maximum > 0,
              maximumMatches: matches.maximum,
              singleton: Match.value(
                Object.values(entry.dictionary).some((summary) => summary.single !== undefined) &&
                  Object.values(entry.dictionary).every(
                    (summary) => summary.df === 1 && summary.single !== undefined,
                  ),
              ).pipe(
                Match.when(true, () => entry.dictionary),
                Match.orElse(() => undefined),
              ),
            };
          }),
        );
      }
      if (compactReuse.inputs > 0)
        timings.append(
          "server-timing",
          `text_bound_reuse;desc="inputs=${compactReuse.inputs} unique=${compactReuse.unique} batches=${compactReuse.batches}"`,
        );
      planning.value = { statistics, segments };
      if (planning.key !== undefined) rememberTextPlan(planning.key, planning.value);
    }
    const plan = planning.value;
    const statistics = plan.statistics;
    const selection = { digest: "" };
    if (selected.length > 4)
      selection.digest = await sha256(
        encodeRankingInput({
          text: identityText,
          mode: input.match ?? "any",
          top_k: 1,
          dead: [],
          filters: input.filters,
          statistics,
        }),
      );
    const bounded = selected.map((segment, index) => {
      const planned = plan.segments[index];
      if (planned === undefined)
        throw new Rejected({ status: 503, message: "Text plan omitted a segment" });
      const identity = `${workerEnv.STORAGE_CACHE_SCOPE}:${segment.key}:${segment.headerBytes}:${Schema.encodeSync(integers)(segment.dead)}:${selection.digest}`;
      const retained = {
        bound: planned.bound,
        minimumId: planned.minimumId,
        maximumMatches: planned.maximumMatches,
      };
      if (selection.digest !== "") {
        const learned = segmentScoreBound(identity);
        if (learned !== undefined) {
          if (learned.bound < retained.bound) {
            retained.bound = learned.bound;
            retained.minimumId = learned.minimumId;
          } else if (learned.bound === retained.bound && learned.minimumId > retained.minimumId)
            retained.minimumId = learned.minimumId;
          reuse.bounds += 1;
        }
      }
      if (retained.bound === 0) retained.maximumMatches = 0;
      return {
        segment,
        index,
        eligible: planned.eligible && retained.maximumMatches > 0,
        maximumMatches: retained.maximumMatches,
        singleton: planned.singleton,
        bound: retained.bound,
        minimumId: retained.minimumId,
        identity,
      };
    });
    const prioritized = bounded.sort((left, right) => {
      if (left.bound !== right.bound) return right.bound - left.bound;
      if (left.minimumId < right.minimumId) return -1;
      if (left.minimumId > right.minimumId) return 1;
      return 0;
    });
    timings.append(
      "server-timing",
      `text_plan;desc="${reuse.plan}", text_bound_hits;desc="${reuse.bounds}"`,
    );
    const dictionaryEnded = Effect.runSync(Clock.currentTimeNanos);
    timings.append("server-timing", 'text_phase;desc="ranking"');
    timings.append(
      "server-timing",
      `text_directory;dur=${Number(dictionaryEnded - started) / 1e6}`,
    );
    const ranked: Array<
      (typeof SegmentHits.Type)[number] & { segment: (typeof Root.Type)["segments"][number] }
    > = [];
    const rankMetrics = {
      prepare: 0n,
      acquire: 0n,
      decode: 0n,
      score: 0n,
      spans: 0,
      ranges: 0,
      blocks: 0,
      bytes: 0,
      segments: 0,
      common: 0,
      uniform: 0,
      uniformHits: 0,
      singletons: 0,
    };
    using plans = new DisposableStack();
    const compilation: { query: PreparedQuery | undefined } = { query: undefined };
    const rankingConcurrency = 4;
    const rankIo = Semaphore.makeUnsafe(rankingConcurrency);
    const scheduling = { offset: 0, matches: 0 };
    while (scheduling.offset < prioritized.length) {
      const capacity = rankingConcurrency - (scheduling.offset % rankingConcurrency);
      const rankingWindow = prioritized.slice(scheduling.offset, scheduling.offset + capacity);
      const maximumMatches = rankingWindow.reduce(
        (count, entry) => count + entry.maximumMatches,
        0,
      );
      const width = Match.value(scheduling.offset).pipe(
        Match.when(
          () =>
            scheduling.offset < rankingConcurrency && ranked.length + maximumMatches <= input.topK,
          () => capacity,
        ),
        Match.when(0, () => 1),
        Match.when(
          () => ranked.length < input.topK && scheduling.matches > 0,
          () => Math.min(capacity, input.topK - ranked.length),
        ),
        Match.when(
          (offset) => offset < rankingConcurrency && ranked.length === input.topK,
          () => 1,
        ),
        Match.orElse(() => capacity),
      );
      rankingWindow.splice(width);
      scheduling.offset += rankingWindow.length;
      const cutoff = ranked[input.topK - 1];
      const eligible = rankingWindow.filter(({ eligible: allowed, bound, minimumId }) => {
        if (!allowed) return false;
        if (ranked.length === input.topK) {
          if (cutoff === undefined)
            throw new Rejected({ status: 503, message: "Invalid ranking cutoff" });
          if (bound + 1e-12 < cutoff.score || (bound === cutoff.score && minimumId >= cutoff.id))
            return false;
        }
        return true;
      });
      scheduling.matches = 0;
      if (eligible.length === 0) continue;
      if (compilation.query === undefined)
        compilation.query = plans.use(
          new PreparedQuery(
            encodeRankingInput({
              text: input.text,
              mode: input.match ?? "any",
              top_k: input.topK,
              dead: [],
              filters: input.filters,
              statistics,
            }),
          ),
        );
      const prepared = compilation.query;
      const batches = await runQueryEffect(
        Effect.forEach(
          eligible,
          ({ segment, identity, singleton }) =>
            Effect.gen(function* () {
              const dead = yield* Schema.encodeEffect(integers)(segment.dead);
              const prepareStarted = yield* Clock.currentTimeNanos;
              if (
                singleton !== undefined &&
                (input.match !== "phrase" || words.length === 1) &&
                (input.filters.length === 0 || unrestricted.has(segment.key))
              ) {
                const exact = prepared.singleton_hits(
                  yield* Schema.encodeEffect(Schema.fromJsonString(TermSummaries))(singleton),
                  segment.count,
                  dead,
                  unrestricted.get(segment.key),
                );
                if (exact !== undefined) {
                  rankMetrics.singletons += 1;
                  rankMetrics.prepare += (yield* Clock.currentTimeNanos) - prepareStarted;
                  return yield* decodeSegmentHits(exact);
                }
              }
              const dictionary = segment.commonTerms;
              if (
                (input.filters.length === 0 || unrestricted.has(segment.key)) &&
                (input.match !== "phrase" || words.length === 1) &&
                dictionary !== undefined &&
                segment.commonLeaders !== undefined &&
                terms.every((term) => Object.hasOwn(dictionary, term))
              ) {
                const common = prepared.common_hits(
                  yield* Schema.encodeEffect(Schema.fromJsonString(CommonTerms))(dictionary),
                  yield* Schema.encodeEffect(Schema.fromJsonString(CommonLeaders))(
                    segment.commonLeaders,
                  ),
                  segment.count,
                  dead,
                  unrestricted.get(segment.key),
                );
                if (common !== undefined) {
                  rankMetrics.common += 1;
                  rankMetrics.prepare += (yield* Clock.currentTimeNanos) - prepareStarted;
                  return yield* decodeSegmentHits(common);
                }
              }
              if (unrestricted.has(segment.key)) rankMetrics.uniform += 1;
              return yield* withDirectory(
                segment.key,
                segment.headerBytes,
                (decoded) =>
                  Effect.acquireUseRelease(
                    Effect.sync(() =>
                      decoded.ranker_prepared(prepared, dead, unrestricted.get(segment.key)),
                    ),
                    (ranker) =>
                      Effect.gen(function* () {
                        const uniform = ranker.uniform_hits();
                        rankMetrics.prepare += (yield* Clock.currentTimeNanos) - prepareStarted;
                        if (uniform !== undefined) rankMetrics.uniformHits += 1;
                        if (uniform === undefined) {
                          const encodedSpans = Match.value(cutoff).pipe(
                            Match.when(undefined, () => ranker.posting_spans_seeded()),
                            Match.orElse((hit) => ranker.posting_spans_after(hit.score, hit.id)),
                          );
                          const requested = yield* decodePostingSpans(encodedSpans);
                          const spans = yield* Effect.forEach(requested, (metadata) =>
                            Effect.gen(function* () {
                              const first = metadata.blocks[0];
                              if (first === undefined)
                                return yield* new Rejected({
                                  status: 503,
                                  message: "Empty posting directory",
                                });
                              const span = { end: first.data.offset };
                              for (const block of metadata.blocks) {
                                if (
                                  block.data.offset < span.end ||
                                  block.data.offset - span.end > 4096 ||
                                  block.data.length <= 0
                                )
                                  return yield* new Rejected({
                                    status: 503,
                                    message: "Invalid posting span gap",
                                  });
                                span.end = block.data.offset + block.data.length;
                              }
                              const start = segment.headerBytes + first.data.offset;
                              const length = span.end - first.data.offset;
                              if (
                                start < segment.headerBytes ||
                                start + length > segment.bytes ||
                                length > 16777216
                              )
                                return yield* new Rejected({
                                  status: 503,
                                  message: "Invalid posting range",
                                });
                              return {
                                offset: first.data.offset,
                                end: span.end,
                                gaps: 0,
                                postings: [{ metadata, offset: first.data.offset, length }],
                              };
                            }),
                          );
                          const groups: typeof spans = [];
                          for (const span of spans) {
                            const previous = groups.at(-1);
                            if (
                              previous !== undefined &&
                              span.offset >= previous.end &&
                              previous.gaps + span.offset - previous.end <= 16384 &&
                              span.end - previous.offset <= 1048576
                            ) {
                              previous.gaps += span.offset - previous.end;
                              previous.end = span.end;
                              previous.postings.push(...span.postings);
                            } else groups.push(span);
                          }
                          for (const offset of Array.from(
                            { length: Math.ceil(groups.length / 4) },
                            (_, index) => index * 4,
                          )) {
                            const window = groups.slice(offset, offset + 4);
                            const acquireStarted = yield* Clock.currentTimeNanos;
                            const acquiredGroups = yield* Effect.forEach(
                              window,
                              (group) =>
                                Effect.gen(function* () {
                                  const bytes = yield* rankIo.withPermit(
                                    Effect.tryPromise({
                                      try: (fiberSignal) =>
                                        range(
                                          segment.key,
                                          segment.headerBytes + group.offset,
                                          group.end - group.offset,
                                          false,
                                          true,
                                          undefined,
                                          queryRangeSignal(signal, fiberSignal),
                                        ),
                                      catch: (cause) => strongQueryFailure(cause),
                                    }),
                                  );
                                  return {
                                    bytes: bytes.byteLength,
                                    postings: group.postings.map((posting) => ({
                                      term: posting.metadata.term,
                                      metadata: posting.metadata,
                                      bytes: bytes.subarray(
                                        posting.offset - group.offset,
                                        posting.offset - group.offset + posting.length,
                                      ),
                                      offset: posting.offset,
                                    })),
                                  };
                                }),
                              { concurrency: 4 },
                            );
                            const loaded = acquiredGroups.flatMap((group) => group.postings);
                            const acquired = yield* Clock.currentTimeNanos;
                            rankMetrics.acquire += acquired - acquireStarted;
                            rankMetrics.spans += loaded.length;
                            rankMetrics.ranges += window.length;
                            rankMetrics.bytes += acquiredGroups.reduce(
                              (total, group) => total + group.bytes,
                              0,
                            );
                            rankMetrics.blocks += loaded.reduce(
                              (total, posting) => total + posting.metadata.blocks.length,
                              0,
                            );
                            for (const posting of loaded)
                              for (const block of posting.metadata.blocks) {
                                const start = block.data.offset - posting.offset;
                                const bytes = posting.bytes.subarray(
                                  start,
                                  start + block.data.length,
                                );
                                if (
                                  input.match === "phrase" ||
                                  (block.max_title_tf <= 1 && block.max_body_tf <= 1)
                                )
                                  ranker.add(posting.term, bytes);
                                else
                                  addFrequencyPosting(
                                    ranker,
                                    segment.key,
                                    posting.term,
                                    segment.headerBytes + block.data.offset,
                                    bytes,
                                  );
                              }
                            rankMetrics.decode += (yield* Clock.currentTimeNanos) - acquired;
                          }
                        }
                        const scoreStarted = yield* Clock.currentTimeNanos;
                        const encodedHits = Match.value(uniform).pipe(
                          Match.when(undefined, () => ranker.finish()),
                          Match.orElse((hits) => hits),
                        );
                        const hits = yield* decodeSegmentHits(encodedHits);
                        rankMetrics.score += (yield* Clock.currentTimeNanos) - scoreStarted;
                        rankMetrics.segments += 1;
                        return hits;
                      }),
                    (ranker) => Effect.sync(() => ranker.free()),
                  ),
                rankIo,
                false,
                eligible.length > 1 || (rootFiltered && reuse.plan === "miss"),
                Match.value(dictionary).pipe(
                  Match.when(undefined, () => undefined),
                  Match.orElse((common) => {
                    if (terms.every((term) => Object.hasOwn(common, term))) return prepared;
                    return undefined;
                  }),
                ),
                false,
                signal,
              );
            }).pipe(
              Effect.map((hits) => {
                if (selection.digest !== "") {
                  const upper = { bound: cutoff?.score ?? 0, minimumId: segment.minimumId };
                  if (cutoff !== undefined && cutoff.id > upper.minimumId)
                    upper.minimumId = cutoff.id;
                  for (const hit of hits) {
                    if (hit.score > upper.bound) {
                      upper.bound = hit.score;
                      upper.minimumId = hit.id;
                    } else if (hit.score === upper.bound && hit.id < upper.minimumId)
                      upper.minimumId = hit.id;
                  }
                  rememberSegmentScoreBound(identity, upper);
                }
                return hits.map((hit) => ({ ...hit, segment }));
              }),
            ),
          { concurrency: rankingConcurrency },
        ),
        signal,
      );
      scheduling.matches = batches.reduce((count, batch) => count + batch.length, 0);
      ranked.push(...batches.flat());
      ranked.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
      ranked.splice(input.topK);
    }
    const rankingEnded = Effect.runSync(Clock.currentTimeNanos);
    if (planning.key !== undefined && shared.key !== undefined) {
      const tightened = [...plan.segments];
      const publication = { improved: false };
      for (const entry of prioritized) {
        const upper = segmentScoreBound(entry.identity);
        const original = plan.segments[entry.index];
        if (
          upper !== undefined &&
          original !== undefined &&
          (upper.bound < original.bound ||
            (upper.bound === original.bound && upper.minimumId > original.minimumId))
        ) {
          tightened[entry.index] = { ...original, ...upper };
          publication.improved = true;
        }
      }
      if (publication.improved || reuse.plan === "miss") {
        const value = { statistics, segments: tightened };
        rememberTextPlan(planning.key, value);
        const encoded = Schema.encodeSync(Schema.fromJsonString(SharedTextPlan))({
          identity: planning.key,
          version: runtime.version,
          plan: value,
        });
        const encodedBytes = new TextEncoder().encode(encoded).byteLength;
        if (encodedBytes <= 1024 * 1024) {
          const packed = pack(encoded);
          if (packed.byteLength <= 256 * 1024) {
            const cacheHeaders = Schema.encodeSync(SharedTextPlanCacheHeaders)({
              "content-length": packed.byteLength,
              "x-kannin-plan-bytes": encodedBytes,
            });
            const cacheKey = shared.key;
            const identity = cacheKey.href;
            const charge = packed.byteLength * 4 + identity.length * 4 + 128;
            const retainedCache = shared.cache;
            if (
              publishQueryCache(
                identity,
                charge,
                Effect.gen(function* () {
                  const cache = yield* Match.value(retainedCache).pipe(
                    Match.when(undefined, () =>
                      Effect.tryPromise(() => caches.open("kannin-text-plans-v1")),
                    ),
                    Match.orElse((opened) => Effect.succeed(opened)),
                  );
                  yield* Effect.tryPromise(() =>
                    cache.put(
                      cacheKey,
                      new Response(new Uint8Array(packed), {
                        headers: {
                          ...cacheHeaders,
                          "cache-control": "public, max-age=3600",
                          "content-type": "application/octet-stream",
                        },
                      }),
                    ),
                  );
                }),
                ctx,
              )
            ) {
              timings.append("server-timing", "text_plan_publish_scheduled");
            } else timings.append("server-timing", "text_plan_publish_skipped");
          }
        }
      }
    }
    timings.append("server-timing", `text_common_leaders;desc="segments=${rankMetrics.common}"`);
    timings.append(
      "server-timing",
      `text_singleton_hits;desc="segments=${rankMetrics.singletons}"`,
    );
    timings.append("server-timing", `text_uniform_postings;desc="segments=${rankMetrics.uniform}"`);
    timings.append("server-timing", `text_uniform_hits;desc="segments=${rankMetrics.uniformHits}"`);
    timings.append(
      "server-timing",
      `text_rank;dur=${Number(rankingEnded - dictionaryEnded) / 1e6}`,
    );
    timings.append("server-timing", `text_rank_prepare;dur=${Number(rankMetrics.prepare) / 1e6}`);
    timings.append(
      "server-timing",
      `text_posting_acquire;dur=${Number(rankMetrics.acquire) / 1e6};desc="spans=${rankMetrics.spans} bytes=${rankMetrics.bytes} ranges=${rankMetrics.ranges}"`,
    );
    timings.append(
      "server-timing",
      `text_posting_decode;dur=${Number(rankMetrics.decode) / 1e6};desc="blocks=${rankMetrics.blocks}"`,
    );
    timings.append(
      "server-timing",
      `text_score;dur=${Number(rankMetrics.score) / 1e6};desc="segments=${rankMetrics.segments}"`,
    );
    return ranked.slice(0, input.topK);
  }

  async function rankVectors(
    input: typeof Query.Type,
    root: typeof Root.Type,
    timings: Headers,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (input.kind === "text" || root.documents === 0) return [];
    const started = Effect.runSync(Clock.currentTimeNanos);
    const hits = await runQueryEffect(
      Effect.acquireUseRelease(
        Effect.try(() => new VectorRanker(new Float32Array(input.vector), input.topK)),
        (ranker) =>
          Effect.gen(function* () {
            const retained = new Map<
              string,
              typeof NativeVectorLocation.Type & {
                readonly segment: (typeof Root.Type.segments)[number];
              }
            >();
            const filters = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Filter)))(
              input.filters,
            );
            for (const segment of root.segments.toReversed()) {
              yield* withDirectory(
                segment.key,
                segment.headerBytes,
                (directory) =>
                  Effect.acquireUseRelease(
                    Effect.gen(function* () {
                      const dead = yield* Schema.encodeEffect(integers)(segment.dead);
                      return yield* Effect.try(() => directory.vector_reader(filters, dead));
                    }),
                    (reader) =>
                      Effect.gen(function* () {
                        const progress = { complete: false };
                        while (!progress.complete) {
                          const encoded = yield* Effect.try(() => reader.next_page());
                          const page = yield* Schema.decodeEffect(
                            Schema.fromJsonString(NativeVectorPage),
                          )(encoded);
                          progress.complete = page.complete;
                          for (const row of page.rows) {
                            const data = row.vectorData;
                            if (
                              data.length < 8 ||
                              data.offset < row.data.offset + row.data.length ||
                              segment.headerBytes + data.offset + data.length > segment.bytes
                            )
                              return yield* new Rejected({
                                status: 503,
                                message: "Invalid canonical vector range",
                              });
                            const frame = yield* Effect.tryPromise((fiberSignal) =>
                              range(
                                segment.key,
                                segment.headerBytes + data.offset,
                                data.length,
                                false,
                                true,
                                undefined,
                                queryRangeSignal(signal, fiberSignal),
                              ),
                            );
                            const discarded = yield* Effect.try(() =>
                              ranker.push_frame(row.id, frame),
                            );
                            retained.set(row.id, { ...row, segment });
                            if (discarded !== undefined) retained.delete(discarded);
                          }
                        }
                        return undefined;
                      }),
                    (reader) => Effect.sync(() => reader.free()),
                  ),
                undefined,
                false,
                input.kind === "vector",
                undefined,
                false,
                signal,
              );
            }
            const encoded = yield* Effect.try(() => ranker.finish());
            const selected = yield* Schema.decodeEffect(Schema.fromJsonString(NativeVectorHits))(
              encoded,
            );
            return yield* Effect.forEach(selected, ([id, score]) => {
              const location = retained.get(id);
              if (location === undefined)
                return new Rejected({
                  status: 503,
                  message: "Native vector selection omitted its location",
                });
              return Effect.succeed({
                row: location.row,
                id,
                score,
                data: location.data,
                segment: location.segment,
              });
            });
          }),
        (ranker) => Effect.sync(() => ranker.free()),
      ),
      signal,
    );
    const ended = Effect.runSync(Clock.currentTimeNanos);
    timings.append("server-timing", `vector_index;dur=${Number(ended - started) / 1e6}`);
    return hits;
  }

  async function query(
    input: typeof Query.Type,
    manifest: typeof Root.Type,
    ctx: BackgroundContext,
    timings: Headers,
    executions?: TextExecutions,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return Effect.runPromise(
      ownedRead((ownedSignal) =>
        executeQuery(input, manifest, ctx, timings, executions, ownedSignal),
      ),
      { signal },
    );
  }

  async function executeQuery(
    input: typeof Query.Type,
    manifest: typeof Root.Type,
    ctx: BackgroundContext,
    timings: Headers,
    executions?: TextExecutions,
    signal?: AbortSignal,
  ) {
    const dimensions = resolvedVectorDimensions(manifest.schema);
    if (input.kind !== "text" && input.vector.length !== dimensions)
      throw new Rejected({ status: 400, message: `Vector dimension must be ${dimensions}` });
    if (manifest.sequence < (input.minimumSequence ?? 0))
      throw new Rejected({ status: 409, message: "Requested sequence is not committed" });
    const filterable = filterableNames(manifest.schema) ?? [];
    for (const filter of input.filters)
      if (!filterable.includes(filter.field))
        throw new Rejected({
          status: 400,
          message: `Attribute is not filterable: ${filter.field}`,
        });
    if (input.kind === "text") {
      const materialize = async (producerSignal?: AbortSignal) => {
        const hits = await rankText(input, manifest, timings, ctx, producerSignal);
        timings.append("server-timing", 'text_phase;desc="documents"');
        const started = Effect.runSync(Clock.currentTimeNanos);
        const rows = await runQueryEffect(
          readDocumentHits(
            hits.map((hit) => [hit.segment, hit.data, hit.score] as const),
            producerSignal,
          ),
          producerSignal,
        );
        const ended = Effect.runSync(Clock.currentTimeNanos);
        timings.append("server-timing", `text_documents;dur=${Number(ended - started) / 1e6}`);
        return rows;
      };
      const rows = await Match.value(executions).pipe(
        Match.when(undefined, () => materialize(signal)),
        Match.orElse((active) => active.evaluate(manifest, input, timings, materialize, signal)),
      );
      return encodeQueryResult({
        rows,
        sequence: manifest.sequence,
        consistency: input.consistency ?? "strong",
      });
    }
    const [text, vectors] = await Promise.all([
      rankText(input, manifest, timings, ctx, signal),
      rankVectors(input, manifest, timings, signal),
    ]);
    const scores = new Map<string, Awaited<ReturnType<typeof rankText>>[number]>();
    if (input.kind === "hybrid") {
      for (const list of [text, vectors])
        for (const [rank, hit] of list.entries())
          scores.set(hit.id, { ...hit, score: (scores.get(hit.id)?.score ?? 0) + 1 / (61 + rank) });
    } else for (const hit of [...text, ...vectors]) scores.set(hit.id, hit);
    const hits = Match.value(input.kind).pipe(
      Match.when("vector", () => vectors),
      Match.orElse(() =>
        [...scores.values()]
          .sort((a, b) => {
            if (a.score !== b.score) return b.score - a.score;
            if (a.id < b.id) return -1;
            if (a.id > b.id) return 1;
            return 0;
          })
          .slice(0, input.topK),
      ),
    );
    const started = Effect.runSync(Clock.currentTimeNanos);
    const rows = await runQueryEffect(
      readDocumentHits(
        hits.map((hit) => [hit.segment, hit.data, hit.score] as const),
        signal,
      ),
      signal,
    );
    if (input.kind === "hybrid") {
      if (rows.length !== hits.length)
        throw new Rejected({ status: 503, message: "Hybrid document projection omitted a hit" });
      for (const [index, row] of rows.entries()) {
        const hit = hits[index];
        if (hit === undefined || row.id !== hit.id)
          throw new Rejected({
            status: 503,
            message: "Hybrid document identity differs from its header",
          });
      }
    }
    const ended = Effect.runSync(Clock.currentTimeNanos);
    timings.append("server-timing", `${input.kind}_documents;dur=${Number(ended - started) / 1e6}`);
    return encodeQueryResult({
      rows,
      sequence: manifest.sequence,
      consistency: "strong",
    });
  }

  class SearchNamespace extends RuntimeEntry<Environment> {
    private readonly semaphore = Semaphore.makeUnsafe(1);
    private namespacePublished = false;
    private readonly querySlots = Semaphore.makeUnsafe(4);
    private readonly readers = new Map<symbol, typeof Root.Type>();
    private readonly textExecutions = new TextExecutions();
    private namespace: typeof NamespaceName.Type | undefined;
    private acknowledgedReceipt: typeof Receipt.Type | undefined;
    private current:
      | {
          manifest: typeof Root.Type;
          etag: string | null;
          manifestEncodedBytes?: number;
        }
      | undefined;

    private withRootPermit<A, E, R>(operation: Effect.Effect<A, E, R>) {
      if (!runtime.freshRoots) return this.semaphore.withPermit(operation);
      return this.semaphore.withPermit(
        operation.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.current = undefined;
              this.acknowledgedReceipt = undefined;
            }),
          ),
        ),
      );
    }

    private get prefix() {
      if (this.namespace === undefined) throw new Error("Namespace must be bound before R2 access");
      return `namespaces/${this.namespace}`;
    }

    private async root(signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (this.current !== undefined) return this.current;
      const object = await this.env.STORAGE.get(`${this.prefix}/root.json`, {
        ...(signal !== undefined && { signal }),
      });
      if (object !== null) {
        const encoded = await object.text();
        signal?.throwIfAborted();
        this.current = { manifest: decodeRoot(encoded), etag: object.etag };
        return this.current;
      }
      const acknowledged = await this.env.STORAGE.list({
        prefix: `${this.prefix}/receipts/`,
        limit: 1,
        ...(signal !== undefined && { signal }),
      });
      signal?.throwIfAborted();
      if (acknowledged.objects.length > 0)
        throw new Rejected({
          status: 503,
          message: "R2 manifest missing for an acknowledged namespace",
        });
      const manifest: typeof Root.Type = {
        version: 1,
        sequence: 0,
        head: null,
        documents: 0,
        titleLength: 0,
        bodyLength: 0,
        vectorEpoch: await sha256(`${this.prefix}\0${crypto.randomUUID()}`),
        vectorJobs: [],
        lastReceipt: null,
        bloomPacks: [],
        segments: [],
      };
      signal?.throwIfAborted();
      this.current = { manifest, etag: null };
      return this.current;
    }

    private async hintCacheWarm() {
      const current = await this.root();
      if (current.etag === null)
        throw new Rejected({ status: 404, message: "Namespace does not exist" });
      const identity = `${this.env.STORAGE_CACHE_SCOPE}:${this.namespace}`;
      if (!warming.has(identity)) {
        if (warming.size >= 4)
          throw new Rejected({ status: 503, message: "Cache warming capacity exceeded" });
        const selected: (typeof Root.Type.segments)[number][] = [];
        const budget = { bytes: 0 };
        for (const segment of current.manifest.segments.toReversed()) {
          if (selected.length >= 64) break;
          if (segment.headerBytes > 2 * 1024 * 1024) continue;
          if (budget.bytes + segment.headerBytes > 16 * 1024 * 1024) break;
          selected.push(segment);
          budget.bytes += segment.headerBytes;
        }
        const lease = Symbol();
        warming.add(identity);
        this.readers.set(lease, current.manifest);
        this.ctx.waitUntil(
          Effect.runPromise(
            Effect.forEach(
              selected,
              (segment) => withDirectory(segment.key, segment.headerBytes, () => Effect.void),
              { concurrency: 1, discard: true },
            ).pipe(
              Effect.timeout("20 seconds"),
              Effect.catchCause((cause) => Effect.logError("kannin.cache.warm", cause)),
              Effect.ensuring(
                Effect.sync(() => {
                  this.readers.delete(lease);
                  warming.delete(identity);
                }),
              ),
            ),
          ),
        );
      }
      return Schema.encodeSync(CacheWarmHintResult)({
        status: "ACCEPTED",
        message: "cache warm hint accepted",
      });
    }

    private async readRebuildCheckpoint(object: ObjectBody) {
      if (object.size > VECTOR_REBUILD_CHECKPOINT_BYTES) {
        await object.body.cancel();
        throw new Rejected({ status: 503, message: "Rebuild checkpoint exceeds byte budget" });
      }
      const bytes = await object.arrayBuffer();
      if (bytes.byteLength !== object.size)
        throw new Rejected({ status: 503, message: "Rebuild checkpoint body size mismatch" });
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }

    private async migrateSegment<
      Segment extends
        | (typeof LegacyInlineRoot.Type.segments)[number]
        | (typeof LegacyPackedRoot.Type.segments)[number],
    >(segment: Segment) {
      const object = await this.env.STORAGE.get(segment.key);
      if (object === null || object.size !== segment.bytes || object.size > 16 * 1024 * 1024)
        throw new Rejected({
          status: 503,
          message: "Migration segment unavailable or exceeds size budget",
        });
      const source = new Uint8Array(await object.arrayBuffer());
      if (source.byteLength !== segment.bytes)
        throw new Rejected({ status: 503, message: "Migration segment body size mismatch" });
      const bytes = new Uint8Array(segment_migrate(source));
      const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment_header(bytes));
      const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
      if (header.documents.length !== segment.count || header.documents[0].id !== segment.minimumId)
        throw new Rejected({ status: 503, message: "Migration changed segment row identity" });
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
      const key = `${this.prefix}/segments/${digest}-${await sha256(segment.key)}.rsix`;
      const stored = await this.env.STORAGE.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
      if (stored === null) {
        const existing = await this.env.STORAGE.get(key);
        if (existing === null || existing.size !== bytes.byteLength)
          throw new Rejected({ status: 503, message: "Migrated segment identity conflict" });
        const existingBytes = await existing.arrayBuffer();
        if (
          existingBytes.byteLength !== bytes.byteLength ||
          new Uint8Array(await crypto.subtle.digest("SHA-256", existingBytes)).toHex() !== digest
        )
          throw new Rejected({ status: 503, message: "Migrated segment digest mismatch" });
      }
      await Effect.runPromise(
        storeSegmentCaches(
          key,
          headerBytes,
          bytes,
          segment.commonTerms !== undefined && Object.keys(segment.commonTerms).length > 0,
        ),
      );
      const commonLeaders = segment.commonLeaders?.map((leader) => ({
        ...leader,
        documents: leader.documents.map((document) => {
          const row = header.documents[document.row];
          if (row === undefined || row.id !== document.id)
            throw new Rejected({ status: 503, message: "Migration leader row identity mismatch" });
          return { ...document, data: row.data };
        }),
      }));
      return {
        ...segment,
        key,
        headerBytes,
        bytes: bytes.byteLength,
        metadataEnd: headerBytes + header.metadata_end,
        commonLeaders,
      };
    }

    private async migrateManifest(
      saved:
        | ReturnType<typeof decodeRootForMigration>
        | ReturnType<typeof decodeVectorRebuildSnapshotForMigration>,
    ) {
      if (saved.kind === "current" || saved.kind === "schema") {
        if ("snapshot" in saved) return saved.snapshot.root;
        return saved.root;
      }
      if (saved.kind === "legacy") {
        const root = (() => {
          if ("snapshot" in saved) return saved.snapshot.root;
          return saved.root;
        })();
        const columns = Option.getOrUndefined(
          Option.map(Option.fromUndefinedOr(root.schema), namespaceColumnsFromNative),
        );
        const segments = [];
        for (const segment of root.segments) segments.push(await this.migrateSegment(segment));
        const prepared: { value: typeof ConvertedInlineRoot.Type } = {
          value: { ...root, segments },
        };
        if (saved.needsEligibility)
          prepared.value = {
            ...prepared.value,
            segments: await Effect.runPromise(
              Effect.forEach(
                segments,
                (segment) =>
                  Effect.map(
                    rebuildEligibility(segment, filterableNames(columns)),
                    (eligibility) => ({
                      ...segment,
                      eligibility,
                    }),
                  ),
                { concurrency: 1 },
              ),
            ),
          };
        return Effect.runPromise(packBloomRoot(this.prefix, prepared.value));
      }
      const root = (() => {
        if ("snapshot" in saved) return saved.snapshot.root;
        return saved.root;
      })();
      const segments = [];
      const replacements = new Map<string, string>();
      for (const segment of root.segments) {
        const converted = await this.migrateSegment(segment);
        segments.push(converted);
        replacements.set(segment.key, converted.key);
      }
      const { schema: legacySchema, ...fields } = root;
      const schemaFields = Option.match(Option.fromUndefinedOr(legacySchema), {
        onNone: () => ({}),
        onSome: (native) => ({ schema: namespaceColumnsFromNative(native) }),
      });
      return {
        ...fields,
        ...schemaFields,
        segments,
        bloomPacks: root.bloomPacks.map((descriptor) =>
          Object.assign({}, descriptor, {
            segmentKeys: descriptor.segmentKeys.map((key) => replacements.get(key) ?? key),
          }),
        ),
      };
    }

    private async migrateRoot() {
      this.current = undefined;
      this.acknowledgedReceipt = undefined;
      const key = `${this.prefix}/root.json`;
      const object = await this.env.STORAGE.get(key);
      if (object === null) {
        const receipts = await this.env.STORAGE.list({
          prefix: `${this.prefix}/receipts/`,
          limit: 1,
        });
        if (receipts.objects.length > 0)
          throw new Rejected({
            status: 503,
            message: "R2 manifest missing for an acknowledged namespace",
          });
      }
      const root = await Option.getOrUndefined(
        Option.map(Option.fromNullishOr(object), async (captured) =>
          decodeRootForMigration(await captured.text()),
        ),
      );
      const now = Effect.runSync(Clock.currentTimeMillis);
      const snapshots: ObjectListOptions = {
        prefix: `${this.prefix}/vector-rebuild/`,
        limit: 100,
        include: ["customMetadata"],
      };
      const progress = { count: 0, bytes: 0, migrated: 0, expired: 0 };
      for (;;) {
        const page = await this.env.STORAGE.list(snapshots);
        progress.count += page.objects.length;
        if (progress.count > 1024)
          throw new Rejected({
            status: 503,
            message: "Too many rebuild checkpoints for bounded migration",
          });
        for (const checkpoint of page.objects) {
          progress.bytes += checkpoint.size;
          if (
            checkpoint.size > VECTOR_REBUILD_CHECKPOINT_BYTES ||
            progress.bytes > 32 * 1024 * 1024
          )
            throw new Rejected({
              status: 503,
              message: "Rebuild checkpoints exceed migration byte budget",
            });
          const captured = await this.env.STORAGE.get(checkpoint.key);
          if (captured === null)
            throw new Rejected({
              status: 409,
              message: "Rebuild checkpoint disappeared during migration",
            });
          const chargedBytes = Math.max(checkpoint.size, captured.size);
          progress.bytes += chargedBytes - checkpoint.size;
          if (progress.bytes > 32 * 1024 * 1024) {
            await captured.body.cancel();
            throw new Rejected({
              status: 503,
              message: "Captured rebuild checkpoints exceed migration byte budget",
            });
          }
          const saved = decodeVectorRebuildSnapshotForMigration(
            await this.readRebuildCheckpoint(captured),
          );
          const expiration = { value: captured.uploaded.getTime() + SNAPSHOT_RETENTION_MS };
          if (
            captured.customMetadata?.expiresAt !== undefined ||
            saved.kind === "current" ||
            saved.sourceVersion === 3 ||
            saved.sourceVersion === 4 ||
            saved.sourceVersion === 5
          )
            expiration.value = Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(
              captured.customMetadata,
            ).expiresAt;
          if (now >= expiration.value) {
            await this.env.STORAGE.delete(checkpoint.key);
            progress.expired += 1;
            continue;
          }
          if (saved.kind === "current") continue;
          const manifest = await this.migrateManifest(saved);
          const encodedSnapshot = encodeVectorRebuildSnapshot({
            ...saved.snapshot,
            root: manifest,
          });
          progress.bytes += Math.max(chargedBytes, encodedSnapshot.byteLength) - chargedBytes;
          if (progress.bytes > 32 * 1024 * 1024)
            throw new Rejected({
              status: 503,
              message: "Converted rebuild checkpoints exceed migration byte budget",
            });
          const converted = await this.env.STORAGE.put(checkpoint.key, encodedSnapshot, {
            onlyIf: { etagMatches: captured.etag },
            customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({
              expiresAt: expiration.value,
            }),
          });
          if (converted === null)
            throw new Rejected({
              status: 409,
              message: "Rebuild checkpoint changed during migration",
            });
          progress.migrated += 1;
        }
        if (!page.truncated) break;
        snapshots.cursor = page.cursor;
      }
      if (root === undefined || object === null)
        return Schema.encodeSync(RootMigrationResult)({
          version: 6,
          sequence: 0,
          rootRewritten: false,
          migratedSnapshots: progress.migrated,
          expiredSnapshots: progress.expired,
        });
      if (root.kind !== "current") {
        const manifest = await this.migrateManifest(root);
        const converted = await this.env.STORAGE.put(key, encodeRoot(manifest), {
          onlyIf: { etagMatches: object.etag },
        });
        if (converted === null)
          throw new Rejected({ status: 409, message: "R2 manifest changed during migration" });
        this.current = { manifest, etag: converted.etag };
      } else {
        const confirmed = await this.env.STORAGE.head(key);
        if (confirmed === null || confirmed.etag !== object.etag)
          throw new Rejected({ status: 409, message: "R2 manifest changed during migration" });
        this.current = { manifest: root.root, etag: object.etag };
      }
      this.namespacePublished = false;
      await this.publishNamespace();
      return Schema.encodeSync(RootMigrationResult)({
        version: 6,
        sequence: root.root.sequence,
        rootRewritten: root.kind !== "current",
        migratedSnapshots: progress.migrated,
        expiredSnapshots: progress.expired,
      });
    }

    private async commit(manifest: typeof Root.Type, etag: string | null) {
      this.current = undefined;
      const condition = { etagDoesNotMatch: "*" };
      const options = { onlyIf: condition };
      const content = encodeRoot(manifest);
      const result: { object: ObjectVersionType | null } = { object: null };
      if (etag !== null)
        result.object = await this.env.STORAGE.put(`${this.prefix}/root.json`, content, {
          onlyIf: { etagMatches: etag },
        });
      else result.object = await this.env.STORAGE.put(`${this.prefix}/root.json`, content, options);
      if (result.object === null)
        throw new Rejected({
          status: 409,
          message: "R2 manifest changed; retry the operation with the same requestId",
        });
      this.current = { manifest, etag: result.object.etag };
      return this.current;
    }

    private async publishNamespace() {
      if (this.namespacePublished) return;
      const key = `${namespaceCatalogPrefix}${this.prefix.slice("namespaces/".length)}`;
      for (const attempt of [0, 1]) {
        const existing = await this.env.STORAGE.head(key);
        if (existing !== null && existing.size === 0) {
          this.namespacePublished = true;
          return;
        }
        const onlyIf: ObjectCondition = {};
        if (existing === null) onlyIf.etagDoesNotMatch = "*";
        else onlyIf.etagMatches = existing.etag;
        const stored = await this.env.STORAGE.put(key, "", {
          onlyIf,
        });
        if (stored !== null) {
          this.namespacePublished = true;
          return;
        }
        if (attempt === 1)
          throw new Rejected({
            status: 503,
            message: "Namespace catalog publication did not settle",
          });
      }
    }

    private async persistReceipt(receipt: typeof Receipt.Type) {
      const acknowledged = this.acknowledgedReceipt;
      if (
        acknowledged !== undefined &&
        acknowledged.sequence === receipt.sequence &&
        acknowledged.digest === receipt.digest &&
        acknowledged.requestId === receipt.requestId
      )
        return;
      const key = `${this.prefix}/receipts/${await sha256(receipt.requestId)}.json`;
      const stored = await this.env.STORAGE.put(
        key,
        Schema.encodeSync(Schema.fromJsonString(Receipt))(receipt),
        {
          onlyIf: { etagDoesNotMatch: "*" },
        },
      );
      if (stored === null) {
        const existing = await this.env.STORAGE.get(key);
        if (existing === null)
          throw new Rejected({
            status: 503,
            message: "Committed receipt missing after conditional write",
          });
        const prior = Schema.decodeSync(Schema.fromJsonString(Receipt))(await existing.text());
        if (
          prior.digest !== receipt.digest ||
          prior.sequence !== receipt.sequence ||
          prior.requestId !== receipt.requestId
        )
          throw new Rejected({ status: 503, message: "Committed receipt conflict" });
      }
      await this.publishNamespace();
      this.acknowledgedReceipt = receipt;
    }

    private async enqueue(namespace: string, job: typeof VectorMessage.Type) {
      await this.env.VECTOR_JOBS.send(Schema.encodeSync(VectorMessage)({ ...job, namespace }));
    }

    private async enqueueCompaction(namespace: string, root: typeof Root.Type) {
      const target = Math.max(4, Math.ceil(root.documents / 10000) * 2);
      if (root.segments.length > target)
        await this.env.INDEX_JOBS.send(Schema.encodeSync(IndexMessage)({ namespace }));
    }

    private async write(input: typeof Write.Type, namespace: string) {
      const ids = [...input.upserts.map((document) => document.id), ...input.deletes];
      if (new Set(ids).size !== ids.length)
        throw new Rejected({ status: 400, message: "Duplicate ids within a write" });
      if (input.reset !== true && input.schema === undefined && ids.length === 0)
        throw new Rejected({ status: 400, message: "Empty write" });
      const fingerprint = await sha256(Schema.encodeSync(Schema.fromJsonString(Write))(input));
      const current = await this.root();
      if (current.manifest.lastReceipt !== null)
        await this.persistReceipt(current.manifest.lastReceipt);
      const priorObject = await this.env.STORAGE.get(
        `${this.prefix}/receipts/${await sha256(input.requestId)}.json`,
      );
      if (priorObject !== null) {
        const receipt = Schema.decodeSync(Schema.fromJsonString(Receipt))(await priorObject.text());
        if (receipt.digest !== fingerprint)
          throw new Rejected({
            status: 409,
            message: "requestId already used with a different payload",
          });
        const pending = current.manifest.vectorJobs.find(
          (job) => job.sequence === receipt.sequence,
        );
        if (pending !== undefined) await this.enqueue(namespace, { namespace, ...pending });
        if (receipt.sequence % 16 === 0) await this.enqueueCompaction(namespace, current.manifest);
        return Schema.encodeSync(WriteResult)({
          sequence: receipt.sequence,
          requestId: input.requestId,
          vectorSync: "queued",
        });
      }
      if (
        input.schema !== undefined &&
        current.manifest.schema !== undefined &&
        input.reset !== true
      ) {
        const encodeSchema = Schema.encodeSync(Schema.fromJsonString(NamespaceSchema));
        if (
          encodeSchema(input.schema) !==
          encodeSchema(nativeSchemaFromColumns(current.manifest.schema))
        )
          throw new Rejected({ status: 409, message: "Changing namespace schema requires reset" });
      }
      const columns = Option.match(Option.fromUndefinedOr(input.schema), {
        onNone: () => current.manifest.schema,
        onSome: namespaceColumnsFromNative,
      });
      const dimensions = resolvedVectorDimensions(columns);
      if (
        current.manifest.sequence > 0 &&
        current.manifest.schema === undefined &&
        dimensions !== DEFAULT_VECTOR_DIMENSIONS &&
        input.reset !== true
      )
        throw new Rejected({ status: 409, message: "Changing vector dimensions requires reset" });
      for (const document of input.upserts)
        if (document.vector !== undefined && document.vector.length !== dimensions)
          throw new Rejected({ status: 400, message: `Vector dimension must be ${dimensions}` });
      const prior = await locate(ids, current.manifest);
      const sequence = current.manifest.sequence + 1;
      const dead = new Map<string, number[]>();
      const removed = new Map<string, Map<string, number>>();
      const totals = {
        documents: current.manifest.documents,
        title: current.manifest.titleLength,
        body: current.manifest.bodyLength,
      };
      const vectorDeletes: string[] = [];
      for (const location of prior.values()) {
        const source = await readDocument(
          location.segment.key,
          location.segment.headerBytes,
          location.document.data,
          location.segment.bytes,
          location.vectorData,
        );
        const terms = Schema.decodeSync(strings)(
          segment_document_terms(
            Schema.encodeSync(Schema.fromJsonString(CanonicalDocument))(source),
          ),
        );
        const rows = dead.get(location.segment.key) ?? [];
        rows.push(location.row);
        dead.set(location.segment.key, rows);
        const frequencies = removed.get(location.segment.key) ?? new Map<string, number>();
        for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
        removed.set(location.segment.key, frequencies);
        totals.documents -= 1;
        totals.title -= location.document.title_length;
        totals.body -= location.document.body_length;
        if (location.document.vector)
          vectorDeletes.push(
            await vectorId(
              current.manifest.vectorEpoch,
              location.document.id,
              location.document.revision,
            ),
          );
      }
      const segments = current.manifest.segments.map((segment) => {
        const removedFrequencies = new Map(Object.entries(segment.removedFrequencies));
        for (const [term, count] of removed.get(segment.key) ?? new Map<string, number>())
          removedFrequencies.set(term, (removedFrequencies.get(term) ?? 0) + count);
        return {
          ...segment,
          dead: [...segment.dead, ...(dead.get(segment.key) ?? [])],
          removedFrequencies: Object.fromEntries(removedFrequencies),
        };
      });
      const epoch = { value: current.manifest.vectorEpoch };
      if (input.schema !== undefined && current.manifest.schema === undefined)
        epoch.value = await sha256(`${current.manifest.vectorEpoch}\0schema\0${sequence}`);
      if (input.reset === true) {
        segments.splice(0);
        totals.documents = 0;
        totals.title = 0;
        totals.body = 0;
        epoch.value = await sha256(`${current.manifest.vectorEpoch}\0reset\0${sequence}`);
      }
      const packs = { value: current.manifest.bloomPacks };
      if (input.reset === true) packs.value = [];
      const projected: { manifest: typeof Root.Type } = {
        manifest: { ...current.manifest, segments, bloomPacks: packs.value },
      };
      const writes: Array<() => Promise<ObjectVersionType | null>> = [];
      const log = {
        version: 1,
        sequence,
        previous: current.manifest.head,
        digest: fingerprint,
        vectorEpoch: epoch.value,
        vectorDeletes,
        write: input,
      } as const;
      const encodedLog = pack(encodeLog(log));
      const logKey = `${this.prefix}/log/${sequence}-${runtime.immutableIdentity(await sha256Bytes(encodedLog))}.bin`;
      writes.push(() => this.env.STORAGE.put(logKey, encodedLog));
      if (input.upserts.length > 0) {
        const built = await Effect.runPromise(
          buildSegment(
            input.upserts.map((document) => nativeToCanonicalDocument(document, sequence)),
            filterableNames(columns),
          ),
        );
        const key = `${this.prefix}/segments/${sequence}-${runtime.immutableIdentity(await sha256Bytes(built.bytes))}.rsix`;
        const headerBytes =
          16 + new DataView(built.bytes.buffer, built.bytes.byteOffset).getUint32(8, true);
        const metadata = {
          key,
          sequence,
          headerBytes,
          bytes: built.bytes.byteLength,
          metadataEnd: headerBytes + built.header.metadata_end,
          count: built.header.documents.length,
          minimumId: built.header.documents[0].id,
          commonTerms: built.commonTerms,
          commonProjection: built.commonProjection,
          commonLeaders: built.commonLeaders,
          constantAttributes: built.constantAttributes,
          eligibility: built.eligibility,
          dead: [],
          removedFrequencies: {},
        };
        writes.push(async () => {
          const stored = await this.env.STORAGE.put(key, built.bytes);
          if (stored === null) return null;
          await Effect.runPromise(
            storeSegmentCaches(
              key,
              headerBytes,
              built.bytes,
              built.commonTerms !== undefined && Object.keys(built.commonTerms).length > 0,
            ),
          );
          projected.manifest = await Effect.runPromise(
            appendBloomSegment(
              this.prefix,
              projected.manifest,
              metadata,
              bloom(built.header.documents.map((document) => document.id)),
              bloom(Object.keys(built.header.terms)),
            ),
          );
          return stored;
        });
        totals.documents += built.header.documents.length;
        totals.title += built.header.total_title_length;
        totals.body += built.header.total_body_length;
      }
      const stored = await Promise.all(writes.map((write) => write()));
      if (stored.some((object) => object === null))
        throw new Rejected({ status: 503, message: "R2 immutable write failed" });
      const jobs = [...current.manifest.vectorJobs];
      if (
        vectorDeletes.length > 0 ||
        input.upserts.some((document) => document.vector !== undefined)
      )
        jobs.push({ log: logKey, sequence });
      const receipt = { sequence, requestId: input.requestId, digest: fingerprint };
      const manifest = {
        schema: columns,
        version: 1,
        sequence,
        head: logKey,
        documents: totals.documents,
        titleLength: totals.title,
        bodyLength: totals.body,
        vectorEpoch: epoch.value,
        vectorJobs: jobs,
        lastReceipt: receipt,
        segments: projected.manifest.segments,
        bloomPacks: projected.manifest.bloomPacks,
      } as const;
      await this.commit(manifest, current.etag);
      await this.persistReceipt(receipt);
      if (input.upserts.length > 0)
        await Effect.runPromise(warmTermBatch(manifest.segments, this.ctx));
      if (jobs.some((job) => job.sequence === sequence))
        await this.enqueue(namespace, { namespace, log: logKey, sequence });
      if (sequence % 16 === 0) await this.enqueueCompaction(namespace, manifest);
      return Schema.encodeSync(WriteResult)({
        sequence,
        requestId: input.requestId,
        vectorSync: "queued",
      });
    }

    private async rebuildVectors(input: typeof VectorRebuild.Type) {
      const fields = vectorFilterNames((await this.root()).manifest.schema) ?? [];
      const snapshot = input.snapshot ?? crypto.randomUUID();
      const key = `${this.prefix}/vector-rebuild/${snapshot}.json`;
      const saved = { root: (await this.root()).manifest, fields };
      if (input.snapshot === undefined) {
        const created = await this.env.STORAGE.put(key, encodeVectorRebuildSnapshot(saved), {
          onlyIf: { etagDoesNotMatch: "*" },
          customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({
            expiresAt: Effect.runSync(Clock.currentTimeMillis) + SNAPSHOT_RETENTION_MS,
          }),
        });
        if (created === null)
          throw new Rejected({ status: 409, message: "Rebuild snapshot identity already exists" });
      } else {
        const object = await this.env.STORAGE.get(key);
        if (object === null)
          throw new Rejected({ status: 410, message: "Rebuild snapshot no longer exists" });
        const now = Effect.runSync(Clock.currentTimeMillis);
        const metadata = Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(
          object.customMetadata,
        );
        if (now >= metadata.expiresAt) {
          await object.body.cancel();
          throw new Rejected({ status: 410, message: "Rebuild snapshot expired after seven days" });
        }
        const prior = decodeVectorRebuildSnapshot(await this.readRebuildCheckpoint(object));
        if (JSON.stringify(prior.fields) !== JSON.stringify(fields))
          throw new Rejected({ status: 409, message: "Indexed fields changed during rebuild" });
        saved.root = prior.root;
      }
      const cursor = { segment: input.segment ?? 0, row: input.row ?? 0 };
      if (cursor.segment > saved.root.segments.length)
        throw new Rejected({ status: 400, message: "Invalid rebuild segment" });
      if (cursor.segment === saved.root.segments.length && cursor.row !== 0)
        throw new Rejected({ status: 400, message: "Invalid completed cursor" });
      const active = (await this.root()).manifest;
      if (active.vectorEpoch !== saved.root.vectorEpoch)
        throw new Rejected({
          status: 409,
          message: "Namespace reset during rebuild; start a new snapshot",
        });
      const budget = { processed: 0, validated: 0 };
      while (cursor.segment < saved.root.segments.length && budget.processed < 100) {
        const segment = saved.root.segments[cursor.segment];
        if (segment === undefined)
          throw new Rejected({ status: 503, message: "Missing rebuild segment" });
        const rows = await Effect.runPromise(
          withDirectory(segment.key, segment.headerBytes, (directory) =>
            Effect.gen(function* () {
              const dead = yield* Schema.encodeEffect(integers)(segment.dead);
              return yield* Schema.decodeEffect(
                Schema.fromJsonString(Schema.Array(SegmentDocument)),
              )(directory.vectors(dead));
            }),
          ),
        );
        if (cursor.row > rows.length)
          throw new Rejected({ status: 400, message: "Invalid rebuild row" });
        const selected = rows.slice(cursor.row, cursor.row + 100 - budget.processed);
        const current = await locate(
          selected.map((row) => row.id),
          active,
        );
        for (const metadata of selected) {
          cursor.row += 1;
          budget.processed += 1;
          const location = current.get(metadata.id);
          if (
            location === undefined ||
            !location.document.vector ||
            location.document.revision !== metadata.revision
          ) {
            continue;
          }
          const document = await readDocument(
            location.segment.key,
            location.segment.headerBytes,
            location.document.data,
            location.segment.bytes,
            location.vectorData,
          );
          if (document.vector === undefined)
            throw new Rejected({ status: 503, message: "Rebuild vector payload missing" });
          if (document.id !== metadata.id || document.revision !== metadata.revision)
            throw new Rejected({
              status: 503,
              message: "Rebuild vector identity differs from its directory",
            });
          budget.validated += 1;
        }
        if (cursor.row === rows.length) {
          cursor.segment += 1;
          cursor.row = 0;
        }
      }
      const complete = cursor.segment === saved.root.segments.length;
      const result = {
        snapshot,
        ...cursor,
        submitted: budget.validated,
        complete,
      };
      if (complete) return Schema.encodeSync(VectorRebuildResult)({ ...result, snapshot: null });
      return Schema.encodeSync(VectorRebuildResult)(result);
    }

    private async synchronizeVectors() {
      const current = await this.root();
      const jobs = current.manifest.vectorJobs.slice(0, 16);
      const completed = new Set<number>();
      for (const job of jobs) {
        const object = await this.env.STORAGE.get(job.log);
        if (object === null)
          throw new Rejected({ status: 503, message: "Committed vector log missing" });
        const log = decodeLog(unpack(new Uint8Array(await object.arrayBuffer())));
        if (log.sequence !== job.sequence)
          throw new Rejected({ status: 503, message: "Vector log sequence mismatch" });
        const candidates = log.write.upserts.filter((document) => document.vector !== undefined);
        if (log.vectorEpoch !== current.manifest.vectorEpoch || candidates.length === 0) {
          completed.add(job.sequence);
          continue;
        }
        const live = await locate(
          candidates.map((document) => document.id),
          current.manifest,
        );
        for (const candidate of candidates) {
          const location = live.get(candidate.id);
          if (
            location === undefined ||
            !location.document.vector ||
            location.document.revision !== log.sequence
          )
            continue;
          const document = await readDocument(
            location.segment.key,
            location.segment.headerBytes,
            location.document.data,
            location.segment.bytes,
            location.vectorData,
          );
          const expected = candidate.vector;
          const actual = document.vector;
          if (
            document.id !== candidate.id ||
            document.revision !== log.sequence ||
            expected === undefined ||
            actual === undefined ||
            actual.length !== expected.length ||
            actual.some(
              (value, index) => Math.fround(value) !== Math.fround(expected[index] ?? Number.NaN),
            )
          )
            throw new Rejected({
              status: 503,
              message: "Canonical vector differs from its committed log",
            });
        }
        completed.add(job.sequence);
      }
      if (completed.size > 0)
        await this.commit(
          {
            ...current.manifest,
            vectorJobs: current.manifest.vectorJobs.filter((job) => !completed.has(job.sequence)),
          },
          current.etag,
        );
      return Schema.encodeSync(VectorSyncResult)({
        submitted: completed.size,
        visibility: "strong",
      });
    }

    private async collect(input: typeof Collection.Type) {
      const position: { value: typeof CollectionCursor.Type } = {
        value: { version: 1, phase: "bloom-packs", cursor: null },
      };
      if (input.cursor !== undefined) {
        const decoded = Schema.decodeExit(Schema.fromJsonString(CollectionCursor))(input.cursor);
        if (decoded._tag === "Failure")
          throw new Rejected({ status: 400, message: "Invalid collection cursor" });
        position.value = decoded.value;
      }
      const captured = await this.root();
      const current = await (async () => {
        if (!runtime.freshRoots || captured.etag === null) return captured;
        return this.commit(
          { ...captured.manifest, collectionFence: crypto.randomUUID() },
          captured.etag,
        );
      })();
      const now = Effect.runSync(Clock.currentTimeMillis);
      const pinned = {
        segments: new Set<string>(),
        "bloom-packs": new Set<string>(),
      };
      const pin = (manifest: typeof Root.Type, source: string) => {
        for (const segment of manifest.segments) pinned.segments.add(segment.key);
        for (const descriptor of manifest.bloomPacks) pinned["bloom-packs"].add(descriptor.key);
        if (pinned.segments.size > 16384 || pinned["bloom-packs"].size > 16384)
          throw new Rejected({
            status: 503,
            message: `${source} references exceed collection memory budget`,
          });
      };
      pin(current.manifest, "Active root");
      for (const manifest of this.readers.values()) pin(manifest, "Reader");
      const counters = { scanned: 0, pinned: 0, marked: 0, deleted: 0, expiredSnapshots: 0 };
      const snapshots: ObjectListOptions = {
        prefix: `${this.prefix}/vector-rebuild/`,
        limit: 100,
        include: ["customMetadata"],
      };
      const checkpointBudget = { count: 0, bytes: 0 };
      for (;;) {
        const page = await this.env.STORAGE.list(snapshots);
        checkpointBudget.count += page.objects.length;
        if (checkpointBudget.count > 1024)
          throw new Rejected({
            status: 503,
            message: "Too many rebuild checkpoints for bounded collection",
          });
        for (const checkpoint of page.objects) {
          const metadata = Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(
            checkpoint.customMetadata,
          );
          if (now >= metadata.expiresAt) {
            await this.env.STORAGE.delete(checkpoint.key);
            counters.expiredSnapshots += 1;
            continue;
          }
          checkpointBudget.bytes += checkpoint.size;
          if (
            checkpoint.size > VECTOR_REBUILD_CHECKPOINT_BYTES ||
            checkpointBudget.bytes > 32 * 1024 * 1024
          )
            throw new Rejected({
              status: 503,
              message: "Rebuild checkpoints exceed collection byte budget",
            });
          const object = await this.env.STORAGE.get(checkpoint.key);
          if (object === null)
            throw new Rejected({
              status: 503,
              message: "Rebuild checkpoint disappeared during collection",
            });
          checkpointBudget.bytes += Math.max(0, object.size - checkpoint.size);
          if (checkpointBudget.bytes > 32 * 1024 * 1024) {
            await object.body.cancel();
            throw new Rejected({
              status: 503,
              message: "Captured rebuild checkpoints exceed collection byte budget",
            });
          }
          pin(
            decodeVectorRebuildSnapshot(await this.readRebuildCheckpoint(object)).root,
            "Checkpoint",
          );
        }
        if (!page.truncated) break;
        snapshots.cursor = page.cursor;
      }
      const continuation: { value: typeof CollectionCursor.Type | null } = { value: null };
      for (const phase of ["bloom-packs", "segments"] as const) {
        if (position.value.phase === "segments" && phase === "bloom-packs") continue;
        const options: ObjectListOptions = { prefix: `${this.prefix}/${phase}/`, limit: 100 };
        if (phase === position.value.phase && position.value.cursor !== null)
          options.cursor = position.value.cursor;
        const page = await this.env.STORAGE.list(options);
        for (const object of page.objects) {
          counters.scanned += 1;
          const markerKey = `${this.prefix}/retired/${await sha256(object.key)}.json`;
          if (pinned[phase].has(object.key)) {
            counters.pinned += 1;
            await this.env.STORAGE.delete(markerKey);
            continue;
          }
          const marker = await this.env.STORAGE.get(markerKey);
          if (marker !== null) {
            const retirement = Schema.decodeSync(Schema.fromJsonString(Retirement))(
              await marker.text(),
            );
            if (retirement.key !== object.key)
              throw new Rejected({
                status: 503,
                message: "Retirement marker belongs to another object",
              });
            if (
              retirement.etag === object.etag &&
              retirement.observedAt >= object.uploaded.getTime() &&
              retirement.observedAt <= now
            ) {
              if (now - retirement.observedAt >= SEGMENT_RETIREMENT_MS) {
                await this.env.STORAGE.delete(object.key);
                await this.env.STORAGE.delete(markerKey);
                counters.deleted += 1;
              }
              continue;
            }
          }
          await this.env.STORAGE.put(
            markerKey,
            Schema.encodeSync(Schema.fromJsonString(Retirement))({
              key: object.key,
              etag: object.etag,
              observedAt: now,
            }),
          );
          counters.marked += 1;
        }
        if (page.truncated) {
          continuation.value = { version: 1, phase, cursor: page.cursor };
          break;
        }
      }
      const cursor: { value: typeof CollectionResult.Type.cursor } = { value: null };
      if (continuation.value !== null) {
        const encoded = Schema.encodeSync(Schema.fromJsonString(CollectionCursor))(
          continuation.value,
        );
        if (!Schema.is(Collection.fields.cursor)(encoded))
          throw new Rejected({ status: 503, message: "Collection cursor exceeds API budget" });
        cursor.value = encoded;
      }
      return Schema.encodeSync(CollectionResult)({ ...counters, cursor: cursor.value });
    }

    private async compact() {
      const current = await this.root();
      const ordered = current.manifest.segments.toSorted(
        (a, b) => a.count - a.dead.length - (b.count - b.dead.length),
      );
      const candidates: typeof ordered = [];
      const budget = { count: 0, bytes: 0 };
      for (const segment of ordered) {
        const count = segment.count - segment.dead.length;
        if (candidates.length >= 8 || budget.count + count > 10000) break;
        candidates.push(segment);
        budget.count += count;
      }
      if (candidates.length < 2 && !candidates.some((segment) => segment.dead.length))
        return { compacted: 0, segments: current.manifest.segments.length };
      const selected: typeof ordered = [];
      const documents: Array<typeof CanonicalDocument.Type> = [];
      const encodeDocument = Schema.encodeSync(Schema.fromJsonString(CanonicalDocument));
      const encoder = new TextEncoder();
      for (const segment of candidates) {
        const window = { documents: documents.length, bytes: budget.bytes, exceeded: false };
        const dead = new Set(segment.dead);
        const rows = Array.from({ length: segment.count }, (_, row) => row).filter(
          (row) => !dead.has(row),
        );
        const metadata = await Effect.runPromise(
          withDirectory(segment.key, segment.headerBytes, (decoded) =>
            Effect.gen(function* () {
              const encoded = yield* Schema.encodeEffect(integers)(rows);
              return yield* Schema.decodeEffect(
                Schema.fromJsonString(Schema.Array(LocatedDocument)),
              )(decoded.rows(encoded));
            }),
          ),
        );
        const payload = await range(
          segment.key,
          segment.headerBytes,
          segment.bytes - segment.headerBytes,
        );
        for (const location of metadata) {
          const document = location.document;
          const source = await readDocument(
            segment.key,
            segment.headerBytes,
            document.data,
            segment.bytes,
            location.vectorData,
            payload,
          );
          const bytes = encoder.encode(encodeDocument(source)).byteLength;
          if (budget.bytes + bytes > 8 * 1024 * 1024) {
            window.exceeded = true;
            break;
          }
          budget.bytes += bytes;
          documents.push(source);
        }
        if (window.exceeded) {
          documents.length = window.documents;
          budget.bytes = window.bytes;
          continue;
        }
        selected.push(segment);
      }
      if (selected.length < 2 && !selected.some((segment) => segment.dead.length))
        return { compacted: 0, segments: current.manifest.segments.length };
      const retained = current.manifest.segments.filter(
        (segment) => !selected.some((source) => source.key === segment.key),
      );
      const projected = {
        manifest: await Effect.runPromise(
          pruneBloomPacks({ ...current.manifest, segments: retained }),
        ),
      };
      if (documents.length > 0) {
        const built = await Effect.runPromise(
          buildSegment(documents, filterableNames(current.manifest.schema)),
        );
        const key = `${this.prefix}/segments/compact-${current.manifest.sequence}-${crypto.randomUUID()}.rsix`;
        const stored = await this.env.STORAGE.put(key, built.bytes);
        if (stored === null)
          throw new Rejected({ status: 503, message: "Compacted R2 segment write failed" });
        await Effect.runPromise(
          storeSegmentCaches(
            key,
            16 + new DataView(built.bytes.buffer, built.bytes.byteOffset).getUint32(8, true),
            built.bytes,
            built.commonTerms !== undefined && Object.keys(built.commonTerms).length > 0,
          ),
        );
        projected.manifest = await Effect.runPromise(
          appendBloomSegment(
            this.prefix,
            projected.manifest,
            {
              key,
              sequence: current.manifest.sequence,
              headerBytes:
                16 + new DataView(built.bytes.buffer, built.bytes.byteOffset).getUint32(8, true),
              bytes: built.bytes.byteLength,
              metadataEnd:
                16 +
                new DataView(built.bytes.buffer, built.bytes.byteOffset).getUint32(8, true) +
                built.header.metadata_end,
              count: built.header.documents.length,
              minimumId: built.header.documents[0].id,
              commonTerms: built.commonTerms,
              commonProjection: built.commonProjection,
              commonLeaders: built.commonLeaders,
              constantAttributes: built.constantAttributes,
              eligibility: built.eligibility,
              dead: [],
              removedFrequencies: {},
            },
            bloom(built.header.documents.map((document) => document.id)),
            bloom(Object.keys(built.header.terms)),
          ),
        );
      }
      await this.commit(projected.manifest, current.etag);
      if (documents.length > 0)
        await Effect.runPromise(warmTermBatch(projected.manifest.segments, this.ctx));
      return {
        compacted: selected.length,
        segments: projected.manifest.segments.length,
        documents: documents.length,
      };
    }

    private perform(command: typeof NamespaceCommand.Type, queryTimings: Headers) {
      const namespace = command.namespace;
      const program = Effect.gen({ self: this }, function* () {
        if (this.namespace !== undefined && this.namespace !== namespace)
          return yield* new Rejected({ status: 403, message: "Coordinator namespace mismatch" });
        this.namespace = namespace;
        const result: { value: typeof RpcValue.Type | undefined } = { value: undefined };
        if (command.operation === "query") {
          const input = command.input;
          const queued = yield* Clock.currentTimeNanos;
          result.value = yield* this.querySlots.withPermit(
            Effect.acquireUseRelease(
              this.withRootPermit(
                Effect.gen({ self: this }, function* () {
                  const admitted = yield* Clock.currentTimeNanos;
                  const started = yield* captureReaderLease;
                  if (runtime.freshRoots) {
                    this.current = undefined;
                    this.acknowledgedReceipt = undefined;
                  }
                  const loaded = yield* finishStrongRead(
                    started,
                    Effect.tryPromise({
                      try: (signal) => this.root(signal),
                      catch: strongQueryFailure,
                    }),
                  ).pipe(Effect.interruptible, Effect.exit);
                  if (Exit.isFailure(loaded)) {
                    this.current = undefined;
                    this.acknowledgedReceipt = undefined;
                    return yield* Effect.failCause(loaded.cause);
                  }
                  const current = loaded.value;
                  const admission = yield* rejectExpiredReader(started).pipe(Effect.exit);
                  if (Exit.isFailure(admission)) {
                    this.current = undefined;
                    this.acknowledgedReceipt = undefined;
                    return yield* Effect.failCause(admission.cause);
                  }
                  const captured = yield* Clock.currentTimeNanos;
                  const lease = Symbol();
                  this.readers.set(lease, current.manifest);
                  return {
                    lease,
                    manifest: current.manifest,
                    wait: Number(admitted - queued) / 1e6,
                    root: Number(captured - admitted) / 1e6,
                    started,
                  };
                }),
              ),
              ({ manifest, wait, root, started }) =>
                finishStrongRead(
                  started,
                  Effect.tryPromise({
                    try: (signal) =>
                      query(input, manifest, this.ctx, queryTimings, this.textExecutions, signal),
                    catch: (cause) => strongQueryFailure(cause),
                  }),
                ).pipe(
                  Effect.map((response) => {
                    queryTimings.append(
                      "server-timing",
                      `query_wait;dur=${wait},query_root;dur=${root}`,
                    );
                    return response;
                  }),
                ),
              ({ lease }) =>
                Effect.sync(() => {
                  this.readers.delete(lease);
                }),
            ),
          );
        } else
          result.value = yield* this.withRootPermit(
            Effect.gen({ self: this }, function* () {
              if (runtime.freshRoots) {
                this.current = undefined;
                this.acknowledgedReceipt = undefined;
              }
              if (command.operation === "migrate-root")
                return yield* Effect.tryPromise({
                  try: () => this.migrateRoot(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              if (command.operation === "write") {
                const input = command.input;
                return yield* Effect.tryPromise({
                  try: () => this.write(input, namespace),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              }
              if (command.operation === "vector-rebuild") {
                const input = command.input;
                return yield* Effect.tryPromise({
                  try: () => this.rebuildVectors(input),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              }
              if (command.operation === "collect") {
                const input = command.input;
                return yield* Effect.tryPromise({
                  try: () => this.collect(input),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              }
              if (command.operation === "hint_cache_warm")
                return yield* Effect.tryPromise({
                  try: () => this.hintCacheWarm(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              if (command.operation === "metadata") {
                const current = yield* Effect.tryPromise({
                  try: () => this.root(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
                const { manifest } = current;
                const manifestEncodedBytes =
                  current.manifestEncodedBytes ??
                  new TextEncoder().encode(encodeRoot(manifest)).byteLength;
                current.manifestEncodedBytes = manifestEncodedBytes;
                return yield* Schema.encodeEffect(Metadata)({
                  schema: Option.match(Option.fromUndefinedOr(manifest.schema), {
                    onNone: () => null,
                    onSome: nativeSchemaFromColumns,
                  }),
                  sequence: manifest.sequence,
                  documents: manifest.documents,
                  segments: manifest.segments.length,
                  manifestEncodedBytes,
                  wasmMemoryBytes: wasm.memory.buffer.byteLength,
                  vectorOutbox: manifest.vectorJobs.length,
                  cache: cacheUsage(),
                });
              }
              if (command.operation === "vector-sync")
                return yield* Effect.tryPromise({
                  try: () => this.synchronizeVectors(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              if (command.operation === "compact")
                return yield* Effect.tryPromise({
                  try: () => this.compact(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              if (command.operation === "internal-compact") {
                const message = command.input;
                if (message.namespace !== namespace)
                  return yield* new Rejected({
                    status: 400,
                    message: "Index job namespace mismatch",
                  });
                const response = yield* Effect.tryPromise({
                  try: () => this.compact(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
                if (response.compacted > 1) {
                  const current = yield* Effect.tryPromise({
                    try: () => this.root(),
                    catch: (cause) => {
                      if (Schema.is(Rejected)(cause)) return cause;
                      return new Cause.UnknownError(cause);
                    },
                  });
                  yield* Effect.tryPromise({
                    try: () => this.enqueueCompaction(namespace, current.manifest),
                    catch: (cause) => {
                      if (Schema.is(Rejected)(cause)) return cause;
                      return new Cause.UnknownError(cause);
                    },
                  });
                }
                return response;
              }
              if (command.operation === "internal-vector-sync") {
                const message = command.input;
                if (message.namespace !== namespace)
                  return yield* new Rejected({
                    status: 400,
                    message: "Vector job namespace mismatch",
                  });
                const current = yield* Effect.tryPromise({
                  try: () => this.root(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
                const job = current.manifest.vectorJobs.find(
                  (pending) => pending.sequence === message.sequence,
                );
                if (job !== undefined && job.log !== message.log)
                  return yield* new Rejected({ status: 400, message: "Vector job log mismatch" });
                if (job === undefined) {
                  const completed = yield* Schema.encodeEffect(VectorSyncResult)({
                    submitted: 0,
                    visibility: "strong",
                  });
                  return completed;
                }
                return yield* Effect.tryPromise({
                  try: () => this.synchronizeVectors(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
              }
              if (command.operation === "rebuild") {
                this.current = undefined;
                this.acknowledgedReceipt = undefined;
                clearImmutableCache(this.prefix);
                const current = yield* Effect.tryPromise({
                  try: () => this.root(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
                if (
                  current.manifest.segments.some(
                    (segment) =>
                      segment.commonTerms === undefined ||
                      segment.commonLeaders === undefined ||
                      segment.constantAttributes === undefined ||
                      segment.commonProjection === undefined,
                  )
                ) {
                  const segments = yield* Effect.forEach(
                    current.manifest.segments,
                    (segment) =>
                      Effect.gen(function* () {
                        if (
                          segment.commonTerms !== undefined &&
                          segment.commonLeaders !== undefined &&
                          segment.constantAttributes !== undefined &&
                          segment.commonProjection !== undefined
                        )
                          return segment;
                        const metadata = yield* Effect.gen(function* () {
                          if (
                            segment.commonTerms !== undefined &&
                            segment.commonLeaders !== undefined &&
                            segment.constantAttributes !== undefined
                          )
                            return {
                              commonTerms: segment.commonTerms,
                              commonLeaders: segment.commonLeaders,
                              constantAttributes: segment.constantAttributes,
                            };
                          return yield* withDirectory(
                            segment.key,
                            segment.headerBytes,
                            (directory) =>
                              Effect.gen(function* () {
                                const commonTerms = yield* Schema.decodeEffect(
                                  Schema.fromJsonString(CommonTerms),
                                )(directory.common_terms());
                                const commonLeaders = yield* Schema.decodeEffect(
                                  Schema.fromJsonString(CommonLeaders),
                                )(directory.common_leaders());
                                const constantAttributes = yield* Schema.decodeEffect(
                                  Schema.fromJsonString(ConstantAttributes),
                                )(directory.constant_attributes());
                                return { commonTerms, commonLeaders, constantAttributes };
                              }),
                            undefined,
                            true,
                          );
                        });
                        const projection = { value: segment.commonProjection };
                        if (projection.value === undefined)
                          projection.value = yield* rebuildCommonProjection({
                            ...segment,
                            ...metadata,
                          });
                        return { ...segment, ...metadata, commonProjection: projection.value };
                      }),
                    { concurrency: 1 },
                  );
                  yield* Effect.tryPromise({
                    try: () => this.commit({ ...current.manifest, segments }, current.etag),
                    catch: (cause) => {
                      if (Schema.is(Rejected)(cause)) return cause;
                      return new Cause.UnknownError(cause);
                    },
                  });
                  clearImmutableCache(this.prefix);
                }
                return yield* Schema.encodeEffect(RebuildResult)({
                  sequence: current.manifest.sequence,
                  rebuilt: true,
                });
              }
              return yield* new Rejected({ status: 404, message: "Unknown operation" });
            }),
          );
        if (result.value === undefined)
          return yield* new Rejected({ status: 503, message: "Operation returned no result" });
        return result.value;
      });
      if (runtime.clock === undefined) return program;
      return Effect.provideService(program, Clock.Clock, runtime.clock);
    }

    async execute(input: typeof RpcCommand.Encoded): Promise<typeof RpcReply.Encoded> {
      const timings = new Headers();
      return Effect.runPromise(
        Schema.decodeUnknownEffect(NamespaceRpcCommand, { onExcessProperty: "error" })(input).pipe(
          Effect.flatMap((command) => this.perform(command, timings)),
          Effect.map((value) => {
            if (input.operation === "query") return { _tag: "Success" as const, value };
            return Schema.encodeSync(RpcReply)({ _tag: "Success", value });
          }),
          Effect.tapError((error) => {
            if (Schema.is(Rejected)(error) && error.status < 500) return Effect.void;
            return Effect.logError("kannin.rpc", Cause.fail(error));
          }),
          Effect.catch((error) => {
            if (input.operation !== "query") {
              this.current = undefined;
              this.acknowledgedReceipt = undefined;
            }
            if (Schema.is(Rejected)(error))
              return Effect.succeed(Schema.encodeSync(RpcReply)({ _tag: "Failure", error }));
            if (Schema.isSchemaError(error))
              return Effect.succeed(
                Schema.encodeSync(RpcReply)({
                  _tag: "Failure",
                  error: new Rejected({ status: 400, message: "Invalid RPC contract" }),
                }),
              );
            return Effect.succeed(
              Schema.encodeSync(RpcReply)({
                _tag: "Failure",
                error: new Rejected({
                  status: 503,
                  message: "Storage or search backend unavailable",
                }),
              }),
            );
          }),
        ),
      );
    }

    override fetch(request: Request) {
      const parts = new URL(request.url).pathname.split("/");
      const operation = parts.at(-1);
      const namespace = parts[3];
      const queryTimings = new Headers();
      return Effect.runPromise(
        Effect.gen({ self: this }, function* () {
          const started = yield* Clock.currentTimeNanos;
          if (!isNamespaceName(namespace))
            return yield* new Rejected({ status: 400, message: "Invalid namespace" });
          const body: { value: unknown } = { value: undefined };
          if (
            request.body !== null ||
            operation === "write" ||
            operation === "query" ||
            operation === "collect" ||
            operation === "vector-rebuild" ||
            operation === "internal-compact" ||
            operation === "internal-vector-sync"
          ) {
            const text = yield* readBody(request);
            body.value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
              text,
            ).pipe(
              Effect.mapError(() => new Rejected({ status: 400, message: "Invalid JSON body" })),
            );
          }
          const command = yield* Schema.decodeUnknownEffect(NamespaceCommand, {
            onExcessProperty: "error",
          })({ namespace, operation, input: body.value }).pipe(
            Effect.mapError(
              () => new Rejected({ status: 400, message: "Invalid operation contract" }),
            ),
          );
          const value = yield* this.perform(command, queryTimings);
          const ended = yield* Clock.currentTimeNanos;
          queryTimings.append("server-timing", `raio;dur=${Number(ended - started) / 1e6}`);
          if (operation === "hint_cache_warm")
            return Response.json(value, { status: 202, headers: queryTimings });
          return Response.json(value, { headers: queryTimings });
        }).pipe(
          Effect.tapError((error) => {
            if (Schema.is(Rejected)(error) && error.status < 500) return Effect.void;
            return Effect.logError("kannin.namespace", Cause.fail(error), { namespace, operation });
          }),
          Effect.catch((error) => {
            if (operation !== "query") {
              this.current = undefined;
              this.acknowledgedReceipt = undefined;
            }
            if (Schema.is(Rejected)(error))
              return Effect.succeed(
                Response.json(
                  Schema.encodeSync(ErrorBody)({ status: "error", error: error.message }),
                  {
                    status: error.status,
                    headers: queryTimings,
                  },
                ),
              );
            return Effect.succeed(
              Response.json(
                Schema.encodeSync(ErrorBody)({
                  status: "error",
                  error: "Storage or search backend unavailable",
                }),
                { status: 503, headers: queryTimings },
              ),
            );
          }),
        ),
      );
    }
  }

  class KanninRpc extends RuntimeEntry<Environment> {
    async execute(input: typeof RpcCommand.Encoded): Promise<typeof RpcReply.Encoded> {
      const env = this.env;
      const ctx = this.ctx;
      return Effect.runPromise(
        Schema.decodeEffect(RpcCommand, { onExcessProperty: "error" })(input).pipe(
          Effect.mapError(() => new Rejected({ status: 400, message: "Invalid RPC contract" })),
          Effect.flatMap(
            Effect.fn("kannin.binding.execute")(function* (command: typeof RpcCommand.Type) {
              if (command.operation === "namespaces") {
                const value = yield* listNamespaces(
                  env.STORAGE,
                  env.STORAGE_CACHE_SCOPE,
                  command.input ?? {},
                );
                return yield* Schema.encodeEffect(RpcReply)({ _tag: "Success", value });
              }
              if (command.operation === "query" && command.input.consistency === "edge-eventual") {
                if (command.input.kind !== "text")
                  return yield* new Rejected({
                    status: 400,
                    message: "Edge consistency is supported for text queries only",
                  });
                const manifest = yield* edgeSnapshot(
                  ctx,
                  env,
                  command.namespace,
                  command.input.minimumSequence ?? 0,
                  new Headers(),
                );
                if (manifest !== undefined) {
                  const value = yield* Effect.tryPromise({
                    try: (signal) =>
                      query(command.input, manifest, ctx, new Headers(), undefined, signal),
                    catch: (cause) => {
                      if (Schema.is(Rejected)(cause)) return cause;
                      return new Cause.UnknownError(cause);
                    },
                  }).pipe(
                    Effect.timeoutOrElse({
                      duration: "30 seconds",
                      orElse: () =>
                        new Rejected({
                          status: 504,
                          message: "Edge query exceeded its 30-second snapshot lease",
                        }),
                    }),
                  );
                  return { _tag: "Success" as const, value };
                }
              }
              const coordinator = runtime.namespace(command.namespace);
              return yield* Effect.tryPromise(async () => coordinator.execute(command));
            }),
          ),
          Effect.catch((error) => {
            if (Schema.is(Rejected)(error))
              return Effect.succeed(Schema.encodeSync(RpcReply)({ _tag: "Failure", error }));
            return Effect.logError("kannin.binding", Cause.fail(error)).pipe(
              Effect.as(
                Schema.encodeSync(RpcReply)({
                  _tag: "Failure",
                  error: new Rejected({
                    status: 503,
                    message: "Storage or search backend unavailable",
                  }),
                }),
              ),
            );
          }),
        ),
      );
    }
  }

  const warmSnapshots = new Map<
    string,
    {
      snapshot: typeof Snapshot.Type;
      payload: Uint8Array<ArrayBuffer>;
      bytes: number;
      etag: ObjectVersionType["etag"] | undefined;
      cacheAttemptedAt: number | undefined;
    }
  >();
  const warmSnapshotBudget = { bytes: 0 };
  const MAX_WARM_SNAPSHOT_BYTES = 24 * 1024 * 1024;
  const SNAPSHOT_PUBLICATION_INTERVAL_MS = 500;

  function rememberSnapshot(
    key: string,
    snapshot: typeof Snapshot.Type,
    payload: Uint8Array<ArrayBuffer>,
    frameBytes: number,
    etag?: ObjectVersionType["etag"],
    cacheAttemptedAt?: number,
  ) {
    const bytes = Math.max(frameBytes, payload.buffer.byteLength) * 4;
    if (bytes > MAX_WARM_SNAPSHOT_BYTES) return false;
    const prior = warmSnapshots.get(key);
    if (
      prior !== undefined &&
      (prior.snapshot.manifest.sequence > snapshot.manifest.sequence ||
        (prior.snapshot.manifest.sequence === snapshot.manifest.sequence &&
          prior.snapshot.observedAt > snapshot.observedAt))
    )
      return false;
    if (prior !== undefined) warmSnapshotBudget.bytes -= prior.bytes;
    warmSnapshots.delete(key);
    warmSnapshots.set(key, { snapshot, payload, bytes, etag, cacheAttemptedAt });
    warmSnapshotBudget.bytes += bytes;
    while (warmSnapshotBudget.bytes > MAX_WARM_SNAPSHOT_BYTES) {
      const oldest = warmSnapshots.entries().next().value;
      if (oldest === undefined) break;
      warmSnapshots.delete(oldest[0]);
      warmSnapshotBudget.bytes -= oldest[1].bytes;
    }
    return true;
  }

  const snapshotMetrics = {
    snapshotR2Reads: 0,
    snapshotR2BodyBytes: 0,
    snapshotRevalidations: 0,
    snapshotLateRetentions: 0,
    snapshotSharedReads: 0,
    snapshotCacheDecodes: 0,
    snapshotCacheRejected: 0,
    snapshotCachePutAttempts: 0,
    snapshotCachePutBytes: 0,
    snapshotCachePutSkipped: 0,
  };
  const snapshotBodyReads = Semaphore.makeUnsafe(64);
  const SNAPSHOT_BODY_UNIT = 64 * 1024;
  const MAX_PENDING_SNAPSHOTS = 64;

  async function acquireSnapshot(
    ctx: BackgroundContext,
    env: Environment,
    namespace: string,
    observedAt: number,
    cacheKey: URL,
    cache: CachePort | undefined,
  ) {
    snapshotMetrics.snapshotR2Reads += 1;
    const previous = warmSnapshots.get(cacheKey.href);
    const key = `namespaces/${namespace}/root.json`;
    const started = Effect.runSync(Clock.currentTimeNanos);
    const object = await Match.value(previous?.etag).pipe(
      Match.when(undefined, () => env.STORAGE.get(key)),
      Match.orElse((etag) => env.STORAGE.get(key, { onlyIf: { etagDoesNotMatch: etag } })),
    );
    const received = Effect.runSync(Clock.currentTimeNanos);
    if (object === null) return undefined;
    const selected = {
      manifest: previous?.snapshot.manifest,
      payload: previous?.payload,
      revalidated: false,
    };
    if ("body" in object) {
      const receivedAt = Effect.runSync(Clock.currentTimeMillis);
      if (
        receivedAt < observedAt ||
        (receivedAt - observedAt >= 1000 && object.size * 4 >= MAX_WARM_SNAPSHOT_BYTES)
      ) {
        await Effect.runPromise(Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore));
        return undefined;
      }
      const units = Math.min(64, Math.max(1, Math.ceil((object.size * 4) / SNAPSHOT_BODY_UNIT)));
      const admitted = await Effect.runPromise(
        snapshotBodyReads.withPermitsIfAvailable(units)(
          Effect.tryPromise(() => {
            snapshotMetrics.snapshotR2BodyBytes += object.size;
            return object.arrayBuffer();
          }).pipe(
            Effect.flatMap((body) => {
              const payload = new Uint8Array(body);
              return decodeRootEffect(new TextDecoder().decode(payload)).pipe(
                Effect.map((manifest) => ({ payload, manifest })),
              );
            }),
            Effect.uninterruptible,
          ),
        ),
      );
      if (Option.isNone(admitted)) {
        await Effect.runPromise(Effect.tryPromise(() => object.body.cancel()).pipe(Effect.ignore));
        return {
          snapshot: undefined,
          revalidated: false,
          r2Ms: Number(received - started) / 1e6,
          bodyMs: 0,
        };
      }
      const decoded = admitted.value;
      selected.manifest = decoded.manifest;
      selected.payload = decoded.payload;
    } else {
      if (previous === undefined || previous.etag !== object.etag)
        throw new Rejected({
          status: 503,
          message: "Conditional R2 read has no matching snapshot",
        });
      snapshotMetrics.snapshotRevalidations += 1;
      selected.revalidated = true;
    }
    const manifest = selected.manifest;
    if (manifest === undefined)
      throw new Rejected({ status: 503, message: "R2 read omitted its manifest" });
    const snapshot = { observedAt, manifest };
    const payload = selected.payload;
    if (payload === undefined)
      throw new Rejected({ status: 503, message: "R2 snapshot omitted its encoded manifest" });
    const decodedAt = Effect.runSync(Clock.currentTimeMillis);
    if (decodedAt < observedAt || decodedAt - observedAt >= 1000) {
      if (
        decodedAt >= observedAt &&
        rememberSnapshot(
          cacheKey.href,
          snapshot,
          payload,
          snapshotFrameHeader(snapshot).size + payload.byteLength,
          object.etag,
        )
      )
        snapshotMetrics.snapshotLateRetentions += 1;
      return {
        snapshot,
        revalidated: selected.revalidated,
        r2Ms: Number(received - started) / 1e6,
        bodyMs: Number(Effect.runSync(Clock.currentTimeNanos) - received) / 1e6,
      };
    }
    const header = snapshotFrameHeader(snapshot);
    const frameBytes = header.size + payload.byteLength;
    const lastAttempt = previous?.cacheAttemptedAt;
    const publish =
      !selected.revalidated ||
      lastAttempt === undefined ||
      observedAt < lastAttempt ||
      observedAt - lastAttempt >= SNAPSHOT_PUBLICATION_INTERVAL_MS;
    const publication = { attemptedAt: lastAttempt };
    if (!selected.revalidated) publication.attemptedAt = undefined;
    if (cache !== undefined && publish) publication.attemptedAt = observedAt;
    const encoded = Match.value(cache !== undefined && publish).pipe(
      Match.when(true, () => new Blob([header, payload], { type: "application/octet-stream" })),
      Match.orElse(() => undefined),
    );
    const prepared = Effect.runSync(Clock.currentTimeNanos);
    rememberSnapshot(
      cacheKey.href,
      snapshot,
      payload,
      frameBytes,
      object.etag,
      publication.attemptedAt,
    );
    if (cache !== undefined && !publish) snapshotMetrics.snapshotCachePutSkipped += 1;
    if (cache !== undefined && encoded !== undefined) {
      snapshotMetrics.snapshotCachePutAttempts += 1;
      snapshotMetrics.snapshotCachePutBytes += encoded.size;
      ctx.waitUntil(
        cache
          .put(
            cacheKey,
            new Response(encoded, {
              headers: {
                "cache-control": "public, max-age=2, must-revalidate",
                "content-type": "application/octet-stream",
                ...Schema.encodeSync(SnapshotCacheHeaders)({
                  "x-raio-observed-at": observedAt,
                  "x-raio-sequence": manifest.sequence,
                }),
              },
            }),
          )
          .catch(() => undefined),
      );
    }
    return {
      snapshot,
      revalidated: selected.revalidated,
      r2Ms: Number(received - started) / 1e6,
      bodyMs: Number(prepared - received) / 1e6,
    };
  }
  const pendingSnapshots = new Map<
    string,
    Promise<
      Exit.Exit<
        Option.Option<Awaited<ReturnType<typeof acquireSnapshot>>>,
        Schema.SchemaError | Cause.UnknownError
      >
    >
  >();
  const refreshSnapshot = Effect.fn("raio.refreshSnapshot")(function* (
    ctx: BackgroundContext,
    env: Environment,
    namespace: string,
    minimumSequence: number,
    cacheKey: URL,
    cache: CachePort | undefined,
    timings?: Headers,
  ) {
    const selected = { read: pendingSnapshots.get(cacheKey.href) };
    if (selected.read === undefined) {
      if (pendingSnapshots.size >= MAX_PENDING_SNAPSHOTS) {
        timings?.append("server-timing", "edge_snapshot_r2_admission");
        return undefined;
      }
      const now = yield* Clock.currentTimeMillis;
      const acquisition = acquireSnapshot(ctx, env, namespace, now, cacheKey, cache);
      const bounded = yield* Effect.forkDetach(
        Effect.tryPromise({
          try: () => acquisition,
          catch: (cause) => {
            if (Schema.isSchemaError(cause)) return cause;
            return new Cause.UnknownError(cause);
          },
        }).pipe(Effect.timeoutOption("900 millis")),
      );
      const completion = new Promise<
        Exit.Exit<
          Option.Option<Awaited<ReturnType<typeof acquireSnapshot>>>,
          Schema.SchemaError | Cause.UnknownError
        >
      >((resolve) => bounded.addObserver(resolve));
      selected.read = completion;
      pendingSnapshots.set(cacheKey.href, completion);
      ctx.waitUntil(
        acquisition
          .finally(() => {
            if (pendingSnapshots.get(cacheKey.href) === completion)
              pendingSnapshots.delete(cacheKey.href);
          })
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    } else snapshotMetrics.snapshotSharedReads += 1;
    const read = selected.read;
    const completed = yield* Effect.tryPromise(() => read);
    if (completed._tag === "Failure") return yield* Effect.failCause(completed.cause);
    const result = completed.value;
    if (Option.isNone(result)) {
      timings?.append("server-timing", "edge_snapshot_r2_timeout");
      return undefined;
    }
    const acquired = result.value;
    if (acquired === undefined) return undefined;
    timings?.append("server-timing", `edge_snapshot_r2;dur=${acquired.r2Ms}`);
    timings?.append("server-timing", `edge_snapshot_body;dur=${acquired.bodyMs}`);
    if (acquired.revalidated) timings?.append("server-timing", "edge_snapshot_revalidated");
    const snapshot = acquired.snapshot;
    if (snapshot === undefined) {
      timings?.append("server-timing", "edge_snapshot_r2_body_admission");
      return undefined;
    }
    if (snapshot.manifest.sequence < minimumSequence) return undefined;
    const selectedAt = yield* Clock.currentTimeMillis;
    if (selectedAt < snapshot.observedAt || selectedAt - snapshot.observedAt >= 1000)
      return undefined;
    return snapshot.manifest;
  });
  async function acquireCachedSnapshot(cacheKey: URL, minimumSequence: number) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* Effect.tryPromise(() => caches.open("raio-snapshots-v6")).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (cache === undefined) return { cache, snapshot: undefined, rejected: false };
        const cached = yield* Effect.tryPromise(() => cache.match(cacheKey)).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (cached === undefined) return { cache, snapshot: undefined, rejected: false };
        const metadata = Schema.decodeUnknownExit(SnapshotCacheHeaders)({
          "x-raio-observed-at": cached.headers.get("x-raio-observed-at"),
          "x-raio-sequence": cached.headers.get("x-raio-sequence"),
        });
        const selectedAt = yield* Clock.currentTimeMillis;
        if (
          metadata._tag !== "Success" ||
          selectedAt < metadata.value["x-raio-observed-at"] ||
          selectedAt - metadata.value["x-raio-observed-at"] >= 1000 ||
          metadata.value["x-raio-sequence"] < minimumSequence
        ) {
          snapshotMetrics.snapshotCacheRejected += 1;
          const body = cached.body;
          if (body !== null) yield* Effect.tryPromise(() => body.cancel()).pipe(Effect.ignore);
          return { cache, snapshot: undefined, rejected: true };
        }
        const encoded = yield* Effect.tryPromise(() => cached.arrayBuffer()).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (encoded === undefined) return { cache, snapshot: undefined, rejected: false };
        snapshotMetrics.snapshotCacheDecodes += 1;
        const decoded = yield* readSnapshotFrame(encoded).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (decoded !== undefined) {
          const decodedAt = yield* Clock.currentTimeMillis;
          if (
            decodedAt < decoded.snapshot.observedAt ||
            decodedAt - decoded.snapshot.observedAt >= 1000 ||
            decoded.snapshot.manifest.sequence < minimumSequence
          ) {
            snapshotMetrics.snapshotCacheRejected += 1;
            return { cache, snapshot: undefined, rejected: true };
          }
          const previous = warmSnapshots.get(cacheKey.href);
          if (
            previous?.etag !== undefined &&
            previous.snapshot.manifest.sequence === decoded.snapshot.manifest.sequence &&
            previous.payload.byteLength === decoded.payload.byteLength &&
            runtime.equalBytes(previous.payload, decoded.payload)
          )
            rememberSnapshot(
              cacheKey.href,
              decoded.snapshot,
              decoded.payload,
              encoded.byteLength,
              previous.etag,
              previous.cacheAttemptedAt,
            );
          else
            rememberSnapshot(cacheKey.href, decoded.snapshot, decoded.payload, encoded.byteLength);
        }
        return { cache, snapshot: decoded?.snapshot, rejected: false };
      }),
    );
  }
  const pendingCachedSnapshots = new Map<
    string,
    Promise<Option.Option<Awaited<ReturnType<typeof acquireCachedSnapshot>>>>
  >();
  const MAX_PENDING_CACHED_SNAPSHOTS = 64;

  const snapshotRefreshes = new Set<string>();

  const edgeSnapshot = Effect.fn("raio.edgeSnapshot")(function* (
    ctx: BackgroundContext,
    env: Environment,
    namespace: string,
    minimumSequence: number,
    timings: Headers,
  ) {
    const cacheKey = new URL(`https://raio-cache.internal/snapshots-v6/${namespace}`);
    cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
    const cache: { value: CachePort | undefined } = { value: undefined };
    const memory = warmSnapshots.get(cacheKey.href);
    const selection = { snapshot: memory?.snapshot };
    const observedAt = yield* Clock.currentTimeMillis;
    if (
      selection.snapshot === undefined ||
      observedAt < selection.snapshot.observedAt ||
      observedAt - selection.snapshot.observedAt >= 1000 ||
      selection.snapshot.manifest.sequence < minimumSequence
    ) {
      selection.snapshot = undefined;
      const cacheStarted = yield* Clock.currentTimeNanos;
      const identity = `${cacheKey.href}/minimumSequence=${minimumSequence}`;
      const pending = pendingCachedSnapshots.get(identity);
      const acquisition = { read: pending };
      if (acquisition.read === undefined) {
        const lookup = acquireCachedSnapshot(cacheKey, minimumSequence);
        const budget = yield* Effect.forkDetach(
          Effect.tryPromise(() => lookup).pipe(
            Effect.timeoutOption("250 millis"),
            Effect.orElseSucceed(() => Option.none()),
          ),
        );
        const bounded = new Promise<
          Option.Option<Awaited<ReturnType<typeof acquireCachedSnapshot>>>
        >((resolve) => {
          budget.addObserver((exit) => {
            if (exit._tag === "Success") resolve(exit.value);
            else resolve(Option.none());
          });
        });
        acquisition.read = bounded;
        if (pendingCachedSnapshots.size < MAX_PENDING_CACHED_SNAPSHOTS)
          pendingCachedSnapshots.set(identity, bounded);
        ctx.waitUntil(
          lookup
            .finally(() => {
              if (pendingCachedSnapshots.get(identity) === bounded)
                pendingCachedSnapshots.delete(identity);
            })
            .then(
              () => undefined,
              () => undefined,
            ),
        );
      }
      const read = acquisition.read;
      const acquired = yield* Effect.tryPromise(() => read);
      const cacheEnded = yield* Clock.currentTimeNanos;
      timings.append(
        "server-timing",
        `edge_snapshot_cache;dur=${Number(cacheEnded - cacheStarted) / 1e6}`,
      );
      if (Option.isSome(acquired)) {
        cache.value = acquired.value.cache;
        selection.snapshot = acquired.value.snapshot;
        if (acquired.value.rejected)
          timings.append("server-timing", "edge_snapshot_cache_rejected");
      } else timings.append("server-timing", "edge_snapshot_cache_timeout");
    }
    const snapshot = selection.snapshot;
    const selectedAt = yield* Clock.currentTimeMillis;
    if (
      snapshot !== undefined &&
      selectedAt >= snapshot.observedAt &&
      selectedAt - snapshot.observedAt < 1000 &&
      snapshot.manifest.sequence >= minimumSequence
    ) {
      const retained = warmSnapshots.get(cacheKey.href);
      if (retained !== undefined) {
        warmSnapshots.delete(cacheKey.href);
        warmSnapshots.set(cacheKey.href, retained);
      }
      if (selectedAt - snapshot.observedAt >= 250 && !snapshotRefreshes.has(cacheKey.href)) {
        snapshotRefreshes.add(cacheKey.href);
        const refresh = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const refreshCache = yield* Effect.tryPromise(() =>
              caches.open("raio-snapshots-v6"),
            ).pipe(Effect.orElseSucceed(() => undefined));
            yield* refreshSnapshot(ctx, env, namespace, 0, cacheKey, refreshCache);
          }).pipe(
            Effect.asVoid,
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => snapshotRefreshes.delete(cacheKey.href))),
          ),
        );
        ctx.waitUntil(
          new Promise<void>((resolve) => {
            refresh.addObserver(() => resolve());
          }),
        );
      }
      return snapshot.manifest;
    }
    return yield* refreshSnapshot(
      ctx,
      env,
      namespace,
      minimumSequence,
      cacheKey,
      cache.value,
      timings,
    );
  });

  const handler = {
    async fetch(request: Request, env: Environment, ctx: BackgroundContext) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json(
          Schema.encodeSync(Health)({
            name: "kannin",
            version: "0.1.0",
            engine: runtime.engineName,
            vectors: runtime.vectorName,
            wasmMemoryBytes: wasm.memory.buffer.byteLength,
            snapshotMemoryChargedBytes: warmSnapshotBudget.bytes,
            snapshotPayloadRetainedBytes: [...warmSnapshots.values()].reduce(
              (total, entry) => total + entry.payload.buffer.byteLength,
              0,
            ),
            ...cacheUsage(),
            ...snapshotMetrics,
          }),
        );
      if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
        return Response.json(
          Schema.encodeSync(ErrorBody)({ status: "error", error: "Unauthorized" }),
          {
            status: 401,
            headers: { "cache-control": "private, no-store" },
          },
        );
      if (url.pathname === "/v1/namespaces" || url.pathname === "/admin/namespaces/catalog") {
        const completing = url.pathname === "/admin/namespaces/catalog";
        if ((completing && request.method !== "POST") || (!completing && request.method !== "GET"))
          return Response.json(
            Schema.encodeSync(ErrorBody)({ status: "error", error: "Method not allowed" }),
            { status: 405, headers: { "cache-control": "private, no-store" } },
          );
        return Effect.runPromise(
          Effect.gen(function* () {
            if (completing) {
              const body = yield* readBody(request);
              yield* Schema.decodeEffect(Schema.fromJsonString(NamespaceCatalogActivation), {
                onExcessProperty: "error",
              })(body).pipe(
                Effect.mapError(
                  () =>
                    new Rejected({ status: 400, message: "Invalid catalog activation contract" }),
                ),
              );
              yield* Effect.tryPromise(() => env.STORAGE.put(namespaceCatalogReadyKey, ""));
              const value = yield* Schema.encodeEffect(NamespaceCatalogActivation)({ version: 1 });
              return Response.json(value, { headers: { "cache-control": "private, no-store" } });
            }
            const keys = [...url.searchParams.keys()];
            if (new Set(keys).size !== keys.length)
              return yield* new Rejected({
                status: 400,
                message: "Duplicate namespace list parameter",
              });
            const input = yield* Schema.decodeEffect(NamespacesQuery, {
              onExcessProperty: "error",
            })(Object.fromEntries(url.searchParams)).pipe(
              Effect.mapError(
                () => new Rejected({ status: 400, message: "Invalid namespace list parameters" }),
              ),
            );
            const value = yield* listNamespaces(env.STORAGE, env.STORAGE_CACHE_SCOPE, input);
            return Response.json(value, { headers: { "cache-control": "private, no-store" } });
          }).pipe(
            Effect.tapError((error) => {
              if (Schema.is(Rejected)(error) && error.status < 500) return Effect.void;
              return Effect.logError("kannin.namespaces.list", error);
            }),
            Effect.catch((error) => {
              if (Schema.is(Rejected)(error))
                return Effect.succeed(
                  Response.json(
                    Schema.encodeSync(ErrorBody)({ status: "error", error: error.message }),
                    { status: error.status, headers: { "cache-control": "private, no-store" } },
                  ),
                );
              return Effect.succeed(
                Response.json(
                  Schema.encodeSync(ErrorBody)({
                    status: "error",
                    error: "Storage or search backend unavailable",
                  }),
                  { status: 503, headers: { "cache-control": "private, no-store" } },
                ),
              );
            }),
          ),
        );
      }
      if (url.pathname === "/admin/namespaces" && request.method === "GET") {
        const options: ObjectListOptions = { prefix: "namespaces/", delimiter: "/", limit: 100 };
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null) options.cursor = cursor;
        return Effect.runPromise(
          Effect.tryPromise(() => env.STORAGE.list(options)).pipe(
            Effect.flatMap((result) =>
              Schema.decodeEffect(Schema.Array(NamespaceName))(
                result.delimitedPrefixes.map((prefix) => prefix.slice("namespaces/".length, -1)),
              ).pipe(
                Effect.map((names) => {
                  if (result.truncated)
                    return Response.json(
                      Schema.encodeSync(NamespacePage)({ names, cursor: result.cursor }),
                      { headers: { "cache-control": "private, no-store" } },
                    );
                  return Response.json(Schema.encodeSync(NamespacePage)({ names, cursor: null }), {
                    headers: { "cache-control": "private, no-store" },
                  });
                }),
              ),
            ),
            Effect.tapError((error) => Effect.logError("kannin.namespaces", error)),
            Effect.orElseSucceed(() =>
              Response.json(
                Schema.encodeSync(ErrorBody)({
                  status: "error",
                  error: "Storage or search backend unavailable",
                }),
                { status: 503, headers: { "cache-control": "private, no-store" } },
              ),
            ),
          ),
        );
      }
      const match = /^\/v1\/namespaces\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (match === null || !isNamespaceName(match[1]) || !isOperation(match[2]))
        return Response.json(
          Schema.encodeSync(ErrorBody)({ status: "error", error: "Unknown route" }),
          {
            status: 404,
          },
        );
      const method = {
        write: "POST",
        query: "POST",
        metadata: "GET",
        hint_cache_warm: "GET",
        "vector-sync": "POST",
        "vector-rebuild": "POST",
        rebuild: "POST",
        compact: "POST",
        collect: "POST",
        "migrate-root": "POST",
      } satisfies Record<typeof Operation.Type, string>;
      if (request.method !== method[match[2]])
        return Response.json(
          Schema.encodeSync(ErrorBody)({ status: "error", error: "Method not allowed" }),
          {
            status: 405,
          },
        );
      const namespace = match[1];
      const operation = match[2];
      const snapshotTimings = new Headers();
      const queryTimings = new Headers();
      const started = Effect.runSync(Clock.currentTimeNanos);
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          if (operation === "query") {
            const body = yield* readBody(request.clone());
            const input = yield* decodeQuery(body).pipe(
              Effect.mapError(
                () => new Rejected({ status: 400, message: "Invalid query contract" }),
              ),
            );
            if (input.consistency === "edge-eventual") {
              if (input.kind !== "text")
                return yield* new Rejected({
                  status: 400,
                  message: "Edge consistency is supported for text queries only",
                });
              const snapshotStarted = yield* Clock.currentTimeNanos;
              const manifest = yield* edgeSnapshot(
                ctx,
                env,
                namespace,
                input.minimumSequence ?? 0,
                snapshotTimings,
              );
              const snapshotEnded = yield* Clock.currentTimeNanos;
              if (manifest !== undefined) {
                const evaluated = yield* Effect.tryPromise({
                  try: (signal) => query(input, manifest, ctx, queryTimings, undefined, signal),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: "30 seconds",
                    orElse: () =>
                      Effect.fail(
                        new Rejected({
                          status: 504,
                          message: "Edge query exceeded its 30-second snapshot lease",
                        }),
                      ),
                  }),
                );
                queryTimings.append(
                  "server-timing",
                  `edge_snapshot;dur=${Number(snapshotEnded - snapshotStarted) / 1e6}`,
                );
                return Response.json(evaluated, { headers: queryTimings });
              }
              snapshotTimings.append(
                "server-timing",
                `edge_snapshot_fallback;dur=${Number(snapshotEnded - snapshotStarted) / 1e6}`,
              );
            }
          }
          return yield* Effect.tryPromise(() => runtime.namespace(namespace).fetch(request));
        }).pipe(
          Effect.tapError((error) => {
            if (Schema.is(Rejected)(error) && error.status < 500) return Effect.void;
            return Effect.logError("kannin.gateway", Cause.fail(error), { namespace, operation });
          }),
          Effect.catch((error) => {
            if (Schema.is(Rejected)(error))
              return Effect.succeed(
                Response.json(
                  Schema.encodeSync(ErrorBody)({ status: "error", error: error.message }),
                  {
                    status: error.status,
                  },
                ),
              );
            return Effect.succeed(
              Response.json(
                Schema.encodeSync(ErrorBody)({
                  status: "error",
                  error: "Storage or search backend unavailable",
                }),
                { status: 503 },
              ),
            );
          }),
        ),
      );
      const ended = Effect.runSync(Clock.currentTimeNanos);
      const outgoing = new Response(response.body, response);
      outgoing.headers.set("cache-control", "private, no-store");
      if (!response.ok) {
        const partial = queryTimings.get("server-timing");
        if (partial !== null) outgoing.headers.append("server-timing", partial);
      }
      const snapshotTiming = snapshotTimings.get("server-timing");
      if (snapshotTiming !== null) outgoing.headers.append("server-timing", snapshotTiming);
      outgoing.headers.append("server-timing", `gateway;dur=${Number(ended - started) / 1e6}`);
      return outgoing;
    },
    async queue(batch: JobBatch, _env: Environment) {
      await Effect.runPromise(
        Effect.forEach(
          batch.messages,
          Effect.fn("kannin.consumeJob")(
            function* (message) {
              const input = yield* Schema.decodeUnknownEffect(
                Schema.Union([VectorMessage, IndexMessage]),
                { onExcessProperty: "error" },
              )(message.body);
              const stub = runtime.namespace(input.namespace);
              const response = yield* Match.value(input).pipe(
                Match.when(
                  (job) => "log" in job,
                  (job) =>
                    Schema.encodeEffect(Schema.fromJsonString(VectorMessage))(job).pipe(
                      Effect.flatMap((body) =>
                        Effect.tryPromise(() =>
                          stub.fetch(
                            `http://internal/v1/namespaces/${job.namespace}/internal-vector-sync`,
                            {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body,
                            },
                          ),
                        ),
                      ),
                    ),
                ),
                Match.orElse((job) =>
                  Schema.encodeEffect(Schema.fromJsonString(IndexMessage))(job).pipe(
                    Effect.flatMap((body) =>
                      Effect.tryPromise(() =>
                        stub.fetch(
                          `http://internal/v1/namespaces/${job.namespace}/internal-compact`,
                          {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body,
                          },
                        ),
                      ),
                    ),
                  ),
                ),
              );
              yield* Effect.tryPromise(() => response.arrayBuffer());
              if (!response.ok) {
                message.retry();
                return;
              }
              message.ack();
            },
            (effect, message) =>
              effect.pipe(Effect.catch(() => Effect.sync(() => message.retry()))),
          ),
          { concurrency: 4 },
        ),
      );
    },
  };

  return { Segments, Terms, SearchNamespace, KanninRpc, handler };
}
