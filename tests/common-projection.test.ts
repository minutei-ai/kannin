import { encodeCanonicalDocuments } from "./segment-fixture";
import { decodeRoot, encodeRoot } from "../src/manifest";
import { afterAll, expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import {
  initSync,
  Segment,
  segment_correlated_overview,
  segment_overview_project,
  segment_term_bounds,
  segment_term_bounds_compact,
} from "../dist/wasm/raio_engine";
import {
  CommonTermProjection,
  CommonTerms,
  CompactTermBounds,
  QueryResult,
  SegmentHeader,
  TermCatalog,
  SearchStatistics,
} from "../src/protocol";
import { document, request, startWorker, textQuery, write, evictWrittenOverviews } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});
const worker = await startWorker();
afterAll(() => worker.dispose());
const text = "storage latency durable object storage latency durable";
const terms = [...new Set(text.split(" "))];
const documents = Array.from({ length: 200 }, (_, row) => ({
  ...document(
    String(row).padStart(5, "0"),
    `cloudflare rust search group${row % 100} unique${row} ${"storage latency durable object ".repeat(8 + (row % 8))}`,
    { group: row % 3 },
  ),
  title: "",
}));

const adversarial = [
  ...Array.from({ length: 128 }, (_, row) =>
    document(`a${String(row).padStart(3, "0")}`, "alpha low"),
  ),
  ...Array.from({ length: 128 }, (_, row) =>
    document(`b${String(row).padStart(3, "0")}`, "alpha ".repeat(50) + "high ".repeat(50)),
  ),
  ...Array.from({ length: 31 }, (_, row) =>
    document(`c${String(row).padStart(2, "0")}`, "padding ".repeat(101 + row)),
  ),
];

test("compact common projections preserve full correlated bounds and physical segment bytes", () => {
  using segment = new Segment(
    encodeCanonicalDocuments(documents.map((source) => Object.assign({}, source, { revision: 1 }))),
  );
  const bytes = segment.bytes();
  const encoded = segment.common_projection();
  if (encoded === undefined) throw new Error("Missing native common projection");
  const projection = Schema.decodeSync(Schema.fromJsonString(CommonTermProjection))(encoded);
  const common = Schema.decodeSync(Schema.fromJsonString(CommonTerms))(segment.common_terms());
  expect(projection.terms.toSorted()).toEqual(Object.keys(common).toSorted());
  expect(projection.partitions).toHaveLength(8);
  expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(4096);
  const overview = segment_correlated_overview(bytes);
  if (overview === undefined) throw new Error("Missing correlated overview");
  const reference = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
    segment_overview_project(overview, JSON.stringify(terms), "[]"),
  );
  const compact = {
    dictionary: Object.fromEntries(
      terms.map((term) => {
        const summary = common[term];
        if (summary === undefined) throw new Error("Missing common term");
        const bounds = projection.independent[projection.terms.indexOf(term)];
        if (bounds === undefined) throw new Error("Missing independent term bounds");
        return [term, { df: summary.df, bounds }] as const;
      }),
    ),
    minimum: [0, 0] as const,
    partitions: projection.partitions.map((partition) =>
      Object.fromEntries(
        terms.flatMap((term) => {
          const bound = partition[projection.terms.indexOf(term)];
          const summary = common[term];
          if (bound === undefined || bound === null || summary === undefined) return [];
          return [[term, { df: summary.df, bounds: [bound] }] as const];
        }),
      ),
    ),
  };
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  for (const scale of [1, 200]) {
    const statistics = Schema.encodeSync(Schema.fromJsonString(SearchStatistics))({
      documents: documents.length * scale,
      title_length: header.total_title_length * scale,
      body_length: header.total_body_length * scale,
      frequencies: Object.fromEntries(terms.map((term) => [term, (common[term]?.df ?? 0) * scale])),
    });
    const bounds = segment_term_bounds(
      statistics,
      Schema.encodeSync(Schema.fromJsonString(Schema.Array(TermCatalog)))([reference, compact]),
    );
    expect(bounds[0]).toBeGreaterThan(0);
    expect(bounds[1]).toBe(bounds[0]);
    expect(
      Array.from(
        segment_term_bounds_compact(
          statistics,
          Schema.encodeSync(Schema.fromJsonString(CompactTermBounds))([
            [
              projection,
              projection.terms.map((term) => {
                if (!terms.includes(term)) return 0;
                const summary = common[term];
                if (summary === undefined) throw new Error("Missing compact frequency");
                return summary.df;
              }),
            ],
          ]),
        ),
      ),
    ).toEqual(Array.from(bounds.slice(1, 2)));
  }
  expect(segment.bytes()).toEqual(bytes);
});

