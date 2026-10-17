import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { crc32 } from "node:zlib";
import {
  initSync,
  Segment,
  Directory,
  segment_correlated_overview,
  segment_overview_project,
  segment_term_bounds,
} from "../dist/wasm/raio_engine";
import {
  QueryResult,
  SegmentHeader,
  TermCatalog,
  Root,
  CorrelatedOverview,
  SegmentHits,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});
const worker = await startWorker();
afterAll(() => worker.dispose());

const fixture = Array.from({ length: 200 }, (_, row) => ({
  ...document(
    String(row).padStart(5, "0"),
    `cloudflare rust search group${row % 100} unique${row} ${"storage latency durable object ".repeat(8 + (row % 8))}`,
    { group: row % 3 },
  ),
  title: "",
}));

test("shared length bounds remove cross-term slack without changing canonical bytes", () => {
  using segment = new Segment(
    JSON.stringify(fixture.map((source) => Object.assign({}, source, { revision: 1 }))),
  );
  const bytes = segment.bytes();
  const before = bytes.slice();
  const overview = segment_correlated_overview(bytes);
  if (overview === undefined) throw new Error("Missing correlated overview");
  expect(bytes).toEqual(before);
  using directory = new Directory(bytes);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const text = "cloudflare rust storage latency durable object search group42";
  const terms = JSON.stringify(text.split(" "));
  for (const scale of [1, 200])
    for (const filters of [
      [],
      [{ field: "group", op: "eq", value: 0 }],
      [{ field: "group", op: "eq", value: 99 }],
    ]) {
      const statistics = {
        documents: fixture.length * scale,
        title_length: header.total_title_length * scale,
        body_length: header.total_body_length * scale,
        frequencies: Object.fromEntries(
          Object.entries(header.terms).map(([term, meta]) => [term, meta.df * scale]),
        ),
      };
      const catalogs = [directory.overview(), overview].map((source) =>
        Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
          segment_overview_project(source, terms, JSON.stringify(filters)),
        ),
      );
      expect(catalogs[1]?.partitions).toHaveLength(8);
      const bounds = segment_term_bounds(JSON.stringify(statistics), JSON.stringify(catalogs));
      const independent = bounds[0];
      const correlated = bounds[1];
      if (independent === undefined || correlated === undefined) throw new Error("Missing bounds");
      expect(correlated).toBeLessThanOrEqual(independent);
      for (const mode of ["any", "all", "phrase"])
        for (const dead of [[], [42, 142]]) {
          using ranker = directory.ranker(
            JSON.stringify({ text, mode, top_k: 10, statistics, filters, dead }),
          );
          for (const term of text.split(" "))
            for (const block of header.terms[term]?.blocks ?? [])
              ranker.add(
                term,
                bytes.subarray(
                  base + block.data.offset,
                  base + block.data.offset + block.data.length,
                ),
              );
          const hits = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish());
          for (const hit of hits) expect(hit.score).toBeLessThanOrEqual(correlated);
          if (filters.length === 0 && dead.length === 0 && mode === "any") {
            const best = hits[0];
            if (best === undefined) throw new Error("Missing best hit");
            expect(correlated).toBe(best.score);
            expect(independent - correlated).toBeGreaterThan(1e-12);
          }
        }
    }
});

test("cold queries prune equivalent segments and cache loss preserves exact rows", async () => {
  const results = new Map<string, typeof QueryResult.Type>();
  for (const variant of ["present", "absent", "corrupt", "misbound"]) {
    const namespace = `correlated-${variant}`;
    for (const index of Array.from({ length: 12 }, (_, ordinal) => ordinal)) {
      const response = await request(
        worker,
        namespace,
        "write",
        write(
          fixture.map((source) =>
            Object.assign({}, source, {
              id: `${String(index).padStart(2, "0")}-${source.id}`,
            }),
          ),
        ),
      );
      expect(response.status).toBe(200);
    }
    const bucket = await worker.getR2Bucket("STORAGE");
    const objects = await bucket.list({
      prefix: `cache/correlated-pool-v1/namespaces/${namespace}/`,
    });
    expect(objects.objects).toHaveLength(12);
    if (variant === "absent") await bucket.delete(objects.objects.map((object) => object.key));
    if (variant === "corrupt" || variant === "misbound")
      for (const object of objects.objects) {
        const source = await bucket.get(object.key);
        if (source === null) throw new Error("Missing cached overview");
        if (variant === "corrupt")
          await bucket.put(object.key, new Uint8Array([1, 2, 3]), {
            customMetadata: source.customMetadata ?? {},
          });
        else
          await bucket.put(
            object.key,
            Schema.encodeSync(Schema.fromJsonString(CorrelatedOverview))(
              Object.assign(
                {},
                Schema.decodeSync(Schema.fromJsonString(CorrelatedOverview))(await source.text()),
                { bucket: "another-bucket" },
              ),
            ),
          );
      }
    const response = await request(
      worker,
      namespace,
      "query",
      textQuery("cloudflare rust storage latency durable object search group42", 1),
    );
    expect(response.status).toBe(200);
    results.set(variant, Schema.decodeUnknownSync(QueryResult)(await response.json()));
    if (variant === "present")
      expect(response.headers.get("server-timing")).toContain('desc="segments=1"');
    else expect(response.headers.get("server-timing")).toContain('desc="segments=12"');
    const root = await bucket.get(`namespaces/${namespace}/root.json`);
    if (root === null) throw new Error("Missing root");
    expect(Schema.decodeSync(Schema.fromJsonString(Root))(await root.text()).segments).toHaveLength(
      12,
    );
  }
  const expected = results.get("present");
  if (expected === undefined) throw new Error("Missing reference result");
  for (const result of results.values()) expect(result).toEqual(expected);
}, 30000);

