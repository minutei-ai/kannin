import { DurableObject, WorkerEntrypoint, env as workerEnv } from "cloudflare:workers";
import {
  Array as EffectArray,
  Cause,
  Clock,
  Effect,
  Match,
  Option,
  Schema,
  Semaphore,
} from "effect";
import type { Env } from "../alchemy.run";
import {
  initSync,
  pack,
  unpack,
  tokenize,
  segment_document_terms,
  segment_filter,
  segment_term_bounds,
  PreparedQuery,
  directory_compress,
} from "../dist/wasm/raio_engine";
import module from "raio:wasm";
import type { Row, Snapshot, TextPlan } from "./protocol";
import {
  Attributes,
  Filter,
  StoredDocument,
  ErrorBody,
  Log,
  Metadata,
  Health,
  NamespaceName,
  Operation,
  Query,
  QueryResult,
  Receipt,
  Rejected,
  Root,
  SnapshotCacheHeaders,
  SegmentDocument,
  DataRange,
  SegmentHits,
  PostingSpans,
  TermCatalog,
  TermCatalogBatch,
  LocatedDocument,
  RankingInput,
  SearchStatistics,
  TextPlanIdentity,
  SharedTextPlan,
  Write,
  WriteResult,
  VectorMessage,
  VectorSyncResult,
  VectorFilterFields,
  VectorSelection,
  VectorCandidates,
  VectorRebuild,
  VectorRebuildSnapshot,
  VectorRebuildResult,
  NamespacePage,
  Collection,
  CollectionResult,
  Retirement,
  IndexMessage,
  SegmentRange,
  TermProjectionProps,
  SegmentCacheProps,
} from "./protocol";
import {
  range,
  withDirectory,
  readTermCatalogs,
  addFrequencyPosting,
  readTermProjections,
  buildSegment,
  bloom,
  bloomCandidates,
  readDocument,
  readDocuments,
  sha256,
  clearImmutableCache,
  cacheUsage,
  segmentScoreBound,
  rememberSegmentScoreBound,
  textPlan,
  rememberTextPlan,
} from "./storage";

import { vectorMetadata, vectorPrefilter } from "./vector-filters";

import { snapshotFrameHeader, readSnapshotFrame } from "./snapshot";

const wasm = initSync({ module });
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SEGMENT_RETIREMENT_MS = 24 * 60 * 60 * 1000;

export class Segments extends WorkerEntrypoint<Env, typeof SegmentCacheProps.Type> {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const props = Schema.decodeExit(SegmentCacheProps)(this.ctx.props);
    const decoded = Schema.decodeUnknownExit(SegmentRange)({
      key: url.searchParams.get("key"),
      offset: Number(url.searchParams.get("offset")),
      length: Number(url.searchParams.get("length")),
    });
    if (
      decoded._tag === "Failure" ||
      request.method !== "GET" ||
      props._tag === "Failure" ||
      props.value.bucket !== this.env.STORAGE_CACHE_SCOPE ||
      (url.pathname !== "/range" && url.pathname !== "/directory-v1") ||
      (url.pathname === "/directory-v1" && decoded.value.offset !== 0)
    )
      return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
    const input = decoded.value;
    const cacheKey = new URL(request.url);
    cacheKey.hostname = "raio-cache.internal";
    cacheKey.searchParams.set("bucket", this.env.STORAGE_CACHE_SCOPE);
    const cache = await Effect.runPromise(
      Effect.tryPromise(() => caches.open("raio-segments-v1")).pipe(
        Effect.orElseSucceed(() => undefined),
      ),
    );
    if (cache !== undefined) {
      const cached = await Effect.runPromise(
        Effect.tryPromise(() => cache.match(cacheKey)).pipe(Effect.orElseSucceed(() => undefined)),
      );
      if (cached !== undefined) {
        const response = new Response(cached.body, cached);
        response.headers.delete("cf-cache-status");
        response.headers.set("x-raio-cache", "api-hit");
        return response;
      }
    }
    const object = await this.env.STORAGE.get(input.key, {
      range: { offset: input.offset, length: input.length },
    });
    if (object === null)
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== input.length)
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    const encoded = Match.value(url.pathname).pipe(
      Match.when("/directory-v1", () => directory_compress(new Uint8Array(bytes)).slice()),
      Match.orElse(() => bytes),
    );
    const response = new Response(encoded, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "content-length": String(encoded.byteLength),
        etag: object.httpEtag,
      },
    });
    if (cache !== undefined)
      this.ctx.waitUntil(
        Effect.runPromise(
          Effect.tryPromise(() => cache.put(cacheKey, response.clone())).pipe(Effect.ignore),
        ),
      );
    return response;
  }
}
const decodeRoot = Schema.decodeSync(Schema.fromJsonString(Root));
const encodeRoot = Schema.encodeSync(Schema.fromJsonString(Root));
const decodeLog = Schema.decodeSync(Schema.fromJsonString(Log));
const encodeLog = Schema.encodeSync(Schema.fromJsonString(Log));
const decodeQuery = Schema.decodeEffect(Schema.fromJsonString(Query), {
  onExcessProperty: "error",
});
const encodeQueryResult = Schema.encodeSync(QueryResult);
const decodePostingSpans = Schema.decodeEffect(Schema.fromJsonString(PostingSpans));
const decodeSegmentHits = Schema.decodeEffect(Schema.fromJsonString(SegmentHits));
const encodeRankingInput = Schema.encodeSync(Schema.fromJsonString(RankingInput));
const isNamespaceName = Schema.is(NamespaceName);
const isOperation = Schema.is(Operation);
export class Terms extends WorkerEntrypoint<Env, typeof TermProjectionProps.Encoded> {
  override async fetch(request: Request) {
    const props = Schema.decodeExit(TermProjectionProps)(this.ctx.props);
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      props._tag === "Failure" ||
      url.pathname !== "/catalog-v4" ||
      props.value.bucket !== this.env.STORAGE_CACHE_SCOPE
    )
      return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
    const encodedTerms = this.ctx.props.terms;
    const encodedFilters = this.ctx.props.filters;
    const cacheKey = new URL(request.url);
    cacheKey.hostname = "raio-terms.internal";
    cacheKey.searchParams.set("bucket", props.value.bucket);
    cacheKey.searchParams.set(
      "ranges",
      await sha256(
        Schema.encodeSync(Schema.fromJsonString(TermProjectionProps.fields.ranges))(
          props.value.ranges,
        ),
      ),
    );
    cacheKey.searchParams.set(
      "selector",
      await sha256(`${encodedTerms}\0${this.ctx.props.filters}`),
    );
    const cache = await Effect.runPromise(
      Effect.tryPromise(() => caches.open("raio-terms-v4")).pipe(
        Effect.orElseSucceed(() => undefined),
      ),
    );
    if (cache !== undefined) {
      const cached = await Effect.runPromise(
        Effect.tryPromise(() => cache.match(cacheKey)).pipe(Effect.orElseSucceed(() => undefined)),
      );
      if (cached !== undefined) {
        const response = new Response(cached.body, cached);
        response.headers.delete("cf-cache-status");
        response.headers.set("x-raio-cache", "terms-api-hit");
        return response;
      }
    }
    const response = await Effect.runPromise(
      readTermProjections(props.value.ranges, encodedTerms, encodedFilters).pipe(
        Effect.flatMap(Schema.encodeEffect(TermCatalogBatch)),
        Effect.map((dictionary) =>
          Response.json(dictionary, {
            headers: { "cache-control": "public, max-age=31536000, immutable" },
          }),
        ),
        Effect.tapError((error) =>
          Effect.logError("kannin.termProjection", { ranges: props.value.ranges, error }),
        ),
        Effect.orElseSucceed(() =>
          Response.json(
            Schema.encodeSync(ErrorBody)({ error: "Immutable term catalog unavailable" }),
            { status: 503, headers: { "cache-control": "no-store" } },
          ),
        ),
      ),
    );
    if (response.ok && cache !== undefined)
      this.ctx.waitUntil(
        Effect.runPromise(
          Effect.tryPromise(() => cache.put(cacheKey, response.clone())).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
        ),
      );
    return response;
  }
}

