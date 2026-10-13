import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Cause, Clock, Effect, Match, Schema, Semaphore } from "effect";
import type { Env } from "../alchemy.run";
import {
  initSync,
  pack,
  unpack,
  tokenize,
  segment_document_terms,
  segment_filter,
} from "../dist/wasm/raio_engine";
import module from "raio:wasm";
import type { Row } from "./protocol";
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
  Snapshot,
  SegmentDocument,
  SegmentHits,
  SegmentTerms,
  LocatedDocument,
  RankingInput,
  SearchStatistics,
  Write,
  WriteResult,
  VectorMessage,
  VectorSyncResult,
  VectorFilterFields,
  VectorRebuild,
  VectorRebuildSnapshot,
  VectorRebuildResult,
  NamespacePage,
  Collection,
  CollectionResult,
  Retirement,
  IndexMessage,
  SegmentRange,
} from "./protocol";
import {
  range,
  withDirectory,
  buildSegment,
  bloom,
  bloomCandidates,
  readDocument,
  sha256,
  clearImmutableCache,
  cacheUsage,
} from "./storage";

import { vectorMetadata, vectorPrefilter } from "./vector-filters";

const wasm = initSync({ module });
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SEGMENT_RETIREMENT_MS = 24 * 60 * 60 * 1000;

