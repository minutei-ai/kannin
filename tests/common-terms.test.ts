import { encodeCanonicalDocuments } from "./segment-fixture";
import { decodeRoot, encodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSync, Segment, Directory, segment_term_bounds } from "../dist/wasm/raio_engine";
import {
  CommonTerms,
  QueryResult,
  SegmentHeader,
  RankingInput,
  PostingSpans,
  SegmentHits,
  SearchStatistics,
  Id,
  canonicalIdKey,
  compareCanonicalIds,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});
const worker = await startWorker();
afterAll(() => worker.dispose());

async function read(namespace: string, body: unknown) {
  const response = await request(worker, namespace, "query", body);
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  return { result, timing: response.headers.get("server-timing") ?? "" };
}

test("common-term prefixes are bounded, deterministic and conservative for complete rankings", () => {
  const documents = Array.from({ length: 96 }, (_, index) => ({
    id: String(index).padStart(4, "0"),
    revision: 0,
    title: "constructor ".repeat(index % 3),
    text: [
      "shared constructor rust",
      "x".repeat(65),
      `unique${index}`,
      ...Array.from(
        { length: index % 40 },
        (_iteration, term) => `word${String(term).padStart(2, "0")}`,
      ),
    ].join(" "),
    attributes: {},
  }));
  using segment = new Segment(encodeCanonicalDocuments(documents));
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = Directory.canonical(bytes.subarray(0, base), base);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const common = Schema.decodeSync(Schema.fromJsonString(CommonTerms))(segment.common_terms());
  expect(directory.common_terms()).toBe(segment.common_terms());
  const expected = Object.entries(header.terms)
    .filter(([term, meta]) => meta.df > 1 && term.length <= 64)
    .toSorted((left, right) => {
      const frequency = right[1].df - left[1].df;
      if (frequency !== 0) return frequency;
      if (left[0] < right[0]) return -1;
      if (left[0] > right[0]) return 1;
      return 0;
    })
    .slice(0, 16)
    .map(([term]) => term)
    .toSorted();
  expect(Object.keys(common).toSorted()).toEqual(expected);
  expect(Object.keys(common)).toHaveLength(16);
  const original = new Map(Object.entries(header.terms));
  for (const [term, summary] of Object.entries(common)) {
    const meta = original.get(term);
    const bound = summary.bounds[0];
    if (meta === undefined || bound === undefined) throw new Error("Missing source term bound");
    expect(summary.df).toBe(meta.df);
    for (const block of meta.blocks) {
      expect(bound[0]).toBeGreaterThanOrEqual(block.max_title_tf);
      expect(bound[1]).toBeGreaterThanOrEqual(block.max_body_tf);
      expect(bound[2]).toBeLessThanOrEqual(block.min_title_length);
      expect(bound[3]).toBeLessThanOrEqual(block.min_body_length);
    }
  }
  const statistics = {
    documents: documents.length,
    title_length: header.total_title_length,
    body_length: header.total_body_length,
    frequencies: Object.fromEntries(
      Object.entries(header.terms).map(([term, meta]) => [term, meta.df]),
    ),
  };
  const lookup = new Map(Object.entries(common));
  const catalog = {
    dictionary: Object.fromEntries(
      ["constructor", "rust"].flatMap((term) => {
        const summary = lookup.get(term);
        if (summary === undefined) throw new Error("Missing frequent test term");
        return [[term, summary] as const];
      }),
    ),
    minimum: [0, 0],
    partitions: null,
  };
  const upper = segment_term_bounds(
    Schema.encodeSync(Schema.fromJsonString(SearchStatistics))(statistics),
    JSON.stringify([catalog]),
  )[0];
  if (upper === undefined) throw new Error("Missing conservative term bound");
  for (const mode of ["any", "all", "phrase"] as const) {
    using ranker = directory.ranker(
      Schema.encodeSync(Schema.fromJsonString(RankingInput))({
        text: "constructor rust",
        mode,
        top_k: 96,
        dead: [],
        filters: [],
        statistics,
      }),
    );
    for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
      ranker.posting_spans(),
    ))
      for (const block of span.blocks)
        ranker.add(
          span.term,
          bytes.subarray(base + block.data.offset, base + block.data.offset + block.data.length),
        );
    const hits = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish());
    expect(hits).toHaveLength(documents.length);
    for (const hit of hits) expect(hit.score).toBeLessThanOrEqual(upper + 1e-12);
  }
});