const strings = Schema.fromJsonString(Schema.Array(Schema.String));
const integers = Schema.fromJsonString(Schema.Array(Schema.Int));
const Located = LocatedDocument.mapFields((fields) => ({
  ...fields,
  segment: Schema.Struct({
    key: Schema.String,
    sequence: Schema.Int,
    headerBytes: Schema.Int,
    bytes: Schema.Int,
  }),
}));

const readBody = Effect.fn("raio.readBody")(function* (request: Pick<Request, "headers" | "body">) {
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

async function locate(ids: ReadonlyArray<string>, root: typeof Root.Type) {
  const found = new Map<string, typeof Located.Type>();
  for (const offset of Array.from(
    { length: Math.ceil(root.segments.length / 64) },
    (_, index) => (Math.ceil(root.segments.length / 64) - index - 1) * 64,
  )) {
    const segments = root.segments.slice(offset, offset + 64).toReversed();
    const remaining = ids.filter((id) => !found.has(id));
    if (remaining.length === 0) break;
    const matches = bloomCandidates(
      root.segments,
      remaining,
      "documentBloom",
      offset,
      64,
    ).toReversed();
    for (const [index, segment] of segments.entries()) {
      const selected = matches[index];
      if (selected === undefined)
        throw new Rejected({ status: 503, message: "Bloom batch omitted a segment" });
      const candidates = selected.filter((id) => !found.has(id));
      if (candidates.length === 0) continue;
      const rows = await Effect.runPromise(
        withDirectory(segment.key, segment.headerBytes, (decoded) =>
          Effect.gen(function* () {
            const lookup = yield* Schema.encodeEffect(strings)(candidates);
            const dead = yield* Schema.encodeEffect(integers)(segment.dead);
            return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
              decoded.lookup(lookup, dead),
            );
          }),
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

async function textQuery(input: typeof Query.Type, root: typeof Root.Type, timings: Headers) {
  const started = Effect.runSync(Clock.currentTimeNanos);
  if (input.kind === "vector") return [];
  const words = tokenize(input.text).split(" ").filter(Boolean);
  const terms = [...new Set(words)];
  if (terms.length > 64 || (input.match === "phrase" && words.length > 64))
    throw new Rejected({ status: 400, message: "Query exceeds 64 normalized terms" });
  if (terms.length === 0 || root.documents === 0) return [];
  const bloomMatches = bloomCandidates(root.segments, terms, "termBloom");
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
  const selected = candidates
    .filter((candidate) => candidate.terms.length > 0)
    .map((candidate) => candidate.segment);
  const reuse = { plan: "bypass", bounds: 0 };
  const shared: { cache: Cache | undefined; key: URL | undefined } = {
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
      text: input.text,
      mode: input.match ?? "any",
      filters: input.filters,
      documents: root.documents,
      titleLength: root.titleLength,
      bodyLength: root.bodyLength,
      segments: selected,
    });
    planning.key = `${workerEnv.STORAGE_CACHE_SCOPE}:${firstSelected.key}/plan:${await sha256(identity)}`;
    planning.value = textPlan(planning.key);
    shared.key = new URL("https://raio-cache.internal/text-plans-v1");
    shared.key.searchParams.set("identity", planning.key);
    shared.key.searchParams.set("version", workerEnv.CF_VERSION_METADATA.id);
    reuse.plan = "memory";
    if (planning.value === undefined) {
      reuse.plan = "miss";
      shared.cache = await Effect.runPromise(
        Effect.tryPromise(() => caches.open("kannin-text-plans-v1")).pipe(
          Effect.orElseSucceed(() => undefined),
        ),
      );
      if (shared.cache !== undefined) {
        const cache = shared.cache;
        const cacheKey = shared.key;
        const cached = await Effect.runPromise(
          Effect.tryPromise(() => cache.match(cacheKey)).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
        );
        if (cached !== undefined) {
          const length = Number(cached.headers.get("content-length"));
          if (Number.isSafeInteger(length) && length > 0 && length <= 256 * 1024) {
            const decoded = await Effect.runPromise(
              Effect.tryPromise(() => cached.arrayBuffer()).pipe(
                Effect.flatMap((buffer) =>
                  Effect.try(() => {
                    if (
                      buffer.byteLength !== length ||
                      buffer.byteLength < 16 ||
                      new DataView(buffer).getUint32(8, true) > 1024 * 1024
                    )
                      return undefined;
                    return unpack(new Uint8Array(buffer));
                  }),
                ),
                Effect.flatMap((encoded) => {
                  if (encoded === undefined || encoded.length > 1024 * 1024)
                    return Effect.succeed(Option.none<typeof SharedTextPlan.Type>());
                  return Schema.decodeEffect(Schema.fromJsonString(SharedTextPlan))(encoded).pipe(
                    Effect.asSome,
                  );
                }),
                Effect.orElseSucceed(() => Option.none()),
              ),
            );
            if (
              Option.isSome(decoded) &&
              decoded.value.identity === planning.key &&
              decoded.value.version === workerEnv.CF_VERSION_METADATA.id &&
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
    }
  }
  if (planning.value === undefined) {
    const projectionTerms = Schema.encodeSync(TermProjectionProps.fields.terms)(terms.toSorted());
    const encodedFilters = Schema.encodeSync(TermProjectionProps.fields.filters)(input.filters);
    const projections = await Effect.runPromise(
      readTermCatalogs(selected, projectionTerms, encodedFilters),
    );
    const catalog = selected.map((segment, index) => {
      const projection = projections[index];
      if (projection === undefined)
        throw new Rejected({ status: 503, message: "Term projection batch omitted a segment" });
      return { segment, dictionary: projection.dictionary, minimum: projection.minimum };
    });
    const frequencies = new Map<string, number>();
    for (const { segment, dictionary } of catalog) {
      const removedFrequencies = new Map(Object.entries(segment.removedFrequencies));
      for (const [term, metadata] of Object.entries(dictionary))
        frequencies.set(
          term,
          (frequencies.get(term) ?? 0) + metadata.df - (removedFrequencies.get(term) ?? 0),
        );
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
    for (const offset of Array.from(
      { length: Math.ceil(catalog.length / 64) },
      (_, index) => index * 64,
    )) {
      const window = catalog.slice(offset, offset + 64);
      const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Array(TermCatalog)))(
        window.map((entry) => ({ dictionary: entry.dictionary, minimum: entry.minimum })),
      );
      const bounds = Schema.decodeSync(Schema.Array(Schema.Finite))(
        Array.from(segment_term_bounds(encodedStatistics, encoded)),
      );
      if (bounds.length !== window.length)
        throw new Rejected({ status: 503, message: "Term bound batch omitted a segment" });
      segments.push(
        ...window.map((entry, index) => {
          const bound = bounds[index];
          if (bound === undefined)
            throw new Rejected({ status: 503, message: "Term bound batch omitted a segment" });
          const eligibility = {
            value: entry.minimum !== null && Object.keys(entry.dictionary).length > 0,
          };
          if (
            (input.match === "all" || input.match === "phrase") &&
            terms.some((term) => {
              const metadata = entry.dictionary[term];
              return (
                metadata === undefined ||
                metadata.df <= (entry.segment.removedFrequencies[term] ?? 0)
              );
            })
          )
            eligibility.value = false;
          return { bound, eligible: eligibility.value };
        }),
      );
    }
    planning.value = { statistics, segments };
    if (planning.key !== undefined) rememberTextPlan(planning.key, planning.value);
  }
  const plan = planning.value;
  const statistics = plan.statistics;
  const selection = { digest: "" };
  if (selected.length > 4)
    selection.digest = await sha256(
      encodeRankingInput({
        text: input.text,
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
    const retained = { bound: planned.bound };
    if (selection.digest !== "") {
      const learned = segmentScoreBound(identity);
      if (learned !== undefined) {
        retained.bound = Math.min(planned.bound, learned);
        reuse.bounds += 1;
      }
    }
    return { segment, index, eligible: planned.eligible, bound: retained.bound, identity };
  });
  const prioritized = bounded.sort((left, right) => {
    if (left.bound !== right.bound) return right.bound - left.bound;
    if (left.segment.minimumId < right.segment.minimumId) return -1;
    if (left.segment.minimumId > right.segment.minimumId) return 1;
    return 0;
  });
  timings.append(
    "server-timing",
    `text_plan;desc="${reuse.plan}", text_bound_hits;desc="${reuse.bounds}"`,
  );
  const dictionaryEnded = Effect.runSync(Clock.currentTimeNanos);
  timings.append("server-timing", `text_directory;dur=${Number(dictionaryEnded - started) / 1e6}`);
  const ranked: Array<{
    segment: (typeof Root.Type)["segments"][number];
    row: number;
    id: string;
    score: number;
  }> = [];
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
  };
  using plans = new DisposableStack();
  const compilation: { query: PreparedQuery | undefined } = { query: undefined };
  const rankIo = Semaphore.makeUnsafe(4);
  const rankingWindows = [
    ...EffectArray.chunksOf(prioritized.slice(0, 4), 1),
    ...EffectArray.chunksOf(prioritized.slice(4), 4),
  ];
  for (const rankingWindow of rankingWindows) {
    const cutoff = ranked[input.topK - 1];
    const eligible = rankingWindow.filter(({ segment, eligible: allowed, bound }) => {
      if (!allowed) return false;
      if (ranked.length === input.topK) {
        if (cutoff === undefined)
          throw new Rejected({ status: 503, message: "Invalid ranking cutoff" });
        if (
          bound + 1e-12 < cutoff.score ||
          (bound === cutoff.score && segment.minimumId >= cutoff.id)
        )
          return false;
      }
      return true;
    });
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
    const batches = await Effect.runPromise(
      Effect.forEach(
        eligible,
        ({ segment, identity }) => {
          const dead = Schema.encodeSync(integers)(segment.dead);
          const prepareStarted = Effect.runSync(Clock.currentTimeNanos);
          return withDirectory(
            segment.key,
            segment.headerBytes,
            (decoded) =>
              Effect.acquireUseRelease(
                Effect.sync(() => decoded.ranker_prepared(prepared, dead)),
                (ranker) =>
                  Effect.gen(function* () {
                    rankMetrics.prepare += (yield* Clock.currentTimeNanos) - prepareStarted;
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
                        previous.gaps + span.offset - previous.end <= 4096 &&
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
                                try: () =>
                                  range(
                                    segment.key,
                                    segment.headerBytes + group.offset,
                                    group.end - group.offset,
                                  ),
                                catch: (cause) => {
                                  if (Schema.is(Rejected)(cause)) return cause;
                                  return new Cause.UnknownError(cause);
                                },
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
                          const bytes = posting.bytes.subarray(start, start + block.data.length);
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
                    const scoreStarted = yield* Clock.currentTimeNanos;
                    const hits = yield* decodeSegmentHits(ranker.finish());
                    if (selection.digest !== "") {
                      const upper = { score: cutoff?.score ?? 0 };
                      for (const hit of hits) upper.score = Math.max(upper.score, hit.score);
                      rememberSegmentScoreBound(identity, upper.score);
                    }
                    rankMetrics.score += (yield* Clock.currentTimeNanos) - scoreStarted;
                    rankMetrics.segments += 1;
                    return hits;
                  }),
                (ranker) => Effect.sync(() => ranker.free()),
              ),
            rankIo,
          ).pipe(Effect.map((hits) => hits.map((hit) => ({ ...hit, segment }))));
        },
        { concurrency: 4 },
      ),
    );
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
      if (upper !== undefined && original !== undefined && upper < original.bound) {
        tightened[entry.index] = { bound: upper, eligible: original.eligible };
        publication.improved = true;
      }
    }
    if (publication.improved || reuse.plan === "miss") {
      const value = { statistics, segments: tightened };
      rememberTextPlan(planning.key, value);
      const encoded = Schema.encodeSync(Schema.fromJsonString(SharedTextPlan))({
        identity: planning.key,
        version: workerEnv.CF_VERSION_METADATA.id,
        plan: value,
      });
      if (new TextEncoder().encode(encoded).byteLength <= 1024 * 1024) {
        const packed = pack(encoded);
        if (packed.byteLength <= 256 * 1024) {
          if (shared.cache === undefined)
            shared.cache = await Effect.runPromise(
              Effect.tryPromise(() => caches.open("kannin-text-plans-v1")).pipe(
                Effect.orElseSucceed(() => undefined),
              ),
            );
          if (shared.cache !== undefined) {
            const cache = shared.cache;
            const cacheKey = shared.key;
            const putStarted = Effect.runSync(Clock.currentTimeNanos);
            const published = await Effect.runPromise(
              Effect.tryPromise(() =>
                cache.put(
                  cacheKey,
                  new Response(new Uint8Array(packed), {
                    headers: {
                      "cache-control": "public, max-age=3600",
                      "content-type": "application/octet-stream",
                      "content-length": String(packed.byteLength),
                    },
                  }),
                ),
              ).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              ),
            );
            const putEnded = Effect.runSync(Clock.currentTimeNanos);
            timings.append(
              "server-timing",
              `text_plan_put;dur=${Number(putEnded - putStarted) / 1e6}`,
            );
            if (published) timings.append("server-timing", "text_plan_published");
          }
        }
      }
    }
  }
  timings.append("server-timing", `text_rank;dur=${Number(rankingEnded - dictionaryEnded) / 1e6}`);
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
  const hits = ranked.slice(0, input.topK);
  const windows = EffectArray.chunksOf(hits, 4).flatMap((window) => {
    const first = window[0];
    if (first === undefined) return [];
    const physicalRows = window.map((hit) => hit.row).toSorted((left, right) => left - right);
    const firstRow = physicalRows[0];
    if (
      window.every(
        (hit) =>
          hit.segment.key === first.segment.key &&
          hit.segment.headerBytes === first.segment.headerBytes &&
          hit.segment.bytes === first.segment.bytes,
      ) &&
      physicalRows.every((row, index) => firstRow !== undefined && row === firstRow + index)
    )
      return [window];
    return window.map((hit) => [hit]);
  });
  const batches = await Effect.runPromise(
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(4);
      return yield* Effect.forEach(
        windows,
        (window) =>
          Effect.gen(function* () {
            const first = window[0];
            if (first === undefined) return [];
            const pages = yield* permits.withPermit(
              withDirectory(first.segment.key, first.segment.headerBytes, (decoded) =>
                Effect.gen(function* () {
                  const encoded = yield* Schema.encodeEffect(integers)(
                    window.map((hit) => hit.row),
                  );
                  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(DataRange)))(
                    decoded.document_ranges(encoded),
                  );
                }),
              ),
            );
            if (pages.length !== window.length)
              return yield* new Rejected({ status: 503, message: "Document ranges omitted a hit" });
            const documents = yield* readDocuments(
              first.segment.key,
              first.segment.headerBytes,
              pages,
              first.segment.bytes,
              permits,
            );
            return yield* Effect.forEach(documents, (document, index) =>
              Effect.gen(function* () {
                const hit = window[index];
                if (hit === undefined)
                  return yield* new Rejected({
                    status: 503,
                    message: "Document batch omitted its hit",
                  });
                return {
                  id: document.id,
                  title: document.title ?? "",
                  text: document.text,
                  attributes: document.attributes,
                  revision: document.revision,
                  score: hit.score,
                };
              }),
            );
          }),
        { concurrency: 4 },
      );
    }),
  );
  const rows = batches.flat();
  const documentsEnded = Effect.runSync(Clock.currentTimeNanos);
  timings.append(
    "server-timing",
    `text_documents;dur=${Number(documentsEnded - rankingEnded) / 1e6}`,
  );
  return rows;
}

async function vectorQuery(
  env: Env,
  input: typeof Query.Type,
  root: typeof Root.Type,
  timings: Headers,
) {
  if (input.kind === "text") return [];
  if (input.vector.length !== 768)
    throw new Rejected({ status: 400, message: "Vector dimension must be 768" });
  if (input.topK > 50)
    throw new Rejected({
      status: 400,
      message: "Vector and hybrid topK is limited to 50 by the Vectorize metadata contract",
    });
  if (root.documents === 0) return [];
  const encodedFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(
    input.filters,
  );
  const fields = Schema.decodeSync(Schema.fromJsonString(VectorFilterFields))(
    env.VECTOR_FILTER_FIELDS,
  );
  const prefilter = await Effect.runPromise(vectorPrefilter(input.filters, fields));
  const options: VectorizeQueryOptions = {
    namespace: root.vectorEpoch,
    topK: 50,
    returnMetadata: "all",
  };
  if (Object.keys(prefilter).length > 0) options.filter = prefilter;
  const indexStarted = Effect.runSync(Clock.currentTimeNanos);
  const selector = Schema.encodeSync(Schema.fromJsonString(VectorSelection))({
    epoch: root.vectorEpoch,
    sequence: root.sequence,
    pending: root.vectorJobs,
    vector: input.vector,
    filters: input.filters,
    fields,
  });
  const cacheKey = new URL(`https://raio-cache.internal/vectors-v1/${await sha256(selector)}`);
  cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
  const cache = await Effect.runPromise(
    Effect.tryPromise(() => caches.open("kannin-vectors-v1")).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  const candidates: { value: typeof VectorCandidates.Type | undefined } = { value: undefined };
  if (cache !== undefined) {
    const cached = await Effect.runPromise(
      Effect.tryPromise(() => cache.match(cacheKey)).pipe(Effect.orElseSucceed(() => undefined)),
    );
    if (cached !== undefined) {
      const decoded = await Effect.runPromise(
        Effect.tryPromise(() => cached.text()).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(VectorCandidates))),
          Effect.orElseSucceed(() => undefined),
        ),
      );
      candidates.value = decoded;
    }
  }
  if (candidates.value === undefined) {
    const result = await env.VECTORS.query([...input.vector], options);
    candidates.value = Schema.decodeUnknownSync(VectorCandidates)(result.matches);
    timings.append("server-timing", 'vector_cache;desc="miss"');
    if (cache !== undefined && candidates.value.length > 0) {
      const encoded = Schema.encodeSync(Schema.fromJsonString(VectorCandidates))(candidates.value);
      await Effect.runPromise(
        Effect.tryPromise(() =>
          cache.put(
            cacheKey,
            new Response(encoded, {
              headers: { "cache-control": "public, max-age=1", "content-type": "application/json" },
            }),
          ),
        ).pipe(Effect.ignore),
      );
    }
  } else timings.append("server-timing", 'vector_cache;desc="hit"');
  const indexEnded = Effect.runSync(Clock.currentTimeNanos);
  timings.append("server-timing", `vector_index;dur=${Number(indexEnded - indexStarted) / 1e6}`);
  const metadata = candidates.value.map((match) => ({ match, metadata: match.metadata }));
  const eligible = [];
  const cursor = { offset: 0 };
  while (cursor.offset < metadata.length && eligible.length < input.topK) {
    const window = metadata.slice(
      cursor.offset,
      cursor.offset + Math.max(4, input.topK - eligible.length),
    );
    cursor.offset += window.length;
    const current = await locate(
      window.map((item) => item.metadata.id),
      root,
    );
    const validated = await Effect.runPromise(
      Effect.forEach(
        window,
        (item) =>
          Effect.gen(function* () {
            const location = current.get(item.metadata.id);
            if (
              location === undefined ||
              location.document.revision !== item.metadata.revision ||
              !location.document.vector
            )
              return Option.none();
            const expected = yield* Effect.tryPromise(() =>
              vectorId(root.vectorEpoch, item.metadata.id, item.metadata.revision),
            );
            if (item.match.id !== expected) return Option.none();
            const attributes = yield* Schema.encodeEffect(Schema.fromJsonString(Attributes))(
              location.document.attributes,
            );
            if (!segment_filter(attributes, encodedFilters)) return Option.none();
            return Option.some({ location, score: item.match.score });
          }),
        { concurrency: 4 },
      ).pipe(Effect.map(EffectArray.getSomes)),
    );
    eligible.push(...validated);
  }
  const reconciled = Effect.runSync(Clock.currentTimeNanos);
  timings.append("server-timing", `vector_reconcile;dur=${Number(reconciled - indexEnded) / 1e6}`);
  const windows = EffectArray.chunksOf(eligible.slice(0, input.topK), 4).flatMap((window) => {
    const first = window[0];
    if (first === undefined) return [];
    const physicalRows = window
      .map((item) => item.location.row)
      .toSorted((left, right) => left - right);
    const firstRow = physicalRows[0];
    if (
      window.every(
        (item) =>
          item.location.segment.key === first.location.segment.key &&
          item.location.segment.headerBytes === first.location.segment.headerBytes &&
          item.location.segment.bytes === first.location.segment.bytes,
      ) &&
      physicalRows.every((row, index) => firstRow !== undefined && row === firstRow + index)
    )
      return [window];
    return window.map((item) => [item]);
  });
  const batches = await Effect.runPromise(
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(4);
      return yield* Effect.forEach(
        windows,
        (window) =>
          Effect.gen(function* () {
            const first = window[0];
            if (first === undefined) return [];
            const documents = yield* readDocuments(
              first.location.segment.key,
              first.location.segment.headerBytes,
              window.map((item) => item.location.document.data),
              first.location.segment.bytes,
              permits,
            );
            return yield* Effect.forEach(documents, (document, index) =>
              Effect.gen(function* () {
                const item = window[index];
                if (item === undefined)
                  return yield* new Rejected({
                    status: 503,
                    message: "Vector document batch omitted its candidate",
                  });
                return {
                  id: document.id,
                  title: document.title ?? "",
                  text: document.text,
                  attributes: document.attributes,
                  revision: document.revision,
                  score: item.score,
                };
              }),
            );
          }),
        { concurrency: 4 },
      );
    }),
  );
  const rows = batches.flat();
  const materialized = Effect.runSync(Clock.currentTimeNanos);
  timings.append(
    "server-timing",
    `vector_documents;dur=${Number(materialized - reconciled) / 1e6}`,
  );
  return rows;
}