test("compact projections preserve block bounds when quantile groups merge length classes", () => {
  using segment = new Segment(
    encodeCanonicalDocuments(
      adversarial.map((source) => Object.assign({}, source, { title: "", revision: 1 })),
    ),
  );
  const encoded = segment.common_projection();
  if (encoded === undefined) throw new Error("Missing adversarial projection");
  const projection = Schema.decodeSync(Schema.fromJsonString(CommonTermProjection))(encoded);
  const common = Schema.decodeSync(Schema.fromJsonString(CommonTerms))(segment.common_terms());
  const alpha = common.alpha;
  const independent = projection.independent[projection.terms.indexOf("alpha")];
  if (alpha === undefined || independent === undefined) throw new Error("Missing alpha bounds");
  const overview = segment_correlated_overview(segment.bytes());
  if (overview === undefined) throw new Error("Missing adversarial catalog");
  const reference = Schema.decodeSync(Schema.fromJsonString(TermCatalog))(
    segment_overview_project(overview, '["alpha"]', "[]"),
  );
  const referenceAlpha = reference.dictionary.alpha;
  if (referenceAlpha === undefined) throw new Error("Missing canonical alpha bounds");
  expect(independent).toEqual(referenceAlpha.bounds);
  expect(independent).toHaveLength(2);
  const partitions = projection.partitions.map((partition) => {
    const bound = partition[projection.terms.indexOf("alpha")];
    if (bound === undefined || bound === null) return {};
    return { alpha: { df: alpha.df, bounds: [bound] } };
  });
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const statistics = Schema.encodeSync(Schema.fromJsonString(SearchStatistics))({
    documents: adversarial.length,
    title_length: header.total_title_length,
    body_length: header.total_body_length,
    frequencies: { alpha: alpha.df },
  });
  const bounds = segment_term_bounds(
    statistics,
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(TermCatalog)))([
      reference,
      { dictionary: { alpha: { df: alpha.df, bounds: independent } }, minimum: [0, 0], partitions },
      { dictionary: { alpha }, minimum: [0, 0], partitions },
    ]),
  );
  expect(bounds[0]).toBeGreaterThan(0);
  expect(bounds[1]).toBe(bounds[0]);
  expect(bounds[2]).toBeGreaterThan(bounds[0] ?? 0);
  expect(
    Array.from(
      segment_term_bounds_compact(
        statistics,
        Schema.encodeSync(Schema.fromJsonString(CompactTermBounds))([
          [
            projection,
            projection.terms.map((term) => {
              if (term === "alpha") return alpha.df;
              return 0;
            }),
          ],
        ]),
      ),
    ),
  ).toEqual(Array.from(bounds.slice(1, 2)));
});

