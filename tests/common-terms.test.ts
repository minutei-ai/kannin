import { afterAll, expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import { initSync, Segment, Directory, segment_term_bounds } from "../dist/wasm/raio_engine";
import {
  CommonTerms,
  Root,
  QueryResult,
  SegmentHeader,
  StoredDocument,
  RankingInput,
  PostingSpans,
  SegmentHits,
  SearchStatistics,
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
  using segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents),
  );
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
    expect(fast.timing).toContain("catalog_root_prefix");
    expect(control.timing).not.toContain("catalog_root_prefix");
  }
  const all = await read(name, textQuery("constructor rust", 100));
  const byId = new Map(all.result.rows.map((row) => [row.id, row]));
  const filtered = await read(
    name,
    textQuery("constructor rust", 10, [{ field: "group", op: "eq", value: 2 }]),
  );
  expect(filtered.timing).not.toContain("catalog_root_prefix");
  expect(filtered.result.rows).toHaveLength(10);
  for (const row of filtered.result.rows) {
    const expected = byId.get(row.id);
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
  expect(deleted.result.rows.every((row) => !["0-0", "1-0", "2-0"].includes(row.id))).toBe(true);
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
  const original = Schema.decodeUnknownSync(Root)(await stored.json());
  const legacy = {
    ...original,
    segments: original.segments.map((segment) => Struct.omit(segment, ["commonTerms"])),
  };
  await bucket.put(key, Schema.encodeSync(Schema.fromJsonString(Root))(legacy));
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
  const prepared = Schema.decodeUnknownSync(Root)(await after.json());
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