async function query(env: Env, input: typeof Query.Type, manifest: typeof Root.Type) {
  if (manifest.sequence < (input.minimumSequence ?? 0))
    throw new Rejected({ status: 409, message: "Requested sequence is not committed" });
  const timings = new Headers();
  if (input.kind === "text") {
    const rows = await textQuery(input, manifest, timings);
    return Response.json(
      encodeQueryResult({
        rows,
        sequence: manifest.sequence,
        consistency: input.consistency ?? "strong",
      }),
      { headers: timings },
    );
  }
  const [text, vectors] = await Promise.all([
    textQuery(input, manifest, timings),
    vectorQuery(env, input, manifest, timings),
  ]);
  const scores = new Map<string, typeof Row.Type>();
  if (input.kind === "hybrid") {
    for (const list of [text, vectors])
      for (const [rank, row] of list.entries())
        scores.set(row.id, { ...row, score: (scores.get(row.id)?.score ?? 0) + 1 / (61 + rank) });
  } else for (const row of [...text, ...vectors]) scores.set(row.id, row);
  const rows = [...scores.values()]
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    })
    .slice(0, input.topK);
  return Response.json(
    encodeQueryResult({
      rows,
      sequence: manifest.sequence,
      consistency: "vectorize-eventual",
    }),
    { headers: timings },
  );
}