test("native compact bounds preserve lexical sums, null cells and singleton term fallbacks", () => {
  const projection = {
    terms: ["zeta", "alpha", "beta"],
    partitions: [
      [[2, 0, 3, 0], null, [0, 4, 0, 8]],
      [null, [0, 3, 0, 5], null],
    ],
    independent: [
      [
        [2, 0, 3, 0],
        [0, 9, 0, 20],
      ],
      [[0, 3, 0, 5]],
      [[0, 4, 0, 8]],
    ],
  } as const;
  const statistics = Schema.encodeSync(Schema.fromJsonString(SearchStatistics))({
    documents: 1000,
    title_length: 12000,
    body_length: 40000,
    frequencies: { alpha: 125, zeta: 2, beta: 90 },
  });
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const)
    for (const physical of [
      [1, 10, 0],
      [2, 10, 1],
      [0, 10, 5],
    ] as const) {
      const reordered = {
        terms: order.map((index) => projection.terms[index]),
        independent: order.map((index) => projection.independent[index]),
        partitions: projection.partitions.map((row) => order.map((index) => row[index])),
      };
      const frequencies = order.map((index) => physical[index]);
      const checked = Schema.encodeSync(Schema.fromJsonString(CompactTermBounds))([
        [reordered, frequencies],
      ]);
      const validated = Schema.decodeSync(Schema.fromJsonString(CompactTermBounds))(checked);
      const encoded = Schema.encodeSync(Schema.fromJsonString(CompactTermBounds), {
        disableChecks: true,
      })(validated);
      expect(encoded).toBe(checked);
      const selected = validated.map(([source, dfs]) => {
        const columns = new Set(
          dfs.flatMap((df, index) => {
            if (df === 0) return [];
            return [index];
          }),
        );
        return [
          {
            terms: source.terms.filter((_term, index) => columns.has(index)),
            independent: source.independent.filter((_bounds, index) => columns.has(index)),
            partitions: source.partitions.map((row) =>
              row.filter((_bound, index) => columns.has(index)),
            ),
          },
          dfs.filter((_df, index) => columns.has(index)),
        ] as const;
      });
      const encodedSelected = Schema.encodeSync(Schema.fromJsonString(CompactTermBounds), {
        disableChecks: true,
      })(selected);
      expect(encodedSelected).toBe(
        Schema.encodeSync(Schema.fromJsonString(CompactTermBounds))(selected),
      );
      expect(Array.from(segment_term_bounds_compact(statistics, encodedSelected))).toEqual(
        Array.from(segment_term_bounds_compact(statistics, encoded)),
      );
      const dictionary = Object.fromEntries(
        reordered.terms.flatMap((term, column) => {
          const df = frequencies[column];
          const bounds = reordered.independent[column];
          if (df === undefined || bounds === undefined) throw new Error("Missing compact term");
          if (df === 0) return [];
          return [[term, { df, bounds }] as const];
        }),
      );
      const partitions = reordered.partitions.map((row) =>
        Object.fromEntries(
          reordered.terms.flatMap((term, column) => {
            const bound = row[column];
            const summary = dictionary[term];
            if (bound === undefined) throw new Error("Missing compact cell");
            if (bound === null || summary === undefined) return [];
            return [[term, { df: summary.df, bounds: [bound] }] as const];
          }),
        ),
      );
      expect(Array.from(segment_term_bounds_compact(statistics, encoded))).toEqual(
        Array.from(
          segment_term_bounds(
            statistics,
            Schema.encodeSync(Schema.fromJsonString(Schema.Array(TermCatalog)))([
              { dictionary, minimum: [0, 0], partitions },
            ]),
          ),
        ),
      );
    }
  for (const invalid of [
    [[projection, [0, 0, 0]]],
    [[projection, [1, 2]]],
    [[projection, [10001, 1, 1]]],
    [[{ ...projection, terms: ["zeta", "zeta", "beta"] }, [1, 1, 1]]],
    [[{ ...projection, partitions: [[null, null, null]] }, [1, 1, 1]]],
    [[{ ...projection, partitions: [[[1, 1, 1, 1]]] }, [1, 1, 1]]],
    [[{ ...projection, independent: [[], ...projection.independent.slice(1)] }, [1, 1, 1]]],
    Array.from({ length: 65 }, () => [projection, [1, 1, 1]]),
  ])
    expect(() => segment_term_bounds_compact(statistics, JSON.stringify(invalid))).toThrow();
});