test("single-segment phrases retain root planning without a catalog read", async () => {
  const name = "single-segment-phrase-prefix";
  const documents = Array.from({ length: 16 }, (_, index) =>
    document(String(index), "storage latency storage ".repeat(1 + (index % 3)), {
      group: index % 2,
    }),
  );
  expect((await request(worker, name, "write", write(documents))).status).toBe(200);
  const fast = await read(name, { ...textQuery("storage latency storage"), match: "phrase" });
  const control = await read(name, {
    ...textQuery("storage latency storage", 10, [{ field: "group", op: "ne", value: -1 }]),
    match: "phrase",
  });
  expect(fast.result.rows).toHaveLength(10);
  expect(fast.result).toEqual(control.result);
  expect(fast.timing).toContain("catalog_root_prefix");
  expect(fast.timing).not.toContain("catalog_rpc_sum");
  expect(control.timing).not.toContain("catalog_root_prefix");
  expect(control.timing).toContain('catalog_root_eligibility;desc="hit"');
  expect(control.timing).not.toContain("catalog_rpc_sum");
  const complete = await read(name, {
    ...textQuery("storage latency storage", 100),
    match: "phrase",
  });
  const selective = await read(name, {
    ...textQuery("storage latency storage", 10, [{ field: "group", op: "eq", value: 1 }]),
    match: "phrase",
  });
  expect(selective.result.rows).toEqual(
    complete.result.rows.filter((row) => row.attributes.group === 1).slice(0, 10),
  );
  expect(selective.result.rows).toHaveLength(8);
  expect(selective.timing).toContain('catalog_root_eligibility;desc="hit"');
  expect(selective.timing).not.toContain("catalog_rpc_sum");
});

test("manifest prefixes preserve global scores, tombstones, filters and partial coverage", async () => {
  const name = "common-term-mutations";
  for (const batch of Array.from({ length: 8 }, (_, index) => index)) {
    const upserts = Array.from({ length: 30 }, (_, row) =>
      document(`${batch}-${row}`, `constructor rust shared unique${batch}x${row}`, {
        year: 2025,
        group: row % 3,
      }),
    );
    expect((await request(worker, name, "write", write(upserts))).status).toBe(200);
  }
  for (const mode of ["any", "all", "phrase"] as const) {
    const fast = await read(name, { ...textQuery("constructor rust"), match: mode });
    const control = await read(name, {
      ...textQuery("constructor rust", 10, [{ field: "group", op: "ne", value: -1 }]),
      match: mode,
    });
    expect(fast.result).toEqual(control.result);
    if (mode === "phrase") {
      expect(fast.timing).not.toContain("catalog_root_prefix");
      expect(fast.timing).toContain("catalog_root_joint");
      expect(fast.timing).not.toContain("catalog_rpc_sum");
    } else expect(fast.timing).toContain("catalog_root_prefix");
    expect(control.timing).not.toContain("catalog_root_prefix");
    expect(control.timing).not.toContain("catalog_root_joint");
    expect(control.timing).toContain('catalog_root_eligibility;desc="hit"');
    expect(control.timing).not.toContain("catalog_rpc_sum");
  }
  const all = await read(name, textQuery("constructor rust", 100));
  const byId = new Map(all.result.rows.map((row) => [canonicalIdKey(row.id), row]));
  const filtered = await read(
    name,
    textQuery("constructor rust", 10, [{ field: "group", op: "eq", value: 2 }]),
  );
  expect(filtered.timing).not.toContain("catalog_root_prefix");
  expect(filtered.timing).toContain('catalog_root_eligibility;desc="hit"');
  expect(filtered.timing).not.toContain("catalog_rpc_sum");
  expect(filtered.result.rows).toHaveLength(10);
  for (const row of filtered.result.rows) {
    const expected = byId.get(canonicalIdKey(row.id));
    if (expected === undefined) throw new Error("Filtered winner missing from unfiltered ranking");
    expect(row.attributes.group).toBe(2);
    expect(row).toEqual(expected);
  }
  expect((await request(worker, name, "write", write([], ["0-0", "1-0", "2-0"]))).status).toBe(200);
  const deleted = await read(name, textQuery("constructor rust"));
  expect(deleted.timing).toContain("catalog_root_prefix");
  expect(deleted.result).toEqual(
    (await read(name, textQuery("constructor rust", 10, [{ field: "group", op: "ne", value: -1 }])))
      .result,
  );
  expect(
    deleted.result.rows.every(
      (row) => !["0-0", "1-0", "2-0"].includes(Schema.decodeUnknownSync(Id)(row.id)),
    ),
  ).toBe(true);
  expect(
    (
      await request(
        worker,
        name,
        "write",
        write([document("new", "constructor rust shared", { year: 2025 })]),
      )
    ).status,
  ).toBe(200);
  const mixed = await read(name, textQuery("constructor rust"));
  expect(mixed.timing).not.toContain("catalog_root_prefix");
  expect(mixed.result).toEqual(
    (await read(name, textQuery("constructor rust", 10, [{ field: "group", op: "ne", value: -1 }])))
      .result,
  );
  expect((await request(worker, name, "compact", {})).status).toBe(200);
  const compacted = await read(name, textQuery("constructor rust"));
  expect(compacted.timing).toContain("catalog_root_prefix");
  expect(compacted.result).toEqual(mixed.result);
});