export class SearchNamespace extends DurableObject<Env> {
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private readonly querySlots = Semaphore.makeUnsafe(4);
  private readonly readers = new Map<symbol, typeof Root.Type>();
  private namespace: typeof NamespaceName.Type | undefined;
  private acknowledgedReceipt: typeof Receipt.Type | undefined;
  private current: { manifest: typeof Root.Type; etag: string | null } | undefined;

  private get prefix() {
    if (this.namespace === undefined) throw new Error("Namespace must be bound before R2 access");
    return `namespaces/${this.namespace}`;
  }

  private async root() {
    if (this.current !== undefined) return this.current;
    const object = await this.env.STORAGE.get(`${this.prefix}/root.json`);
    if (object !== null) {
      this.current = { manifest: decodeRoot(await object.text()), etag: object.etag };
      return this.current;
    }
    const acknowledged = await this.env.STORAGE.list({
      prefix: `${this.prefix}/receipts/`,
      limit: 1,
    });
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
      segments: [],
    };
    this.current = { manifest, etag: null };
    return this.current;
  }

  private async commit(manifest: typeof Root.Type, etag: string | null) {
    this.current = undefined;
    const condition = { etagDoesNotMatch: "*" };
    const options = { onlyIf: condition };
    const content = encodeRoot(manifest);
    const result: { object: R2Object | null } = { object: null };
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
    this.acknowledgedReceipt = receipt;
  }

  private async enqueue(namespace: string, job: typeof VectorMessage.Type) {
    await this.env.VECTOR_JOBS.send(Schema.encodeSync(VectorMessage)({ ...job, namespace }));
  }

  private async enqueueCompaction(namespace: string, root: typeof Root.Type) {
    const target = Math.max(32, Math.ceil(root.documents / 10000) * 2);
    if (root.segments.length > target)
      await this.env.INDEX_JOBS.send(Schema.encodeSync(IndexMessage)({ namespace }));
  }

  private async write(input: typeof Write.Type, namespace: string) {
    const ids = [...input.upserts.map((document) => document.id), ...input.deletes];
    if (new Set(ids).size !== ids.length)
      throw new Rejected({ status: 400, message: "Duplicate ids within a write" });
    if (input.reset !== true && ids.length === 0)
      throw new Rejected({ status: 400, message: "Empty write" });
    for (const document of input.upserts)
      if (document.vector !== undefined && document.vector.length !== 768)
        throw new Rejected({ status: 400, message: "Vector dimension must be 768" });
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
      const pending = current.manifest.vectorJobs.find((job) => job.sequence === receipt.sequence);
      if (pending !== undefined) await this.enqueue(namespace, { namespace, ...pending });
      if (receipt.sequence % 16 === 0) await this.enqueueCompaction(namespace, current.manifest);
      return Response.json(
        Schema.encodeSync(WriteResult)({
          sequence: receipt.sequence,
          requestId: input.requestId,
          vectorSync: "queued",
        }),
      );
    }
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
      );
      const terms = Schema.decodeSync(strings)(
        segment_document_terms(Schema.encodeSync(Schema.fromJsonString(StoredDocument))(source)),
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
    if (input.reset === true) {
      segments.splice(0);
      totals.documents = 0;
      totals.title = 0;
      totals.body = 0;
      epoch.value = await sha256(`${current.manifest.vectorEpoch}\0reset\0${sequence}`);
    }
    const writes: Array<() => Promise<R2Object | null>> = [];
    const logKey = `${this.prefix}/log/${sequence}-${fingerprint}.bin`;
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
    writes.push(() => this.env.STORAGE.put(logKey, encodedLog));
    if (input.upserts.length > 0) {
      const built = await Effect.runPromise(
        buildSegment(input.upserts.map((document) => ({ ...document, revision: sequence }))),
      );
      const key = `${this.prefix}/segments/${sequence}-${fingerprint}.rsix`;
      writes.push(() => this.env.STORAGE.put(key, built.bytes));
      const headerBytes =
        16 + new DataView(built.bytes.buffer, built.bytes.byteOffset).getUint32(8, true);
      segments.push({
        key,
        sequence,
        headerBytes,
        bytes: built.bytes.byteLength,
        count: built.header.documents.length,
        minimumId: built.header.documents[0].id,
        documentBloom: bloom(built.header.documents.map((document) => document.id)),
        termBloom: bloom(Object.keys(built.header.terms)),
        dead: [],
        removedFrequencies: {},
      });
      totals.documents += built.header.documents.length;
      totals.title += built.header.total_title_length;
      totals.body += built.header.total_body_length;
    }
    const stored = await Promise.all(writes.map((write) => write()));
    if (stored.some((object) => object === null))
      throw new Rejected({ status: 503, message: "R2 immutable write failed" });
    const jobs = [...current.manifest.vectorJobs];
    if (vectorDeletes.length > 0 || input.upserts.some((document) => document.vector !== undefined))
      jobs.push({ log: logKey, sequence });
    const receipt = { sequence, requestId: input.requestId, digest: fingerprint };
    const manifest = {
      version: 1,
      sequence,
      head: logKey,
      documents: totals.documents,
      titleLength: totals.title,
      bodyLength: totals.body,
      vectorEpoch: epoch.value,
      vectorJobs: jobs,
      lastReceipt: receipt,
      segments,
    } as const;
    await this.commit(manifest, current.etag);
    await this.persistReceipt(receipt);
    if (jobs.some((job) => job.sequence === sequence))
      await this.enqueue(namespace, { namespace, log: logKey, sequence });
    if (sequence % 16 === 0) await this.enqueueCompaction(namespace, manifest);
    return Response.json(
      Schema.encodeSync(WriteResult)({
        sequence,
        requestId: input.requestId,
        vectorSync: "queued",
      }),
    );
  }

  private async rebuildVectors(input: typeof VectorRebuild.Type) {
    const fields = Schema.decodeSync(Schema.fromJsonString(VectorFilterFields))(
      this.env.VECTOR_FILTER_FIELDS,
    );
    const snapshot = input.snapshot ?? crypto.randomUUID();
    const key = `${this.prefix}/vector-rebuild/${snapshot}.json`;
    const saved = { root: (await this.root()).manifest, fields };
    if (input.snapshot === undefined) {
      await this.env.STORAGE.put(
        key,
        Schema.encodeSync(Schema.fromJsonString(VectorRebuildSnapshot))(saved),
        { onlyIf: { etagDoesNotMatch: "*" } },
      );
    } else {
      const object = await this.env.STORAGE.get(key);
      if (object === null)
        throw new Rejected({ status: 410, message: "Rebuild snapshot no longer exists" });
      const now = Effect.runSync(Clock.currentTimeMillis);
      if (now - object.uploaded.getTime() >= SNAPSHOT_RETENTION_MS)
        throw new Rejected({ status: 410, message: "Rebuild snapshot expired after seven days" });
      const prior = Schema.decodeSync(Schema.fromJsonString(VectorRebuildSnapshot))(
        await object.text(),
      );
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
    const vectors: VectorizeVector[] = [];
    const removed: string[] = [];
    const budget = { processed: 0 };
    while (cursor.segment < saved.root.segments.length && budget.processed < 100) {
      const segment = saved.root.segments[cursor.segment];
      if (segment === undefined)
        throw new Rejected({ status: 503, message: "Missing rebuild segment" });
      const rows = await Effect.runPromise(
        withDirectory(segment.key, segment.headerBytes, (directory) =>
          Effect.gen(function* () {
            const dead = yield* Schema.encodeEffect(integers)(segment.dead);
            return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(SegmentDocument)))(
              directory.vectors(dead),
            );
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
          removed.push(await vectorId(saved.root.vectorEpoch, metadata.id, metadata.revision));
          continue;
        }
        const document = await readDocument(
          location.segment.key,
          location.segment.headerBytes,
          location.document.data,
          location.segment.bytes,
        );
        if (document.vector === undefined)
          throw new Rejected({ status: 503, message: "Rebuild vector payload missing" });
        vectors.push({
          id: await vectorId(saved.root.vectorEpoch, document.id, document.revision),
          values: [...document.vector],
          namespace: saved.root.vectorEpoch,
          metadata: {
            id: document.id,
            revision: document.revision,
            ...(await Effect.runPromise(vectorMetadata(document.attributes, fields))),
          },
        });
      }
      if (cursor.row === rows.length) {
        cursor.segment += 1;
        cursor.row = 0;
      }
    }
    if (removed.length > 0) await this.env.VECTORS.deleteByIds(removed);
    if (vectors.length > 0) await this.env.VECTORS.upsert(vectors);
    const complete = cursor.segment === saved.root.segments.length;
    const result = {
      snapshot,
      ...cursor,
      submitted: vectors.length,
      complete,
    };
    if (complete)
      return Response.json(Schema.encodeSync(VectorRebuildResult)({ ...result, snapshot: null }));
    return Response.json(Schema.encodeSync(VectorRebuildResult)(result));
  }

  private async synchronizeVectors() {
    const current = await this.root();
    const jobs = current.manifest.vectorJobs.slice(0, 16);
    const vectors: VectorizeVector[] = [];
    const deletes: string[] = [];
    const completed = new Set<number>();
    const fields = Schema.decodeSync(Schema.fromJsonString(VectorFilterFields))(
      this.env.VECTOR_FILTER_FIELDS,
    );
    for (const job of jobs) {
      const object = await this.env.STORAGE.get(job.log);
      if (object === null)
        throw new Rejected({ status: 503, message: "Committed vector log missing" });
      const log = decodeLog(unpack(new Uint8Array(await object.arrayBuffer())));
      if (log.sequence !== job.sequence)
        throw new Rejected({ status: 503, message: "Vector log sequence mismatch" });
      for (const id of log.vectorDeletes) {
        deletes.push(id);
        if (deletes.length === 100) await this.env.VECTORS.deleteByIds(deletes.splice(0));
      }
      const candidates = log.write.upserts.filter((document) => document.vector !== undefined);
      if (log.vectorEpoch !== current.manifest.vectorEpoch || candidates.length === 0) {
        completed.add(job.sequence);
        continue;
      }
      const live = await locate(
        candidates.map((document) => document.id),
        current.manifest,
      );
      for (const document of candidates)
        if (
          document.vector !== undefined &&
          live.get(document.id)?.document.revision === log.sequence &&
          live.get(document.id)?.document.vector === true
        ) {
          vectors.push({
            id: await vectorId(log.vectorEpoch, document.id, log.sequence),
            values: [...document.vector],
            namespace: log.vectorEpoch,
            metadata: {
              id: document.id,
              revision: log.sequence,
              ...(await Effect.runPromise(vectorMetadata(document.attributes, fields))),
            },
          });
          if (vectors.length === 100) await this.env.VECTORS.upsert(vectors.splice(0));
        }
      completed.add(job.sequence);
    }
    if (deletes.length > 0) await this.env.VECTORS.deleteByIds(deletes);
    if (vectors.length > 0) await this.env.VECTORS.upsert(vectors);
    if (completed.size > 0)
      await this.commit(
        {
          ...current.manifest,
          vectorJobs: current.manifest.vectorJobs.filter((job) => !completed.has(job.sequence)),
        },
        current.etag,
      );
    return Response.json(
      Schema.encodeSync(VectorSyncResult)({
        submitted: completed.size,
        visibility: "vectorize-eventual",
      }),
    );
  }

  private async collect(input: typeof Collection.Type) {
    const current = await this.root();
    const now = Effect.runSync(Clock.currentTimeMillis);
    if (current.manifest.segments.length > 16384)
      throw new Rejected({
        status: 503,
        message: "Active root exceeds collection reference budget",
      });
    const pinned = new Set(current.manifest.segments.map((segment) => segment.key));
    for (const manifest of this.readers.values())
      for (const segment of manifest.segments) {
        pinned.add(segment.key);
        if (pinned.size > 16384)
          throw new Rejected({
            status: 503,
            message: "Reader references exceed collection memory budget",
          });
      }
    const counters = { scanned: 0, pinned: 0, marked: 0, deleted: 0, expiredSnapshots: 0 };
    const snapshots: R2ListOptions = { prefix: `${this.prefix}/vector-rebuild/`, limit: 100 };
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
        if (now - checkpoint.uploaded.getTime() >= SNAPSHOT_RETENTION_MS) {
          await this.env.STORAGE.delete(checkpoint.key);
          counters.expiredSnapshots += 1;
          continue;
        }
        checkpointBudget.bytes += checkpoint.size;
        if (checkpoint.size > 8 * 1024 * 1024 || checkpointBudget.bytes > 32 * 1024 * 1024)
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
        const saved = Schema.decodeSync(Schema.fromJsonString(VectorRebuildSnapshot))(
          await object.text(),
        );
        for (const segment of saved.root.segments) {
          pinned.add(segment.key);
          if (pinned.size > 16384)
            throw new Rejected({
              status: 503,
              message: "Checkpoint references exceed collection memory budget",
            });
        }
      }
      if (!page.truncated) break;
      snapshots.cursor = page.cursor;
    }
    const options: R2ListOptions = { prefix: `${this.prefix}/segments/`, limit: 100 };
    if (input.cursor !== undefined) options.cursor = input.cursor;
    const page = await this.env.STORAGE.list(options);
    for (const object of page.objects) {
      counters.scanned += 1;
      const markerKey = `${this.prefix}/retired/${await sha256(object.key)}.json`;
      if (pinned.has(object.key)) {
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
            message: "Retirement marker belongs to another segment",
          });
        if (retirement.etag === object.etag && retirement.observedAt <= now) {
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
    if (page.truncated)
      return Response.json(
        Schema.encodeSync(CollectionResult)({ ...counters, cursor: page.cursor }),
      );
    return Response.json(Schema.encodeSync(CollectionResult)({ ...counters, cursor: null }));
  }

  private async compact() {
    const current = await this.root();
    const ordered = current.manifest.segments.toSorted(
      (a, b) => a.count - a.dead.length - (b.count - b.dead.length),
    );
    const selected: typeof ordered = [];
    const budget = { count: 0, bytes: 0 };
    for (const segment of ordered) {
      const count = segment.count - segment.dead.length;
      if (selected.length >= 8 || budget.count + count > 10000) break;
      selected.push(segment);
      budget.count += count;
    }
    if (selected.length < 2 && !selected.some((segment) => segment.dead.length))
      return Response.json({ compacted: 0, segments: current.manifest.segments.length });
    const documents: Array<typeof StoredDocument.Type> = [];
    for (const segment of selected) {
      const dead = new Set(segment.dead);
      const rows = Array.from({ length: segment.count }, (_, row) => row).filter(
        (row) => !dead.has(row),
      );
      const metadata = await Effect.runPromise(
        withDirectory(segment.key, segment.headerBytes, (decoded) =>
          Effect.gen(function* () {
            const encoded = yield* Schema.encodeEffect(integers)(rows);
            return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(SegmentDocument)))(
              decoded.rows(encoded),
            );
          }),
        ),
      );
      const payload = await range(
        segment.key,
        segment.headerBytes,
        segment.bytes - segment.headerBytes,
      );
      for (const document of metadata) {
        const source = await readDocument(
          segment.key,
          segment.headerBytes,
          document.data,
          segment.bytes,
          payload,
        );
        budget.bytes += new TextEncoder().encode(
          Schema.encodeSync(Schema.fromJsonString(StoredDocument))(source),
        ).byteLength;
        if (budget.bytes > 8 * 1024 * 1024)
          throw new Rejected({
            status: 413,
            message: "Compaction window exceeds its 8 MiB decoded-document budget",
          });
        documents.push(source);
      }
    }
    const retained = current.manifest.segments.filter(
      (segment) => !selected.some((source) => source.key === segment.key),
    );
    if (documents.length > 0) {
      const built = await Effect.runPromise(buildSegment(documents));
      const key = `${this.prefix}/segments/compact-${current.manifest.sequence}-${crypto.randomUUID()}.rsix`;
      const stored = await this.env.STORAGE.put(key, built.bytes);
      if (stored === null)
        throw new Rejected({ status: 503, message: "Compacted R2 segment write failed" });
      retained.push({
        key,
        sequence: current.manifest.sequence,
        headerBytes:
          16 + new DataView(built.bytes.buffer, built.bytes.byteOffset).getUint32(8, true),
        bytes: built.bytes.byteLength,
        count: built.header.documents.length,
        minimumId: built.header.documents[0].id,
        documentBloom: bloom(built.header.documents.map((document) => document.id)),
        termBloom: bloom(Object.keys(built.header.terms)),
        dead: [],
        removedFrequencies: {},
      });
    }
    await this.commit({ ...current.manifest, segments: retained }, current.etag);
    return Response.json({
      compacted: selected.length,
      segments: retained.length,
      documents: documents.length,
    });
  }

  override fetch(request: Request) {
    const parts = new URL(request.url).pathname.split("/");
    const operation = parts.at(-1);
    const namespace = parts[3];
    if (!isNamespaceName(namespace))
      return Promise.resolve(
        Response.json(Schema.encodeSync(ErrorBody)({ error: "Invalid namespace" }), {
          status: 400,
        }),
      );
    if (this.namespace !== undefined && this.namespace !== namespace)
      return Promise.resolve(
        Response.json(Schema.encodeSync(ErrorBody)({ error: "Coordinator namespace mismatch" }), {
          status: 403,
        }),
      );
    this.namespace = namespace;
    const program = Effect.gen({ self: this }, function* () {
      const started = yield* Clock.currentTimeNanos;
      const body = { text: "" };
      if (
        operation === "write" ||
        operation === "query" ||
        operation === "vector-rebuild" ||
        operation === "collect" ||
        operation === "internal-vector-sync" ||
        operation === "internal-compact"
      )
        body.text = yield* readBody(request);
      if (
        (operation === "compact" || operation === "vector-sync" || operation === "rebuild") &&
        request.body !== null
      ) {
        const text = yield* readBody(request);
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({})), {
          onExcessProperty: "error",
        })(text).pipe(
          Effect.mapError(
            () => new Rejected({ status: 400, message: "This operation accepts no parameters" }),
          ),
        );
      }
      const result: { response: Response | undefined } = { response: undefined };
      if (operation === "query") {
        const input = yield* decodeQuery(body.text).pipe(
          Effect.mapError(() => new Rejected({ status: 400, message: "Invalid query contract" })),
        );
        const queued = yield* Clock.currentTimeNanos;
        result.response = yield* this.querySlots.withPermit(
          Effect.acquireUseRelease(
            this.semaphore.withPermit(
              Effect.gen({ self: this }, function* () {
                const admitted = yield* Clock.currentTimeNanos;
                const current = yield* Effect.tryPromise({
                  try: () => this.root(),
                  catch: (cause) => {
                    if (Schema.is(Rejected)(cause)) return cause;
                    return new Cause.UnknownError(cause);
                  },
                });
                const captured = yield* Clock.currentTimeNanos;
                const lease = Symbol();
                this.readers.set(lease, current.manifest);
                return {
                  lease,
                  manifest: current.manifest,
                  wait: Number(admitted - queued) / 1e6,
                  root: Number(captured - admitted) / 1e6,
                };
              }),
            ),
            ({ manifest, wait, root }) =>
              Effect.tryPromise({
                try: async () => {
                  const response = await query(this.env, input, manifest);
                  response.headers.append(
                    "server-timing",
                    `query_wait;dur=${wait},query_root;dur=${root}`,
                  );
                  return response;
                },
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              }),
            ({ lease }) =>
              Effect.sync(() => {
                this.readers.delete(lease);
              }),
          ),
        );
      } else
        result.response = yield* this.semaphore.withPermit(
          Effect.gen({ self: this }, function* () {
            if (operation === "write") {
              const input = yield* Schema.decodeEffect(Schema.fromJsonString(Write), {
                onExcessProperty: "error",
              })(body.text).pipe(
                Effect.mapError(
                  () => new Rejected({ status: 400, message: "Invalid write contract" }),
                ),
              );
              return yield* Effect.tryPromise({
                try: () => this.write(input, namespace),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
            }
            if (operation === "vector-rebuild") {
              const input = yield* Schema.decodeEffect(Schema.fromJsonString(VectorRebuild), {
                onExcessProperty: "error",
              })(body.text).pipe(
                Effect.mapError(
                  () => new Rejected({ status: 400, message: "Invalid rebuild cursor" }),
                ),
              );
              return yield* Effect.tryPromise({
                try: () => this.rebuildVectors(input),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
            }
            if (operation === "collect") {
              const input = yield* Schema.decodeEffect(Schema.fromJsonString(Collection), {
                onExcessProperty: "error",
              })(body.text).pipe(
                Effect.mapError(
                  () => new Rejected({ status: 400, message: "Invalid collection cursor" }),
                ),
              );
              return yield* Effect.tryPromise({
                try: () => this.collect(input),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
            }
            if (operation === "metadata") {
              const { manifest } = yield* Effect.tryPromise({
                try: () => this.root(),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
              return Response.json(
                yield* Schema.encodeEffect(Metadata)({
                  sequence: manifest.sequence,
                  documents: manifest.documents,
                  segments: manifest.segments.length,
                  manifestEncodedBytes: new TextEncoder().encode(encodeRoot(manifest)).byteLength,
                  vectorOutbox: manifest.vectorJobs.length,
                  cache: cacheUsage(),
                }),
              );
            }
            if (operation === "vector-sync")
              return yield* Effect.tryPromise({
                try: () => this.synchronizeVectors(),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
            if (operation === "compact")
              return yield* Effect.tryPromise({
                try: () => this.compact(),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
            if (operation === "internal-compact") {
              const message = yield* Schema.decodeEffect(Schema.fromJsonString(IndexMessage), {
                onExcessProperty: "error",
              })(body.text);
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
              const outcome = yield* Effect.tryPromise({
                try: () => response.clone().json(),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
              const progress = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ compacted: Schema.Int }),
              )(outcome);
              if (progress.compacted > 1) {
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
            if (operation === "internal-vector-sync") {
              const message = yield* Schema.decodeEffect(Schema.fromJsonString(VectorMessage))(
                body.text,
              );
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
                  visibility: "vectorize-eventual",
                });
                return Response.json(completed);
              }
              return yield* Effect.tryPromise({
                try: () => this.synchronizeVectors(),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
            }
            if (operation === "rebuild") {
              this.current = undefined;
              this.acknowledgedReceipt = undefined;
              clearImmutableCache(this.prefix);
              const { manifest } = yield* Effect.tryPromise({
                try: () => this.root(),
                catch: (cause) => {
                  if (Schema.is(Rejected)(cause)) return cause;
                  return new Cause.UnknownError(cause);
                },
              });
              return Response.json({ sequence: manifest.sequence, rebuilt: true });
            }
            return yield* new Rejected({ status: 404, message: "Unknown operation" });
          }),
        );
      const delivered = result.response;
      const ended = yield* Clock.currentTimeNanos;
      delivered.headers.append("server-timing", `raio;dur=${Number(ended - started) / 1e6}`);
      return delivered;
    }).pipe(
      Effect.tapError((error) => {
        if (Schema.is(Rejected)(error) && error.status < 500) return Effect.void;
        return Effect.logError("kannin.namespace", { namespace, operation, error });
      }),
      Effect.catch((error) => {
        if (operation !== "query") {
          this.current = undefined;
          this.acknowledgedReceipt = undefined;
        }
        if (Schema.is(Rejected)(error))
          return Effect.succeed(
            Response.json(Schema.encodeSync(ErrorBody)({ error: error.message }), {
              status: error.status,
            }),
          );
        return Effect.succeed(
          Response.json(
            Schema.encodeSync(ErrorBody)({ error: "Storage or search backend unavailable" }),
            { status: 503 },
          ),
        );
      }),
    );
    return Effect.runPromise(program);
  }
}

const warmSnapshots = new Map<
  string,
  {
    snapshot: typeof Snapshot.Type;
    payload: Uint8Array<ArrayBuffer>;
    bytes: number;
    etag: R2Object["etag"] | undefined;
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
  etag?: R2Object["etag"],
  cacheAttemptedAt?: number,
) {
  const prior = warmSnapshots.get(key);
  if (prior !== undefined) warmSnapshotBudget.bytes -= prior.bytes;
  warmSnapshots.delete(key);
  const bytes = Math.max(frameBytes, payload.buffer.byteLength) * 4;
  if (bytes > MAX_WARM_SNAPSHOT_BYTES) return;
  warmSnapshots.set(key, { snapshot, payload, bytes, etag, cacheAttemptedAt });
  warmSnapshotBudget.bytes += bytes;
  while (warmSnapshotBudget.bytes > MAX_WARM_SNAPSHOT_BYTES) {
    const oldest = warmSnapshots.entries().next().value;
    if (oldest === undefined) break;
    warmSnapshots.delete(oldest[0]);
    warmSnapshotBudget.bytes -= oldest[1].bytes;
  }
}

const snapshotMetrics = {
  snapshotR2Reads: 0,
  snapshotR2BodyBytes: 0,
  snapshotRevalidations: 0,
  snapshotSharedReads: 0,
  snapshotCacheDecodes: 0,
  snapshotCacheRejected: 0,
  snapshotCachePutAttempts: 0,
  snapshotCachePutBytes: 0,
  snapshotCachePutSkipped: 0,
};
async function acquireSnapshot(
  ctx: ExecutionContext,
  env: Env,
  namespace: string,
  observedAt: number,
  cacheKey: URL,
  cache: Cache | undefined,
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
    snapshotMetrics.snapshotR2BodyBytes += object.size;
    const payload = new Uint8Array(await object.arrayBuffer());
    selected.manifest = decodeRoot(new TextDecoder().decode(payload));
    selected.payload = payload;
  } else {
    if (previous === undefined || previous.etag !== object.etag)
      throw new Rejected({ status: 503, message: "Conditional R2 read has no matching snapshot" });
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
const pendingSnapshots = new Map<string, ReturnType<typeof acquireSnapshot>>();
const refreshSnapshot = Effect.fn("raio.refreshSnapshot")(function* (
  ctx: ExecutionContext,
  env: Env,
  namespace: string,
  minimumSequence: number,
  cacheKey: URL,
  cache: Cache | undefined,
  timings?: Headers,
) {
  const selected = { read: pendingSnapshots.get(cacheKey.href) };
  if (selected.read === undefined) {
    const now = yield* Clock.currentTimeMillis;
    selected.read = acquireSnapshot(ctx, env, namespace, now, cacheKey, cache).finally(() =>
      pendingSnapshots.delete(cacheKey.href),
    );
    pendingSnapshots.set(cacheKey.href, selected.read);
  } else snapshotMetrics.snapshotSharedReads += 1;
  const acquisition = selected.read;
  const acquired = yield* Effect.tryPromise({
    try: () => acquisition,
    catch: (cause) => {
      if (Schema.isSchemaError(cause)) return cause;
      return new Cause.UnknownError(cause);
    },
  });
  if (acquired === undefined) return undefined;
  timings?.append("server-timing", `edge_snapshot_r2;dur=${acquired.r2Ms}`);
  timings?.append("server-timing", `edge_snapshot_body;dur=${acquired.bodyMs}`);
  if (acquired.revalidated) timings?.append("server-timing", "edge_snapshot_revalidated");
  const snapshot = acquired.snapshot;
  if (snapshot.manifest.sequence < minimumSequence) return undefined;
  const selectedAt = yield* Clock.currentTimeMillis;
  if (selectedAt < snapshot.observedAt || selectedAt - snapshot.observedAt >= 1000)
    return undefined;
  return snapshot.manifest;
});
async function acquireCachedSnapshot(cacheKey: URL, minimumSequence: number) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const cache = yield* Effect.tryPromise(() => caches.open("raio-snapshots-v2")).pipe(
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
      const decoded = yield* readSnapshotFrame(encoded).pipe(Effect.orElseSucceed(() => undefined));
      if (decoded !== undefined) {
        const previous = warmSnapshots.get(cacheKey.href);
        if (
          previous?.etag !== undefined &&
          previous.snapshot.manifest.sequence === decoded.snapshot.manifest.sequence &&
          previous.payload.byteLength === decoded.payload.byteLength &&
          crypto.subtle.timingSafeEqual(previous.payload, decoded.payload)
        )
          rememberSnapshot(
            cacheKey.href,
            decoded.snapshot,
            decoded.payload,
            encoded.byteLength,
            previous.etag,
            previous.cacheAttemptedAt,
          );
        else rememberSnapshot(cacheKey.href, decoded.snapshot, decoded.payload, encoded.byteLength);
      }
      return { cache, snapshot: decoded?.snapshot, rejected: false };
    }),
  );
}
const pendingCachedSnapshots = new Map<string, ReturnType<typeof acquireCachedSnapshot>>();
const MAX_PENDING_CACHED_SNAPSHOTS = 64;

const snapshotRefreshes = new Set<string>();

const edgeSnapshot = Effect.fn("raio.edgeSnapshot")(function* (
  ctx: ExecutionContext,
  env: Env,
  namespace: string,
  minimumSequence: number,
  timings: Headers,
) {
  const cacheKey = new URL(`https://raio-cache.internal/snapshots/${namespace}`);
  cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
  const cache: { value: Cache | undefined } = { value: undefined };
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
      const read = acquireCachedSnapshot(cacheKey, minimumSequence);
      if (pendingCachedSnapshots.size < MAX_PENDING_CACHED_SNAPSHOTS) {
        acquisition.read = read.finally(() => pendingCachedSnapshots.delete(identity));
        pendingCachedSnapshots.set(identity, acquisition.read);
      } else acquisition.read = read;
    }
    const read = acquisition.read;
    const acquired = yield* Effect.tryPromise(() => read);
    const cacheEnded = yield* Clock.currentTimeNanos;
    timings.append(
      "server-timing",
      `edge_snapshot_cache;dur=${Number(cacheEnded - cacheStarted) / 1e6}`,
    );
    cache.value = acquired.cache;
    selection.snapshot = acquired.snapshot;
    if (acquired.rejected) timings.append("server-timing", "edge_snapshot_cache_rejected");
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
            caches.open("raio-snapshots-v2"),
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json(
        Schema.encodeSync(Health)({
          name: "kannin",
          version: "0.1.0",
          engine: "rust-wasm-r2",
          vectors: "cloudflare-vectorize",
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
      return Response.json(Schema.encodeSync(ErrorBody)({ error: "Unauthorized" }), {
        status: 401,
      });
    if (url.pathname === "/admin/namespaces" && request.method === "GET") {
      const options: R2ListOptions = { prefix: "namespaces/", delimiter: "/", limit: 100 };
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null) options.cursor = cursor;
      const result = await env.STORAGE.list(options);
      const names = result.delimitedPrefixes.map((prefix) =>
        prefix.slice("namespaces/".length, -1),
      );
      const page = { names: Schema.decodeSync(Schema.Array(NamespaceName))(names) };
      if (result.truncated)
        return Response.json(Schema.encodeSync(NamespacePage)({ ...page, cursor: result.cursor }), {
          headers: { "cache-control": "private, no-store" },
        });
      return Response.json(Schema.encodeSync(NamespacePage)({ ...page, cursor: null }), {
        headers: { "cache-control": "private, no-store" },
      });
    }
    const match = /^\/v1\/namespaces\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match === null || !isNamespaceName(match[1]) || !isOperation(match[2]))
      return Response.json(Schema.encodeSync(ErrorBody)({ error: "Unknown route" }), {
        status: 404,
      });
    const method = {
      write: "POST",
      query: "POST",
      metadata: "GET",
      "vector-sync": "POST",
      "vector-rebuild": "POST",
      rebuild: "POST",
      compact: "POST",
      collect: "POST",
    } satisfies Record<typeof Operation.Type, string>;
    if (request.method !== method[match[2]])
      return Response.json(Schema.encodeSync(ErrorBody)({ error: "Method not allowed" }), {
        status: 405,
      });
    const namespace = match[1];
    const operation = match[2];
    const snapshotTimings = new Headers();
    const started = Effect.runSync(Clock.currentTimeNanos);
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        if (operation === "query") {
          const body = yield* readBody(request.clone());
          const input = yield* decodeQuery(body).pipe(
            Effect.mapError(() => new Rejected({ status: 400, message: "Invalid query contract" })),
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
                try: () => query(env, input, manifest),
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
              evaluated.headers.append(
                "server-timing",
                `edge_snapshot;dur=${Number(snapshotEnded - snapshotStarted) / 1e6}`,
              );
              return evaluated;
            }
            snapshotTimings.append(
              "server-timing",
              `edge_snapshot_fallback;dur=${Number(snapshotEnded - snapshotStarted) / 1e6}`,
            );
          }
        }
        return yield* Effect.tryPromise(() =>
          env.NAMESPACES.get(env.NAMESPACES.idFromName(namespace)).fetch(request),
        );
      }).pipe(
        Effect.tapError((error) => {
          if (Schema.is(Rejected)(error) && error.status < 500) return Effect.void;
          return Effect.logError("kannin.gateway", { namespace, operation, error });
        }),
        Effect.catch((error) => {
          if (Schema.is(Rejected)(error))
            return Effect.succeed(
              Response.json(Schema.encodeSync(ErrorBody)({ error: error.message }), {
                status: error.status,
              }),
            );
          return Effect.succeed(
            Response.json(
              Schema.encodeSync(ErrorBody)({ error: "Storage or search backend unavailable" }),
              { status: 503 },
            ),
          );
        }),
      ),
    );
    const ended = Effect.runSync(Clock.currentTimeNanos);
    const outgoing = new Response(response.body, response);
    outgoing.headers.set("cache-control", "private, no-store");
    const snapshotTiming = snapshotTimings.get("server-timing");
    if (snapshotTiming !== null) outgoing.headers.append("server-timing", snapshotTiming);
    outgoing.headers.append("server-timing", `gateway;dur=${Number(ended - started) / 1e6}`);
    return outgoing;
  },
  async queue(batch: MessageBatch, env: Env) {
    await Effect.runPromise(
      Effect.forEach(
        batch.messages,
        Effect.fn("kannin.consumeJob")(
          function* (message) {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Union([VectorMessage, IndexMessage]),
              { onExcessProperty: "error" },
            )(message.body);
            const stub = env.NAMESPACES.get(env.NAMESPACES.idFromName(input.namespace));
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
          (effect, message) => effect.pipe(Effect.catch(() => Effect.sync(() => message.retry()))),
        ),
        { concurrency: 4 },
      ),
    );
  },
};