test("Worker joint proofs preserve adversarial multi-block phrase ranking", async () => {
  const namespace = "root-joint-coarsened-blocks";
  for (const batch of [0, 1]) {
    const response = await request(
      worker,
      namespace,
      "write",
      write(
        adversarial.map((source) =>
          Object.assign({}, source, { title: "", id: `${batch}-${source.id}` }),
        ),
      ),
    );
    expect(response.status).toBe(200);
  }
  const query = { ...textQuery("alpha alpha"), match: "phrase" };
  const compact = await request(worker, namespace, "query", query);
  expect(compact.status).toBe(200);
  expect(compact.headers.get("server-timing")).toContain("catalog_root_joint");
  const expected = Schema.decodeUnknownSync(QueryResult)(await compact.json());
  expect(expected.rows).toHaveLength(10);
  expect(expected.rows.every((row) => row.id.includes("-b"))).toBe(true);
  const bucket = await worker.getR2Bucket("STORAGE");
  const key = `namespaces/${namespace}/root.json`;
  const object = await bucket.get(key);
  if (object === null) throw new Error("Missing adversarial Root");
  const root = decodeRoot(await object.text());
  await bucket.put(
    key,
    encodeRoot({
      ...root,
      segments: root.segments.map((segment) =>
        Object.assign({}, segment, { commonProjection: null }),
      ),
    }),
  );
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  const reference = await request(worker, namespace, "query", query);
  expect(reference.status).toBe(200);
  expect(reference.headers.get("server-timing")).not.toContain("catalog_root_joint");
  expect(reference.headers.get("server-timing")).toContain("catalog_rpc_sum");
  expect(Schema.decodeUnknownSync(QueryResult)(await reference.json())).toEqual(expected);
});

test("common projection boundaries reject incomplete, invalid and oversized matrices", () => {
  const bound = [0, 8, 0, 37];
  expect(
    Schema.is(CommonTermProjection)({
      terms: ["storage"],
      partitions: [[bound]],
      independent: [[bound]],
    }),
  ).toBe(true);
  for (const malformed of [
    { terms: [], partitions: [] },
    { terms: ["storage"], partitions: [[bound]], independent: [] },
    { terms: ["storage"], partitions: [[bound]], independent: [[]] },
    { terms: ["storage"], partitions: [[bound]], independent: [[bound], [bound]] },
    { terms: ["storage"], partitions: [[bound]], independent: [[[0, -1, 0, 37]]] },
    { terms: ["storage", "storage"], partitions: [[bound, bound]] },
    { terms: ["storage", "latency"], partitions: [[bound]] },
    { terms: ["storage"], partitions: [[null]] },
    { terms: ["storage"], partitions: [[[0, 0, 0, 0]]] },
    { terms: ["storage"], partitions: [[[0, -1, 0, 37]]] },
    { terms: ["storage"], partitions: [[[0, 8.5, 0, 37]]] },
    { terms: ["storage"], partitions: [[[0, 4294967296, 0, 37]]] },
    { terms: ["storage"], partitions: Array.from({ length: 33 }, () => [bound]) },
    {
      terms: Array.from({ length: 16 }, (_, index) => `term${index}`),
      partitions: Array.from({ length: 32 }, () =>
        Array.from({ length: 16 }, () => [4294967295, 4294967295, 4294967295, 4294967295]),
      ),
    },
  ])
    expect(
      Schema.is(CommonTermProjection)(
        Object.assign(
          {
            independent: malformed.terms.map(() => [bound]),
          },
          malformed,
        ),
      ),
    ).toBe(false);
});

test("common projection byte budgets match structural encoding for escaped terms and dense bounds", () => {
  const encode = Schema.encodeSync(
    Schema.fromJsonString(Schema.Struct(CommonTermProjection.fields)),
  );
  const accepted: Array<boolean> = [];
  for (const term of ["rust", '\u0000\n"\\', "中文", "😀", "\ud800", "x".repeat(60)])
    for (const count of [1, 2, 4, 8, 16])
      for (const length of [1, 16, 64, 128]) {
        const bound = [1, 0, 4294967295, 0] as const;
        const projection = {
          terms: Array.from({ length: count }, (_value, index) => term + String(index)),
          partitions: [Array.from({ length: count }, () => bound)],
          independent: Array.from({ length: count }, () => Array.from({ length }, () => bound)),
        };
        const fits = new TextEncoder().encode(encode(projection)).byteLength <= 4096;
        accepted.push(fits);
        expect(Schema.is(CommonTermProjection)(projection)).toBe(fits);
        const decoded = Schema.decodeExit(CommonTermProjection)(projection);
        if (fits) expect(decoded._tag).toBe("Success");
        else expect(decoded._tag).toBe("Failure");
      }
  expect(accepted).toContain(true);
  expect(accepted).toContain(false);
});