test("coarsened length partitions conservatively bound title boosts and changed live statistics", () => {
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 96 }, (_, row) => ({
        ...document(String(row), `${"beta gamma ".repeat(row + 1)}alpha unique${row}`, {
          group: row % 3,
        }),
        title: "alpha ".repeat(row % 7),
        revision: 1,
      })),
    ),
  );
  const bytes = segment.bytes();
  const overview = segment_correlated_overview(bytes);
  if (overview === undefined) throw new Error("Missing coarsened overview");
  using directory = new Directory(bytes);
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  for (const text of ["alpha beta gamma", "beta gamma", "alpha beta gamma unique42"])
    for (const filters of [[], [{ field: "group", op: "eq", value: 1 }]]) {
      const catalog = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
        segment_overview_project(
          overview,
          JSON.stringify(text.split(" ")),
          JSON.stringify(filters),
        ),
      );
      expect(catalog.partitions).toHaveLength(32);
      for (const scale of [1, 3]) {
        const statistics = {
          documents: 96 * scale + 17,
          title_length: header.total_title_length * scale + 257,
          body_length: header.total_body_length * scale + 7919,
          frequencies: Object.fromEntries(
            Object.entries(header.terms).map(([term, metadata]) => [
              term,
              Math.max(1, metadata.df * scale - 3),
            ]),
          ),
        };
        const upper = segment_term_bounds(JSON.stringify(statistics), JSON.stringify([catalog]))[0];
        if (upper === undefined) throw new Error("Missing coarsened bound");
        for (const mode of ["any", "all", "phrase"])
          for (const dead of [[], [0, 3, 6, 9]]) {
            using ranker = directory.ranker(
              JSON.stringify({ text, mode, top_k: 100, dead, filters, statistics }),
            );
            for (const term of text.split(" "))
              for (const block of header.terms[term]?.blocks ?? [])
                ranker.add(
                  term,
                  bytes.subarray(
                    base + block.data.offset,
                    base + block.data.offset + block.data.length,
                  ),
                );
            const hits = Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish());
            for (const hit of hits) expect(hit.score).toBeLessThanOrEqual(upper);
          }
      }
    }
});

test("expanded length synopses bypass cache generation rather than expanding query metadata", () => {
  const vocabulary = Array.from({ length: 64 }, (_, index) => `term${index}`).join(" ");
  using segment = new Segment(
    JSON.stringify(
      Array.from({ length: 96 }, (_, index) => ({
        ...document(String(index), `${vocabulary} ${"alpha ".repeat(index + 1)}unique${index}`),
        revision: 1,
      })),
    ),
  );
  expect(segment_correlated_overview(segment.bytes())).toBeUndefined();
  using directory = new Directory(segment.bytes());
  const fallback = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
    segment_overview_project(directory.overview(), '["alpha","term0"]', "[]"),
  );
  expect(fallback.partitions).toBeNull();
  expect(fallback.dictionary.alpha?.df).toBe(96);
});

test("derived overview ranges reject WASM integer overflow without trapping", () => {
  using segment = new Segment(
    JSON.stringify([
      { ...document("a", "alpha"), revision: 1 },
      { ...document("b", "alpha"), revision: 1 },
    ]),
  );
  const bytes = segment.bytes();
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const term = header.terms.alpha;
  const block = term?.blocks[0];
  if (term === undefined || block === undefined) throw new Error("Missing fixture term");
  for (const data of [
    { offset: 4294967295, length: 8 },
    { offset: 0, length: 4294967295 },
  ]) {
    const json = new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(SegmentHeader))({
        ...header,
        terms: { alpha: { ...term, blocks: [{ ...block, data }] } },
      }),
    );
    const forged = new Uint8Array(16 + json.byteLength);
    forged.set(bytes.subarray(0, 8));
    new DataView(forged.buffer).setUint32(8, json.byteLength, true);
    new DataView(forged.buffer).setUint32(12, crc32(json), true);
    forged.set(json, 16);
    expect(() => segment_correlated_overview(forged)).toThrow("Invalid posting range");
  }
});