test("unfiltered phrase Root fallback leaves later correlated projections visible", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "kannin-root-term-fallback-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(persistence, { recursive: true, force: true }));
  const writer = await startWorker(persistence);
  const writerDisposed = { value: false };
  cleanup.defer(() => {
    if (writerDisposed.value) return Promise.resolve();
    return writer.dispose();
  });
  const name = "unfiltered-phrase-root-fallback";
  const control = "unfiltered-phrase-root-control";
  for (const [namespace, idPrefix] of [
    [name, "target"],
    [control, "control"],
  ] as const)
    for (const [batch, phrase] of ["alpha beta", "beta alpha", "alpha beta"].entries())
      expect(
        (
          await request(
            writer,
            namespace,
            "write",
            write(
              Array.from({ length: 24 }, (_, index) =>
                document(`${idPrefix}-${batch}-${index}`, phrase),
              ),
            ),
          )
        ).status,
      ).toBe(200);
  const controlResponse = await request(writer, control, "query", {
    ...textQuery("alpha beta", 100),
    match: "phrase",
  });
  expect(controlResponse.status).toBe(200);
  const controlResult = Schema.decodeUnknownSync(QueryResult)(await controlResponse.json());
  const bucket = await writer.getR2Bucket("STORAGE", "raio");
  const manifestObject = await bucket.get(`namespaces/${name}/root.json`);
  if (manifestObject === null) throw new Error("Missing phrase Root manifest");
  const manifest = decodeRoot(await manifestObject.text());
  const correlated: Array<{ key: string; body: string }> = [];
  for (const segment of manifest.segments) {
    const key = `cache/correlated-pool-v3/${segment.key}`;
    const object = await bucket.get(key);
    if (object === null) throw new Error("Missing correlated phrase source");
    correlated.push({ key, body: await object.text() });
  }
  await bucket.put(
    `namespaces/${name}/root.json`,
    encodeRoot({
      ...manifest,
      segments: manifest.segments.map((segment) =>
        Object.assign({}, segment, { commonProjection: null }),
      ),
    }),
  );
  await bucket.delete(
    manifest.segments.flatMap((segment) => [
      `cache/correlated-pool-v3/${segment.key}`,
      `cache/directory-v7/${segment.key}/${segment.headerBytes}`,
    ]),
  );
  await writer.dispose();
  writerDisposed.value = true;
  const reader = await startWorker(persistence);
  cleanup.defer(() => reader.dispose());
  const readerBucket = await reader.getR2Bucket("STORAGE", "raio");
  const first = await request(reader, name, "query", {
    ...textQuery("alpha beta", 100),
    match: "phrase",
  });
  expect(first.status).toBe(200);
  const firstResult = Schema.decodeUnknownSync(QueryResult)(await first.json());
  expect(firstResult.rows.map((row) => row.id).toSorted(compareCanonicalIds)).toEqual(
    [
      ...Array.from({ length: 24 }, (_, index) => `target-0-${index}`),
      ...Array.from({ length: 24 }, (_, index) => `target-2-${index}`),
    ].toSorted(compareCanonicalIds),
  );
  expect(
    firstResult.rows.map(({ id, score }) => ({
      id: Schema.decodeUnknownSync(Id)(id).replace(/^target-/u, "control-"),
      score,
    })),
  ).toEqual(
    controlResult.rows.map(({ id, score }) => ({ id: Schema.decodeUnknownSync(Id)(id), score })),
  );
  expect(first.headers.get("server-timing")).toContain("catalog_rpc_sum");
  expect(first.headers.get("server-timing")).toContain("directories=0");
  for (const source of correlated) await readerBucket.put(source.key, source.body);
  const second = await request(reader, name, "query", {
    ...textQuery("beta alpha", 100),
    match: "phrase",
  });
  expect(second.status).toBe(200);
  const secondResult = Schema.decodeUnknownSync(QueryResult)(await second.json());
  expect(secondResult.rows.map((row) => row.id).toSorted(compareCanonicalIds)).toEqual(
    Array.from({ length: 24 }, (_, index) => `target-1-${index}`).toSorted(compareCanonicalIds),
  );
  const secondTiming = second.headers.get("server-timing") ?? "";
  expect(secondTiming).toContain("catalog_rpc_sum");
  expect(secondTiming).toContain(`hits=${manifest.segments.length}`);
});