test("incomplete projection validation preserves schema failures when collecting all errors", () => {
  const bound = [0, 8, 0, 37];
  for (const projection of [
    { terms: ["storage"], partitions: [[bound]], independent: [] },
    { terms: ["storage"], partitions: [[null]], independent: [[bound]] },
    { terms: ["storage", "latency"], partitions: [[bound]], independent: [[bound], [bound]] },
  ])
    for (const errors of ["first", "all"] as const)
      expect(() => Schema.decodeUnknownSync(CommonTermProjection, { errors })(projection)).toThrow(
        Schema.SchemaError,
      );
});

test("Root joint proofs preserve complete phrase results through missing proofs and cache loss", async () => {
  const results: Array<typeof QueryResult.Type> = [];
  for (const variant of ["complete", "legacy", "partial", "missing-term", "null", "catalog-loss"]) {
    const namespace = `root-joint-${variant}`;
    for (const batch of [0, 1])
      expect(
        (
          await request(
            worker,
            namespace,
            "write",
            write(
              documents.map((source) => Object.assign({}, source, { id: `${batch}-${source.id}` })),
            ),
          )
        ).status,
      ).toBe(200);
    const bucket = await worker.getR2Bucket("STORAGE");
    const key = `namespaces/${namespace}/root.json`;
    const object = await bucket.get(key);
    if (object === null) throw new Error("Missing Root");
    const root = decodeRoot(await object.text());
    expect(
      root.segments.every((segment) => Schema.is(CommonTermProjection)(segment.commonProjection)),
    ).toBe(true);
    if (
      variant === "legacy" ||
      variant === "partial" ||
      variant === "missing-term" ||
      variant === "null"
    ) {
      const changed = root.segments.map((segment, index) => {
        if (variant === "missing-term") {
          const projection = segment.commonProjection;
          if (projection === undefined || projection === null)
            throw new Error("Missing joint projection");
          return {
            ...segment,
            commonProjection: {
              terms: projection.terms.filter((term) => term !== "storage"),
              independent: projection.independent.filter(
                (_bounds, column) => projection.terms[column] !== "storage",
              ),
              partitions: projection.partitions.map((partition) =>
                partition.filter((_cell, column) => projection.terms[column] !== "storage"),
              ),
            },
          };
        }
        if (variant === "null") return { ...segment, commonProjection: null };
        if (variant === "legacy" || index === 0) return Struct.omit(segment, ["commonProjection"]);
        return segment;
      });
      await bucket.put(key, encodeRoot({ ...root, segments: changed }));
      await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
    }
    if (variant === "catalog-loss") {
      const sources = await bucket.list({
        prefix: `cache/correlated-pool-v3/namespaces/${namespace}/`,
      });
      await bucket.delete(sources.objects.map((source) => source.key));
      await evictWrittenOverviews(worker, namespace);
    }
    const response = await request(worker, namespace, "query", {
      ...textQuery(text),
      match: "phrase",
    });
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    results.push(result);
    const timing = response.headers.get("server-timing") ?? "";
    if (variant === "complete" || variant === "catalog-loss") {
      expect(timing).toContain("catalog_root_joint");
      expect(timing).not.toContain("catalog_rpc_sum");
    } else {
      expect(timing).not.toContain("catalog_root_joint");
      expect(timing).toContain("catalog_rpc_sum");
    }
  }
  const expected = results[0];
  if (expected === undefined) throw new Error("Missing phrase reference result");
  for (const result of results) expect(result).toEqual(expected);
}, 30000);