export class Segments extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const decoded = Schema.decodeUnknownExit(SegmentRange)({
      key: url.searchParams.get("key"),
      offset: Number(url.searchParams.get("offset")),
      length: Number(url.searchParams.get("length")),
    });
    if (decoded._tag === "Failure" || request.method !== "GET")
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
    const response = new Response(bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "content-length": String(bytes.byteLength),
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

async function locate(env: Env, ids: ReadonlyArray<string>, root: typeof Root.Type) {
  const found = new Map<string, typeof Located.Type>();
  for (const segment of root.segments.toReversed()) {
    const candidates = bloomCandidates(
      segment.documentBloom,
      ids.filter((id) => !found.has(id)),
    );
    if (candidates.length === 0) continue;
    const rows = await Effect.runPromise(
      withDirectory(env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
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
  return found;
}

async function vectorId(epoch: string, id: string, sequence: number) {
  return sha256(`${epoch}\0${id}\0${sequence}`);
}

async function textQuery(
  env: Env,
  input: typeof Query.Type,
  root: typeof Root.Type,
  timings: Headers,
) {
  const started = Effect.runSync(Clock.currentTimeNanos);
  if (input.kind === "vector") return [];
  const words = tokenize(input.text).split(" ").filter(Boolean);
  const terms = [...new Set(words)];
  if (terms.length > 64 || (input.match === "phrase" && words.length > 64))
    throw new Rejected({ status: 400, message: "Query exceeds 64 normalized terms" });
  if (terms.length === 0 || root.documents === 0) return [];
  const candidates = root.segments.map((segment) => ({
    segment,
    terms: bloomCandidates(segment.termBloom, terms),
  }));
  if (
    (input.match === "all" || input.match === "phrase") &&
    !candidates.some((candidate) => candidate.terms.length === terms.length)
  )
    return [];
  const selected = candidates
    .filter((candidate) => candidate.terms.length > 0)
    .map((candidate) => candidate.segment);
  const encodedTerms = Schema.encodeSync(strings)(terms);
  const encodedFilters = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(
    input.filters,
  );
  const catalog = await Effect.runPromise(
    Effect.forEach(
      selected,
      (segment) =>
        withDirectory(env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
          Effect.gen(function* () {
            const dictionary = yield* Schema.decodeEffect(Schema.fromJsonString(SegmentTerms))(
              decoded.terms(encodedTerms),
            );
            return { segment, dictionary };
          }),
        ),
      { concurrency: 4 },
    ),
  );
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
  const encodedStatistics = Schema.encodeSync(Schema.fromJsonString(SearchStatistics))(statistics);
  const dictionaryEnded = Effect.runSync(Clock.currentTimeNanos);
  timings.append("server-timing", `text_directory;dur=${Number(dictionaryEnded - started) / 1e6}`);
  const ranked: Array<{
    segment: (typeof Root.Type)["segments"][number];
    row: number;
    id: string;
    score: number;
  }> = [];
  for (const { segment, dictionary } of catalog) {
    if (Object.keys(dictionary).length === 0) continue;
    if (
      (input.match === "all" || input.match === "phrase") &&
      terms.some((term) => {
        const metadata = dictionary[term];
        return metadata === undefined || metadata.df <= (segment.removedFrequencies[term] ?? 0);
      })
    )
      continue;
    if (ranked.length === input.topK) {
      const bound = await Effect.runPromise(
        withDirectory(env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
          Effect.gen(function* () {
            const dead = yield* Schema.encodeEffect(integers)(segment.dead);
            return decoded.upper_bound(encodedStatistics, encodedTerms, encodedFilters, dead);
          }),
        ),
      );
      const cutoff = ranked[ranked.length - 1];
      if (cutoff === undefined)
        throw new Rejected({ status: 503, message: "Invalid ranking cutoff" });
      if (
        bound + 1e-12 < cutoff.score ||
        (bound === cutoff.score && segment.minimumId >= cutoff.id)
      )
        continue;
    }
    const ranking = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
      text: input.text,
      mode: input.match ?? "any",
      top_k: input.topK,
      dead: segment.dead,
      filters: input.filters,
      statistics,
    });
    const result = await Effect.runPromise(
      withDirectory(env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
        Effect.acquireUseRelease(
          Effect.sync(() => decoded.ranker(ranking)),
          (ranker) =>
            Effect.gen(function* () {
              const requested = Object.entries(dictionary);
              for (const offset of Array.from(
                { length: Math.ceil(requested.length / 4) },
                (_, index) => index * 4,
              )) {
                const window = requested.slice(offset, offset + 4);
                const loaded = yield* Effect.forEach(
                  window,
                  ([term, metadata]) =>
                    Effect.gen(function* () {
                      const first = metadata.blocks[0];
                      if (first === undefined)
                        return yield* new Rejected({
                          status: 503,
                          message: "Empty posting directory",
                        });
                      const span = { end: first.data.offset };
                      for (const block of metadata.blocks) {
                        if (block.data.offset !== span.end || block.data.length <= 0)
                          return yield* new Rejected({
                            status: 503,
                            message: "Posting blocks are not contiguous",
                          });
                        span.end += block.data.length;
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
                      const bytes = yield* Effect.tryPromise({
                        try: () => range(env.STORAGE, segment.key, start, length),
                        catch: (cause) => {
                          if (Schema.is(Rejected)(cause)) return cause;
                          return new Cause.UnknownError(cause);
                        },
                      });
                      return { term, metadata, bytes, offset: first.data.offset };
                    }),
                  { concurrency: 4 },
                );
                for (const posting of loaded)
                  for (const block of posting.metadata.blocks) {
                    const start = block.data.offset - posting.offset;
                    ranker.add(
                      posting.term,
                      posting.bytes.subarray(start, start + block.data.length),
                    );
                  }
              }
              return yield* Schema.decodeEffect(Schema.fromJsonString(SegmentHits))(
                ranker.finish(),
              );
            }),
          (ranker) => Effect.sync(() => ranker.free()),
        ),
      ),
    );
    for (const hit of result) ranked.push({ ...hit, segment });
    ranked.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    ranked.splice(input.topK);
  }
  const rankingEnded = Effect.runSync(Clock.currentTimeNanos);
  timings.append("server-timing", `text_rank;dur=${Number(rankingEnded - dictionaryEnded) / 1e6}`);
  const hits = ranked.slice(0, input.topK);
  const rows = await Effect.runPromise(
    Effect.forEach(
      hits,
      (hit) =>
        Effect.gen(function* () {
          const metadata = yield* withDirectory(
            env.STORAGE,
            hit.segment.key,
            hit.segment.headerBytes,
            (decoded) =>
              Effect.gen(function* () {
                const encoded = yield* Schema.encodeEffect(integers)([hit.row]);
                const matches = yield* Schema.decodeEffect(
                  Schema.fromJsonString(Schema.Tuple([SegmentDocument])),
                )(decoded.rows(encoded));
                return matches[0];
              }),
          );
          const document = yield* Effect.tryPromise({
            try: () =>
              readDocument(
                env.STORAGE,
                hit.segment.key,
                hit.segment.headerBytes,
                metadata.data,
                hit.segment.bytes,
              ),
            catch: (cause) => {
              if (Schema.is(Rejected)(cause)) return cause;
              return new Cause.UnknownError(cause);
            },
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
      { concurrency: 4 },
    ),
  );
  const documentsEnded = Effect.runSync(Clock.currentTimeNanos);
  timings.append(
    "server-timing",
    `text_documents;dur=${Number(documentsEnded - rankingEnded) / 1e6}`,
  );
  return rows;
}

async function vectorQuery(env: Env, input: typeof Query.Type, root: typeof Root.Type) {
  if (input.kind === "text") return [];
  if (input.vector.length !== 768)
    throw new Rejected({ status: 400, message: "Vector dimension must be 768" });
  if (input.topK > 50)
    throw new Rejected({
      status: 400,
      message: "Vector and hybrid topK is limited to 50 by the Vectorize metadata contract",
    });
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
  const result = await env.VECTORS.query([...input.vector], options);
  const candidate = Schema.Struct({ id: Schema.String, revision: Schema.Int });
  const metadata = result.matches.map((match) => ({
    match,
    metadata: Schema.decodeUnknownSync(candidate)(match.metadata),
  }));
  const current = await locate(
    env,
    metadata.map((item) => item.metadata.id),
    root,
  );
  const rows: Array<typeof Row.Type> = [];
  for (const item of metadata) {
    const location = current.get(item.metadata.id);
    if (
      location === undefined ||
      location.document.revision !== item.metadata.revision ||
      !location.document.vector
    )
      continue;
    const expected = await vectorId(root.vectorEpoch, item.metadata.id, item.metadata.revision);
    if (item.match.id !== expected) continue;
    const matches = segment_filter(
      Schema.encodeSync(Schema.fromJsonString(Attributes))(location.document.attributes),
      Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(input.filters),
    );
    if (!matches) continue;
    const document = await readDocument(
      env.STORAGE,
      location.segment.key,
      location.segment.headerBytes,
      location.document.data,
      location.segment.bytes,
    );
    rows.push({
      id: document.id,
      title: document.title ?? "",
      text: document.text,
      attributes: document.attributes,
      revision: document.revision,
      score: item.match.score,
    });
  }
  return rows.slice(0, input.topK);
}

async function query(env: Env, input: typeof Query.Type, manifest: typeof Root.Type) {
  if (manifest.sequence < (input.minimumSequence ?? 0))
    throw new Rejected({ status: 409, message: "Requested sequence is not committed" });
  const timings = new Headers();
  const text = await textQuery(env, input, manifest, timings);
  const vectors = await vectorQuery(env, input, manifest);
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
  if (input.kind === "text")
    return Response.json(
      Schema.encodeSync(QueryResult)({
        rows,
        sequence: manifest.sequence,
        consistency: input.consistency ?? "strong",
      }),
      { headers: timings },
    );
  return Response.json(
    Schema.encodeSync(QueryResult)({
      rows,
      sequence: manifest.sequence,
      consistency: "vectorize-eventual",
    }),
    { headers: timings },
  );
}

export class SearchNamespace extends DurableObject<Env> {
  private readonly semaphore = Semaphore.makeUnsafe(1);
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
    const prior = await locate(this.env, ids, current.manifest);
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
        this.env.STORAGE,
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
        withDirectory(this.env.STORAGE, segment.key, segment.headerBytes, (directory) =>
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
        this.env,
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
          this.env.STORAGE,
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
        this.env,
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
        withDirectory(this.env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
          Effect.gen(function* () {
            const encoded = yield* Schema.encodeEffect(integers)(rows);
            return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(SegmentDocument)))(
              decoded.rows(encoded),
            );
          }),
        ),
      );
      const payload = await range(
        this.env.STORAGE,
        segment.key,
        segment.headerBytes,
        segment.bytes - segment.headerBytes,
      );
      for (const document of metadata) {
        const source = await readDocument(
          this.env.STORAGE,
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
    if (!Schema.is(NamespaceName)(namespace))
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
      const delivered = yield* this.semaphore.withPermit(
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
          if (operation === "query") {
            const input = yield* Schema.decodeEffect(Schema.fromJsonString(Query), {
              onExcessProperty: "error",
            })(body.text).pipe(
              Effect.mapError(
                () => new Rejected({ status: 400, message: "Invalid query contract" }),
              ),
            );
            return yield* Effect.tryPromise({
              try: async () => query(this.env, input, (await this.root()).manifest),
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
              return yield* new Rejected({ status: 400, message: "Vector job namespace mismatch" });
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
            clearImmutableCache(this.env.STORAGE, this.prefix);
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
      const ended = yield* Clock.currentTimeNanos;
      delivered.headers.append("server-timing", `raio;dur=${Number(ended - started) / 1e6}`);
      return delivered;
    }).pipe(
      Effect.catch((error) => {
        this.current = undefined;
        this.acknowledgedReceipt = undefined;
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

const warmSnapshots = new Map<string, { snapshot: typeof Snapshot.Type; bytes: number }>();
const warmSnapshotBudget = { bytes: 0 };
const MAX_WARM_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function rememberSnapshot(key: string, snapshot: typeof Snapshot.Type, encoded: string) {
  const prior = warmSnapshots.get(key);
  if (prior !== undefined) warmSnapshotBudget.bytes -= prior.bytes;
  warmSnapshots.delete(key);
  const bytes = new TextEncoder().encode(encoded).byteLength * 4;
  if (bytes > MAX_WARM_SNAPSHOT_BYTES) return;
  warmSnapshots.set(key, { snapshot, bytes });
  warmSnapshotBudget.bytes += bytes;
  while (warmSnapshotBudget.bytes > MAX_WARM_SNAPSHOT_BYTES) {
    const oldest = warmSnapshots.entries().next().value;
    if (oldest === undefined) break;
    warmSnapshots.delete(oldest[0]);
    warmSnapshotBudget.bytes -= oldest[1].bytes;
  }
}

const refreshSnapshot = Effect.fn("raio.refreshSnapshot")(function* (
  env: Env,
  namespace: string,
  minimumSequence: number,
  cacheKey: URL,
  cache: Cache | undefined,
) {
  const now = yield* Clock.currentTimeMillis;
  const object = yield* Effect.tryPromise(() =>
    env.STORAGE.get(`namespaces/${namespace}/root.json`),
  );
  if (object === null) return undefined;
  const manifest = yield* Effect.tryPromise(() => object.text()).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Root))),
  );
  if (manifest.sequence < minimumSequence)
    return yield* new Rejected({ status: 409, message: "Requested sequence is not committed" });
  const snapshot = { observedAt: now, manifest };
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(snapshot);
  rememberSnapshot(cacheKey.href, snapshot, encoded);
  if (cache !== undefined) {
    yield* Effect.tryPromise(() =>
      cache.put(
        cacheKey,
        new Response(encoded, {
          headers: {
            "cache-control": "public, max-age=2, must-revalidate",
            "content-type": "application/json",
          },
        }),
      ),
    ).pipe(Effect.ignore);
  }
  const selectedAt = yield* Clock.currentTimeMillis;
  if (selectedAt - now >= 1000)
    return yield* new Rejected({ status: 503, message: "Snapshot freshness budget exceeded" });
  return manifest;
});
const snapshotRefreshes = new Set<string>();

const edgeSnapshot = Effect.fn("raio.edgeSnapshot")(function* (
  ctx: ExecutionContext,
  env: Env,
  namespace: string,
  minimumSequence: number,
) {
  const cacheKey = new URL(`https://raio-cache.internal/snapshots/${namespace}`);
  cacheKey.searchParams.set("bucket", env.STORAGE_CACHE_SCOPE);
  const cache = yield* Effect.tryPromise(() => caches.open("raio-snapshots-v1")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const memory = warmSnapshots.get(cacheKey.href);
  const selection = { snapshot: memory?.snapshot };
  const observedAt = yield* Clock.currentTimeMillis;
  if (
    selection.snapshot === undefined ||
    observedAt < selection.snapshot.observedAt ||
    observedAt - selection.snapshot.observedAt >= 1000 ||
    selection.snapshot.manifest.sequence < minimumSequence
  ) {
    if (memory !== undefined) {
      warmSnapshots.delete(cacheKey.href);
      warmSnapshotBudget.bytes -= memory.bytes;
    }
    selection.snapshot = undefined;
    if (cache !== undefined) {
      const cached = yield* Effect.tryPromise(() => cache.match(cacheKey)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (cached !== undefined) {
        const encoded = yield* Effect.tryPromise(() => cached.text()).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (encoded !== undefined) {
          const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Snapshot))(encoded).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          selection.snapshot = decoded;
          if (decoded !== undefined) rememberSnapshot(cacheKey.href, decoded, encoded);
        }
      }
    }
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
        refreshSnapshot(env, namespace, 0, cacheKey, cache).pipe(
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
  return yield* refreshSnapshot(env, namespace, minimumSequence, cacheKey, cache);
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
          ...cacheUsage(),
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
    if (match === null || !Schema.is(NamespaceName)(match[1]) || !Schema.is(Operation)(match[2]))
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
    const started = Effect.runSync(Clock.currentTimeNanos);
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        if (operation === "query") {
          const body = yield* readBody(request.clone());
          const input = yield* Schema.decodeEffect(Schema.fromJsonString(Query), {
            onExcessProperty: "error",
          })(body).pipe(
            Effect.mapError(() => new Rejected({ status: 400, message: "Invalid query contract" })),
          );
          if (input.consistency === "edge-eventual") {
            if (input.kind !== "text")
              return yield* new Rejected({
                status: 400,
                message: "Edge consistency is supported for text queries only",
              });
            const snapshotStarted = yield* Clock.currentTimeNanos;
            const manifest = yield* edgeSnapshot(ctx, env, namespace, input.minimumSequence ?? 0);
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
          }
        }
        return yield* Effect.tryPromise(() =>
          env.NAMESPACES.get(env.NAMESPACES.idFromName(namespace)).fetch(request),
        );
      }).pipe(
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