test("rebuild backfills legacy manifest prefixes once without changing sequence or segment bytes", async () => {
  const name = "common-term-legacy";
  for (const batch of [0, 1])
    expect(
      (
        await request(
          worker,
          name,
          "write",
          write(
            Array.from({ length: 40 }, (_, row) =>
              document(`${batch}-${row}`, "constructor shared rust", { year: 2025 }),
            ),
          ),
        )
      ).status,
    ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE", "raio");
  const key = `namespaces/${name}/root.json`;
  const stored = await bucket.get(key);
  if (stored === null) throw new Error("Missing original manifest");
  const original = decodeRoot(await stored.text());
  const legacy = {
    ...original,
    segments: original.segments.map((segment) => Struct.omit(segment, ["commonTerms"])),
  };
  await bucket.put(key, encodeRoot(legacy));
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name });
  const baseline = await read(name, textQuery("constructor shared"));
  expect(baseline.timing).not.toContain("catalog_root_prefix");
  expect(baseline.timing).toContain("catalog_rpc_sum");
  const sources = await Promise.all(
    original.segments.map(async (segment) => ({
      key: segment.key,
      etag: (await bucket.head(segment.key))?.etag,
    })),
  );
  expect((await request(worker, name, "rebuild", {})).status).toBe(200);
  const after = await bucket.get(key);
  if (after === null) throw new Error("Missing prepared manifest");
  const prepared = decodeRoot(await after.text());
  expect(prepared.sequence).toBe(original.sequence);
  expect(prepared.segments.every((segment) => segment.commonTerms !== undefined)).toBe(true);
  expect(Struct.omit(prepared, ["segments"])).toEqual(Struct.omit(original, ["segments"]));
  expect(prepared.segments.map((segment) => Struct.omit(segment, ["commonTerms"]))).toEqual(
    legacy.segments,
  );
  expect(
    await Promise.all(
      original.segments.map(async (segment) => ({
        key: segment.key,
        etag: (await bucket.head(segment.key))?.etag,
      })),
    ),
  ).toEqual(sources);
  const migrated = await read(name, textQuery("constructor shared"));
  expect(migrated.result).toEqual(baseline.result);
  expect(migrated.timing).toContain("catalog_root_prefix");
  const version = after.etag;
  expect((await request(worker, name, "rebuild", {})).status).toBe(200);
  expect((await bucket.head(key))?.etag).toBe(version);
});