test("explicit rebuild backfills joint proofs once and preserves canonical objects and sequence", async () => {
  const namespace = "root-joint-rebuild";
  for (const batch of [0, 1, 2, 3, 4, 5])
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write(
            documents.map((source) =>
              Object.assign({}, source, {
                id: `${batch}-${source.id}`,
              }),
            ),
          ),
        )
      ).status,
    ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const key = `namespaces/${namespace}/root.json`;
  const stored = await bucket.get(key);
  if (stored === null) throw new Error("Missing Root");
  const original = decodeRoot(await stored.text());
  const before = await Promise.all(original.segments.map((segment) => bucket.head(segment.key)));
  await bucket.put(
    key,
    encodeRoot({
      ...original,
      segments: original.segments.map((segment) => Struct.omit(segment, ["commonProjection"])),
    }),
  );
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  const baseline = await request(worker, namespace, "query", {
    ...textQuery(text),
    match: "phrase",
  });
  expect(baseline.status).toBe(200);
  expect(baseline.headers.get("server-timing")).not.toContain("catalog_root_joint");
  const expected = Schema.decodeUnknownSync(QueryResult)(await baseline.json());
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const rebuilt = await bucket.get(key);
  if (rebuilt === null) throw new Error("Missing rebuilt Root");
  expect(decodeRoot(await rebuilt.text())).toEqual(original);
  const after = await Promise.all(original.segments.map((segment) => bucket.head(segment.key)));
  expect(after.map((object) => object?.etag)).toEqual(before.map((object) => object?.etag));
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  expect((await bucket.head(key))?.etag).toBe(rebuilt.etag);
  const query = await request(worker, namespace, "query", { ...textQuery(text), match: "phrase" });
  expect(query.status).toBe(200);
  expect(query.headers.get("server-timing")).toContain("catalog_root_joint");
  expect(Schema.decodeUnknownSync(QueryResult)(await query.json())).toEqual(expected);
});

test("joint bounds retain tombstones, selective filters and compaction semantics", async () => {
  const namespace = "root-joint-lifecycle";
  for (const batch of [0, 1])
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write(
            documents.map((source) =>
              Object.assign({}, source, {
                id: `${batch}-${source.id}`,
              }),
            ),
          ),
        )
      ).status,
    ).toBe(200);
  const query = { ...textQuery(text), match: "phrase" };
  const first = await request(worker, namespace, "query", query);
  expect(first.status).toBe(200);
  expect(first.headers.get("server-timing")).toContain("catalog_root_joint");
  const initial = Schema.decodeUnknownSync(QueryResult)(await first.json());
  const replaced = initial.rows[0];
  const deleted = initial.rows[1];
  if (replaced === undefined || deleted === undefined) throw new Error("Missing phrase hits");
  expect(
    (
      await request(
        worker,
        namespace,
        "write",
        write(
          [document(replaced.id, "replacement without the original phrase", { group: 0 })],
          [deleted.id],
        ),
      )
    ).status,
  ).toBe(200);
  const updated = await request(worker, namespace, "query", query);
  expect(updated.status).toBe(200);
  expect(updated.headers.get("server-timing")).toContain("catalog_root_joint");
  const expected = Schema.decodeUnknownSync(QueryResult)(await updated.json());
  expect(expected.rows.every((row) => row.id !== replaced.id && row.id !== deleted.id)).toBe(true);
  const filtered = await request(worker, namespace, "query", {
    ...query,
    filters: [{ field: "group", op: "eq", value: 0 }],
  });
  expect(filtered.status).toBe(200);
  expect(filtered.headers.get("server-timing")).not.toContain("catalog_root_joint");
  const filteredResult = Schema.decodeUnknownSync(QueryResult)(await filtered.json());
  expect(filteredResult.rows).toHaveLength(10);
  expect(filteredResult.rows.every((row) => row.attributes.group === 0)).toBe(true);
  expect((await request(worker, namespace, "compact", {})).status).toBe(200);
  const after = await request(worker, namespace, "query", query);
  expect(after.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await after.json())).toEqual(expected);
  expect(after.headers.get("server-timing")).not.toContain("catalog_root_joint");
  const object = await (
    await worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing compacted Root");
  const root = decodeRoot(await object.text());
  expect(root.segments).toHaveLength(1);
  expect(Schema.is(CommonTermProjection)(root.segments[0]?.commonProjection)).toBe(true);
});
