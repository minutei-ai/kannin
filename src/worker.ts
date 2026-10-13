import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Cause, Effect, Schema, Semaphore } from "effect";
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
  Query,
  QueryResult,
  Receipt,
  Rejected,
  Root,
  SegmentDocument,
  SegmentHits,
  SegmentTerms,
  LocatedDocument,
  RankingInput,
  SearchStatistics,
  Write,
  WriteResult,
  VectorMessage,
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

const wasm = initSync({ module });

export class Segments extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
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
    if (cache) {
      const cached = await Effect.runPromise(
        Effect.tryPromise(() => cache.match(cacheKey)).pipe(Effect.orElseSucceed(() => undefined)),
      );
      if (cached) {
        const response = new Response(cached.body, cached);
        response.headers.delete("cf-cache-status");
        response.headers.set("x-raio-cache", "api-hit");
        return response;
      }
    }
    const object = await this.env.STORAGE.get(input.key, {
      range: { offset: input.offset, length: input.length },
    });
    if (!object)
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
    if (cache)
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

const readBody = Effect.fn("raio.readBody")(function* (request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return yield* new Rejected({ status: 415, message: "Expected application/json" });
  if (!request.body) return yield* new Rejected({ status: 400, message: "Missing body" });
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

export class SearchNamespace extends DurableObject<Env> {
  private readonly semaphore = Semaphore.makeUnsafe(1);
  private namespace: typeof NamespaceName.Type | undefined;
  private current: { manifest: typeof Root.Type; etag: string | null } | undefined;

  private get prefix() {
    if (this.namespace === undefined) throw new Error("Namespace must be bound before R2 access");
    return `namespaces/${this.namespace}`;
  }

  private async root() {
    if (this.current) return this.current;
    const object = await this.env.STORAGE.get(`${this.prefix}/root.json`);
    if (object) {
      this.current = { manifest: decodeRoot(await object.text()), etag: object.etag };
      return this.current;
    }
    const acknowledged = await this.env.STORAGE.list({
      prefix: `${this.prefix}/receipts/`,
      limit: 1,
    });
    if (acknowledged.objects.length)
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
    if (etag)
      result.object = await this.env.STORAGE.put(`${this.prefix}/root.json`, content, {
        onlyIf: { etagMatches: etag },
      });
    else result.object = await this.env.STORAGE.put(`${this.prefix}/root.json`, content, options);
    if (!result.object)
      throw new Rejected({
        status: 409,
        message: "R2 manifest changed; retry the operation with the same requestId",
      });
    this.current = { manifest, etag: result.object.etag };
    return this.current;
  }

  private async persistReceipt(receipt: typeof Receipt.Type) {
    const key = `${this.prefix}/receipts/${await sha256(receipt.requestId)}.json`;
    const existing = await this.env.STORAGE.get(key);
    if (existing) {
      const prior = Schema.decodeSync(Schema.fromJsonString(Receipt))(await existing.text());
      if (prior.digest !== receipt.digest || prior.sequence !== receipt.sequence)
        throw new Rejected({ status: 503, message: "Committed receipt conflict" });
      return;
    }
    await this.env.STORAGE.put(key, Schema.encodeSync(Schema.fromJsonString(Receipt))(receipt), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
  }

  private async locate(ids: ReadonlyArray<string>, root: typeof Root.Type) {
    const found = new Map<string, typeof Located.Type>();
    for (const segment of root.segments.toReversed()) {
      const candidates = bloomCandidates(
        segment.documentBloom,
        ids.filter((id) => !found.has(id)),
      );
      if (!candidates.length) continue;
      const rows = await Effect.runPromise(
        withDirectory(this.env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
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

  private async vectorId(epoch: string, id: string, sequence: number) {
    return sha256(`${epoch}\0${id}\0${sequence}`);
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
    if (!input.reset && !ids.length) throw new Rejected({ status: 400, message: "Empty write" });
    for (const document of input.upserts)
      if (document.vector && document.vector.length !== 768)
        throw new Rejected({ status: 400, message: "Vector dimension must be 768" });
    const fingerprint = await sha256(Schema.encodeSync(Schema.fromJsonString(Write))(input));
    const current = await this.root();
    if (current.manifest.lastReceipt) await this.persistReceipt(current.manifest.lastReceipt);
    const priorObject = await this.env.STORAGE.get(
      `${this.prefix}/receipts/${await sha256(input.requestId)}.json`,
    );
    if (priorObject) {
      const receipt = Schema.decodeSync(Schema.fromJsonString(Receipt))(await priorObject.text());
      if (receipt.digest !== fingerprint)
        throw new Rejected({
          status: 409,
          message: "requestId already used with a different payload",
        });
      const pending = current.manifest.vectorJobs.find((job) => job.sequence === receipt.sequence);
      if (pending) await this.enqueue(namespace, { namespace, ...pending });
      if (receipt.sequence % 16 === 0) await this.enqueueCompaction(namespace, current.manifest);
      return Response.json(
        Schema.encodeSync(WriteResult)({
          sequence: receipt.sequence,
          requestId: input.requestId,
          vectorSync: "queued",
        }),
      );
    }
    const prior = await this.locate(ids, current.manifest);
    const sequence = current.manifest.sequence + 1;
    const dead = new Map<string, number[]>();
    const removed = new Map<string, Record<string, number>>();
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
      const frequencies = removed.get(location.segment.key) ?? {};
      for (const term of terms) frequencies[term] = (frequencies[term] ?? 0) + 1;
      removed.set(location.segment.key, frequencies);
      totals.documents -= 1;
      totals.title -= location.document.title_length;
      totals.body -= location.document.body_length;
      if (location.document.vector)
        vectorDeletes.push(
          await this.vectorId(
            current.manifest.vectorEpoch,
            location.document.id,
            location.document.revision,
          ),
        );
    }
    const segments = current.manifest.segments.map((segment) => {
      const removedFrequencies = { ...segment.removedFrequencies };
      for (const [term, count] of Object.entries(removed.get(segment.key) ?? {}))
        removedFrequencies[term] = (removedFrequencies[term] ?? 0) + count;
      return {
        ...segment,
        dead: [...segment.dead, ...(dead.get(segment.key) ?? [])],
        removedFrequencies,
      };
    });
    const epoch = { value: current.manifest.vectorEpoch };
    if (input.reset) {
      segments.splice(0);
      totals.documents = 0;
      totals.title = 0;
      totals.body = 0;
      epoch.value = await sha256(`${current.manifest.vectorEpoch}\0reset\0${sequence}`);
    }
    if (input.upserts.length) {
      const built = await Effect.runPromise(
        buildSegment(input.upserts.map((document) => ({ ...document, revision: sequence }))),
      );
      const key = `${this.prefix}/segments/${sequence}-${fingerprint}.rsix`;
      const stored = await this.env.STORAGE.put(key, built.bytes);
      if (!stored) throw new Rejected({ status: 503, message: "R2 segment write failed" });
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
    await this.env.STORAGE.put(logKey, pack(encodeLog(log)));
    const jobs = [...current.manifest.vectorJobs];
    if (vectorDeletes.length || input.upserts.some((document) => document.vector))
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

  private async textQuery(input: typeof Query.Type, root: typeof Root.Type) {
    if (input.kind === "vector") return [];
    const words = tokenize(input.text).split(" ").filter(Boolean);
    const terms = [...new Set(words)];
    if (terms.length > 64 || (input.match === "phrase" && words.length > 64))
      throw new Rejected({ status: 400, message: "Query exceeds 64 normalized terms" });
    if (!terms.length || !root.documents) return [];
    const selected = root.segments.filter(
      (segment) => bloomCandidates(segment.termBloom, terms).length > 0,
    );
    const catalog = [];
    const frequencies: Record<string, number> = {};
    for (const segment of selected) {
      const dictionary = await Effect.runPromise(
        withDirectory(this.env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
          Effect.gen(function* () {
            const encoded = yield* Schema.encodeEffect(strings)(terms);
            return yield* Schema.decodeEffect(Schema.fromJsonString(SegmentTerms))(
              decoded.terms(encoded),
            );
          }),
        ),
      );
      for (const [term, metadata] of Object.entries(dictionary))
        frequencies[term] =
          (frequencies[term] ?? 0) + metadata.df - (segment.removedFrequencies[term] ?? 0);
      catalog.push({ segment, dictionary });
    }
    const statistics = {
      documents: root.documents,
      title_length: root.titleLength,
      body_length: root.bodyLength,
      frequencies,
    };
    const ranked: Array<{
      segment: (typeof Root.Type)["segments"][number];
      row: number;
      id: string;
      score: number;
    }> = [];
    for (const { segment, dictionary } of catalog) {
      if (ranked.length === input.topK) {
        const bound = await Effect.runPromise(
          withDirectory(this.env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
            Effect.gen(function* () {
              const corpus = yield* Schema.encodeEffect(Schema.fromJsonString(SearchStatistics))(
                statistics,
              );
              const encoded = yield* Schema.encodeEffect(strings)(terms);
              return decoded.upper_bound(corpus, encoded);
            }),
          ),
        );
        const cutoff = ranked[ranked.length - 1];
        if (
          bound + 1e-12 < cutoff.score ||
          (bound === cutoff.score && segment.minimumId >= cutoff.id)
        )
          continue;
      }
      const query = Schema.encodeSync(Schema.fromJsonString(RankingInput))({
        text: input.text,
        mode: input.match ?? "any",
        top_k: input.topK,
        dead: segment.dead,
        filters: input.filters,
        statistics,
      });
      const result = await Effect.runPromise(
        withDirectory(this.env.STORAGE, segment.key, segment.headerBytes, (decoded) =>
          Effect.acquireUseRelease(
            Effect.sync(() => decoded.ranker(query)),
            (ranker) =>
              Effect.gen({ self: this }, function* () {
                for (const [term, metadata] of Object.entries(dictionary))
                  for (const block of metadata.blocks) {
                    const offset = segment.headerBytes + block.data.offset;
                    if (offset + block.data.length > segment.bytes)
                      return yield* new Rejected({
                        status: 503,
                        message: "Invalid posting block range",
                      });
                    const bytes = yield* Effect.tryPromise({
                      try: () => range(this.env.STORAGE, segment.key, offset, block.data.length),
                      catch: (cause) => {
                        if (Schema.is(Rejected)(cause)) return cause;
                        return new Cause.UnknownError(cause);
                      },
                    });
                    ranker.add(term, bytes);
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
    ranked.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    const hits = ranked.slice(0, input.topK);
    const rows: Array<typeof Row.Type> = [];
    for (const hit of hits) {
      const metadata = await Effect.runPromise(
        withDirectory(this.env.STORAGE, hit.segment.key, hit.segment.headerBytes, (decoded) =>
          Effect.gen(function* () {
            const encoded = yield* Schema.encodeEffect(integers)([hit.row]);
            const matches = yield* Schema.decodeEffect(
              Schema.fromJsonString(Schema.Array(SegmentDocument)),
            )(decoded.rows(encoded));
            return matches[0];
          }),
        ),
      );
      const document = await readDocument(
        this.env.STORAGE,
        hit.segment.key,
        hit.segment.headerBytes,
        metadata.data,
        hit.segment.bytes,
      );
      rows.push({
        id: document.id,
        title: document.title ?? "",
        text: document.text,
        attributes: document.attributes,
        revision: document.revision,
        score: hit.score,
      });
    }
    return rows;
  }

  private async vectorQuery(input: typeof Query.Type, root: typeof Root.Type) {
    if (input.kind === "text") return [];
    if (input.vector.length !== 768)
      throw new Rejected({ status: 400, message: "Vector dimension must be 768" });
    if (input.topK > 50)
      throw new Rejected({
        status: 400,
        message: "Vector and hybrid topK is limited to 50 by the Vectorize metadata contract",
      });
    const result = await this.env.VECTORS.query([...input.vector], {
      namespace: root.vectorEpoch,
      topK: 50,
      returnMetadata: "all",
    });
    const candidate = Schema.Struct({ id: Schema.String, revision: Schema.Int });
    const metadata = result.matches.map((match) => ({
      match,
      metadata: Schema.decodeUnknownSync(candidate)(match.metadata),
    }));
    const current = await this.locate(
      metadata.map((item) => item.metadata.id),
      root,
    );
    const rows: Array<typeof Row.Type> = [];
    for (const item of metadata) {
      const location = current.get(item.metadata.id);
      if (
        !location ||
        location.document.revision !== item.metadata.revision ||
        !location.document.vector
      )
        continue;
      const expected = await this.vectorId(
        root.vectorEpoch,
        item.metadata.id,
        item.metadata.revision,
      );
      if (item.match.id !== expected) continue;
      const matches = segment_filter(
        Schema.encodeSync(Schema.fromJsonString(Attributes))(location.document.attributes),
        Schema.encodeSync(Schema.fromJsonString(Schema.Array(Filter)))(input.filters),
      );
      if (!matches) continue;
      const document = await readDocument(
        this.env.STORAGE,
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

  private async query(input: typeof Query.Type) {
    const { manifest } = await this.root();
    const text = await this.textQuery(input, manifest);
    const vectors = await this.vectorQuery(input, manifest);
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
          consistency: "strong",
        }),
      );
    return Response.json(
      Schema.encodeSync(QueryResult)({
        rows,
        sequence: manifest.sequence,
        consistency: "vectorize-eventual",
      }),
    );
  }

  private async synchronizeVectors(sequence?: number) {
    const current = await this.root();
    const jobs = current.manifest.vectorJobs
      .filter((job) => sequence === undefined || job.sequence === sequence)
      .slice(0, 16);
    const completed = new Set<number>();
    for (const job of jobs) {
      const object = await this.env.STORAGE.get(job.log);
      if (!object) throw new Rejected({ status: 503, message: "Committed vector log missing" });
      const log = decodeLog(unpack(new Uint8Array(await object.arrayBuffer())));
      if (log.sequence !== job.sequence)
        throw new Rejected({ status: 503, message: "Vector log sequence mismatch" });
      for (const offset of Array.from(
        { length: Math.ceil(log.vectorDeletes.length / 100) },
        (_, ordinal) => ordinal * 100,
      ))
        await this.env.VECTORS.deleteByIds(log.vectorDeletes.slice(offset, offset + 100));
      const vectors = [];
      for (const document of log.write.upserts)
        if (document.vector)
          vectors.push({
            id: await this.vectorId(log.vectorEpoch, document.id, log.sequence),
            values: [...document.vector],
            namespace: log.vectorEpoch,
            metadata: { id: document.id, revision: log.sequence },
          });
      for (const offset of Array.from(
        { length: Math.ceil(vectors.length / 100) },
        (_, ordinal) => ordinal * 100,
      ))
        await this.env.VECTORS.upsert(vectors.slice(offset, offset + 100));
      completed.add(job.sequence);
    }
    if (completed.size)
      await this.commit(
        {
          ...current.manifest,
          vectorJobs: current.manifest.vectorJobs.filter((job) => !completed.has(job.sequence)),
        },
        current.etag,
      );
    return Response.json({ submitted: completed.size, visibility: "vectorize-eventual" });
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
    if (documents.length) {
      const built = await Effect.runPromise(buildSegment(documents));
      const key = `${this.prefix}/segments/compact-${current.manifest.sequence}-${crypto.randomUUID()}.rsix`;
      const stored = await this.env.STORAGE.put(key, built.bytes);
      if (!stored)
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

  fetch(request: Request) {
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
      const body = { text: "" };
      if (
        operation === "write" ||
        operation === "query" ||
        operation === "internal-vector-sync" ||
        operation === "internal-compact"
      )
        body.text = yield* readBody(request);
      if (
        (operation === "compact" || operation === "vector-sync" || operation === "rebuild") &&
        request.body
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
      return yield* this.semaphore.withPermit(
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
              try: () => this.query(input),
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
            if (job && job.log !== message.log)
              return yield* new Rejected({ status: 400, message: "Vector job log mismatch" });
            return yield* Effect.tryPromise({
              try: () => this.synchronizeVectors(message.sequence),
              catch: (cause) => {
                if (Schema.is(Rejected)(cause)) return cause;
                return new Cause.UnknownError(cause);
              },
            });
          }
          if (operation === "rebuild") {
            this.current = undefined;
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
    }).pipe(
      Effect.catch((error) => {
        this.current = undefined;
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

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json(
        Schema.encodeSync(Health)({
          name: "raio",
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
    const match =
      /^\/v1\/namespaces\/([^/]+)\/(write|query|metadata|vector-sync|rebuild|compact)$/.exec(
        url.pathname,
      );
    if (!match || !Schema.is(NamespaceName)(match[1]))
      return Response.json(Schema.encodeSync(ErrorBody)({ error: "Unknown route" }), {
        status: 404,
      });
    const method = {
      write: "POST",
      query: "POST",
      metadata: "GET",
      "vector-sync": "POST",
      rebuild: "POST",
      compact: "POST",
    } as const;
    if (request.method !== Reflect.get(method, match[2]))
      return Response.json(Schema.encodeSync(ErrorBody)({ error: "Method not allowed" }), {
        status: 405,
      });
    const response = await env.NAMESPACES.get(env.NAMESPACES.idFromName(match[1])).fetch(request);
    const outgoing = new Response(response.body, response);
    outgoing.headers.set("cache-control", "private, no-store");
    return outgoing;
  },
  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) {
      if (Schema.is(IndexMessage)(message.body) && !Schema.is(VectorMessage)(message.body)) {
        const input = Schema.decodeSync(IndexMessage, { onExcessProperty: "error" })(message.body);
        const response = await env.NAMESPACES.get(env.NAMESPACES.idFromName(input.namespace)).fetch(
          `http://internal/v1/namespaces/${input.namespace}/internal-compact`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: Schema.encodeSync(Schema.fromJsonString(IndexMessage))(input),
          },
        );
        if (!response.ok) {
          message.retry();
          continue;
        }
        message.ack();
        continue;
      }
      const input = Schema.decodeUnknownSync(VectorMessage)(message.body);
      const response = await env.NAMESPACES.get(env.NAMESPACES.idFromName(input.namespace)).fetch(
        `http://internal/v1/namespaces/${input.namespace}/internal-vector-sync`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Schema.encodeSync(Schema.fromJsonString(VectorMessage))(input),
        },
      );
      if (!response.ok) {
        message.retry();
        continue;
      }
      message.ack();
    }
  },
};