test("phrase term-frequency bounds skip impossible segments and preserve exact global scores", async () => {
  const impossibleDocuments = [
    { ...document("once-a", "Café rust"), title: "" },
    { ...document("once-b", "cafe\u0301 rust"), title: "" },
  ];
  const phraseDocuments = [
    ...Array.from({ length: 128 }, (_, index) => ({
      ...document(`a-${String(index).padStart(3, "0")}`, "cafe rust filler"),
      title: "",
    })),
    { ...document("b-gap", "cafe rust filler cafe"), title: "" },
    { ...document("z-phrase", "Café rust cafe\u0301"), title: "" },
  ];
  const splitDocuments = [
    { ...document("split-a", "rust cafe\u0301"), title: "Café" },
    { ...document("split-b", "rust cafe"), title: "cafe\u0301" },
  ];
  const sources = [impossibleDocuments, phraseDocuments, splitDocuments];
  const encodeDocuments = (documents: typeof impossibleDocuments) =>
    encodeCanonicalDocuments(
      documents.map((doc) => ({
        ...doc,
        revision: 0,
      })),
    );
  using impossibleSegment = new Segment(encodeDocuments(impossibleDocuments));
  using phraseSegment = new Segment(encodeDocuments(phraseDocuments));
  using splitSegment = new Segment(encodeDocuments(splitDocuments));
  const segments = [impossibleSegment, phraseSegment, splitSegment];
  const headers = segments.map((segment) =>
    Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json()),
  );
  const frequencies = new Map<string, number>();
  for (const header of headers)
    for (const [term, metadata] of Object.entries(header.terms))
      frequencies.set(term, (frequencies.get(term) ?? 0) + metadata.df);
  const statistics = {
    documents: headers.reduce((total, header) => total + header.documents.length, 0),
    title_length: headers.reduce((total, header) => total + header.total_title_length, 0),
    body_length: headers.reduce((total, header) => total + header.total_body_length, 0),
    frequencies: Object.fromEntries(frequencies),
  };
  const query = {
    text: "CAFÉ rust cafe\u0301",
    mode: "phrase" as const,
    top_k: 20,
    dead: [],
    filters: [],
    statistics,
  };
  const expected = [];
  for (const [index, segment] of segments.entries()) {
    const header = headers[index];
    if (header === undefined) throw new Error("Missing oracle segment header");
    const bytes = segment.bytes();
    const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
    using directory = Directory.canonical(bytes.subarray(0, base), base);
    using ranker = directory.ranker(Schema.encodeSync(Schema.fromJsonString(RankingInput))(query));
    for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
      ranker.posting_spans(),
    ))
      for (const block of span.blocks)
        ranker.add(
          span.term,
          bytes.subarray(base + block.data.offset, base + block.data.offset + block.data.length),
        );
    for (const hit of Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish())) {
      const doc = header.documents[hit.row];
      if (doc === undefined) throw new Error("Missing oracle hit document");
      expected.push({ id: doc.id, score: hit.score });
    }
  }
  expected.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  const wanted = expected.slice(0, query.top_k);
  expect(wanted.map(({ id }) => id)).toEqual(["z-phrase"]);
  const impossibleCommon = Schema.decodeSync(Schema.fromJsonString(CommonTerms))(
    impossibleSegment.common_terms(),
  );
  const splitCommon = Schema.decodeSync(Schema.fromJsonString(CommonTerms))(
    splitSegment.common_terms(),
  );
  const impossibleBound = impossibleCommon.cafe?.bounds[0];
  const splitBound = splitCommon.cafe?.bounds[0];
  if (impossibleBound === undefined || splitBound === undefined)
    throw new Error("Missing repeated-term summary");
  expect(impossibleBound[0] + impossibleBound[1]).toBeLessThan(2);
  expect(splitBound[0] + splitBound[1]).toBeGreaterThanOrEqual(2);
  const phraseTerms = headers[1]?.terms.cafe;
  if (phraseTerms === undefined) throw new Error("Missing multi-block repeated term");
  expect(phraseTerms.blocks.some((block) => block.max_title_tf + block.max_body_tf < 2)).toBe(true);
  expect(phraseTerms.blocks.some((block) => block.max_title_tf + block.max_body_tf >= 2)).toBe(
    true,
  );

  for (const accelerated of [true, false]) {
    const name = `phrase-frequency-${String(accelerated)}`;
    for (const documents of sources)
      expect((await request(worker, name, "write", write(documents))).status).toBe(200);
    const bucket = await worker.getR2Bucket("STORAGE", "raio");
    const key = `namespaces/${name}/root.json`;
    const stored = await bucket.get(key);
    if (stored === null) throw new Error("Missing phrase-frequency manifest");
    const original = decodeRoot(await stored.text());
    const root = {
      ...original,
      segments: original.segments.map((segment) => {
        if (accelerated) return segment;
        return Struct.omit(segment, ["commonTerms"]);
      }),
    };
    await bucket.put(key, encodeRoot(root));
    await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name });
    const result = await read(name, {
      ...textQuery("CAFÉ rust cafe\u0301", query.top_k),
      match: "phrase",
    });
    expect(result.result.rows.map(({ id, score }) => ({ id, score }))).toEqual(wanted);
    expect(result.timing).toMatch(/text_score;dur=[^,]*;desc="segments=2"/u);
    expect(result.timing).not.toContain("catalog_root_prefix");
    if (accelerated) {
      expect(result.timing).toContain("catalog_root_joint");
      expect(result.timing).not.toContain("catalog_rpc_sum");
    } else {
      expect(result.timing).not.toContain("catalog_root_joint");
      expect(result.timing).toContain("catalog_rpc_sum");
    }
  }
});
