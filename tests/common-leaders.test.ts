import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { initSync, Segment, Directory, PreparedQuery } from "../dist/wasm/raio_engine";
import {
  CommonLeaders,
  CommonTerms,
  SegmentHeader,
  StoredDocument,
  RankingInput,
  PostingSpans,
  SegmentHits,
  QueryResult,
} from "../src/protocol";
import { clearLeaderIndex, document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});
const worker = await startWorker();
afterAll(() => worker.dispose());

test("canonical leaders equal complete posting rankings only when their proof is sufficient", () => {
  for (const field of ["title", "body"] as const) {
    const documents = Array.from({ length: 200 }, (_, index) => {
      const text = `rust cloudflare ação ${"padding ".repeat(index % 5)}`;
      const result = {
        id: `\uffff${String(index).padStart(4, "0")}`,
        revision: 0,
        title: "irrelevant",
        text: "irrelevant",
        attributes: {},
      };
      if (index === 0) result.id = "\u{10000}";
      if (index === 5) result.id = "\ue000";
      if (field === "title") result.title = text;
      else result.text = text;
      return result;
    });
    using segment = new Segment(
      Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents),
    );
    const bytes = segment.bytes();
    const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
    using directory = Directory.canonical(bytes.subarray(0, base), base);
    const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
    const leaders = Schema.decodeSync(Schema.fromJsonString(CommonLeaders))(
      segment.common_leaders(),
    );
    const catalog = Schema.decodeSync(Schema.fromJsonString(CommonTerms))(segment.common_terms());
    expect(directory.common_leaders()).toBe(segment.common_leaders());
    const chosen = leaders.find((leader) => leader.field === field);
    if (chosen === undefined) throw new Error("Missing minimum-length leaders");
    expect(chosen.documents).toHaveLength(16);
    expect(chosen.terms).toContain("rust");
    expect(chosen.terms).toContain("cloudflare");
    for (const scale of [1, 5000]) {
      const statistics = {
        documents: documents.length * scale,
        title_length: header.total_title_length * scale,
        body_length: header.total_body_length * scale,
        frequencies: Object.fromEntries(
          Object.entries(header.terms).map(([term, meta]) => [term, meta.df * scale]),
        ),
      };
      for (const topK of [1, 10, 16, 17]) {
        for (const [text, phraseLeader] of [
          ["RUST cloudflare ação rust", false],
          ["RUST", true],
          ["AÇÃO!!!", true],
          ["rust rust", false],
        ] as const) {
          for (const mode of ["any", "all", "phrase"] as const) {
            for (const dead of [[], [0], chosen.documents.slice(0, 7).map((hit) => hit.row)]) {
              const input = {
                text,
                mode,
                top_k: topK,
                dead: [],
                filters: [],
                statistics,
              };
              using prepared = new PreparedQuery(
                Schema.encodeSync(Schema.fromJsonString(RankingInput))(input),
              );
              const fast = prepared.common_hits(
                JSON.stringify(catalog),
                JSON.stringify(leaders),
                documents.length,
                JSON.stringify(dead),
              );
              const available = chosen.documents.filter((hit) => !dead.includes(hit.row));
              if ((mode === "phrase" && !phraseLeader) || available.length < topK) {
                expect(fast).toBeUndefined();
                continue;
              }
              using ranker = directory.ranker_prepared(prepared, JSON.stringify(dead));
              for (const span of Schema.decodeSync(Schema.fromJsonString(PostingSpans))(
                ranker.posting_spans(),
              ))
                for (const block of span.blocks)
                  ranker.add(
                    span.term,
                    bytes.subarray(
                      base + block.data.offset,
                      base + block.data.offset + block.data.length,
                    ),
                  );
              expect(fast).toBeDefined();
              expect(Schema.decodeUnknownSync(Schema.fromJsonString(SegmentHits))(fast)).toEqual(
                Schema.decodeSync(Schema.fromJsonString(SegmentHits))(ranker.finish()),
              );
            }
          }
        }
      }
      for (const text of ["padding", "rust irrelevant"]) {
        using unsupported = new PreparedQuery(
          Schema.encodeSync(Schema.fromJsonString(RankingInput))({
            text,
            mode: "any",
            top_k: 10,
            dead: [],
            filters: [],
            statistics,
          }),
        );
        expect(
          unsupported.common_hits(
            JSON.stringify(catalog),
            JSON.stringify(leaders),
            documents.length,
            "[]",
          ),
        ).toBeUndefined();
      }
      using filtered = new PreparedQuery(
        Schema.encodeSync(Schema.fromJsonString(RankingInput))({
          text: "rust",
          mode: "any",
          top_k: 10,
          dead: [],
          filters: [{ field: "absent", op: "exists", value: false }],
          statistics,
        }),
      );
      expect(
        filtered.common_hits(
          JSON.stringify(catalog),
          JSON.stringify(leaders),
          documents.length,
          "[]",
        ),
      ).toBeUndefined();
    }
    using invalid = new PreparedQuery(
      Schema.encodeSync(Schema.fromJsonString(RankingInput))({
        text: "rust",
        mode: "any",
        top_k: 10,
        dead: [],
        filters: [],
        statistics: {
          documents: 200,
          title_length: header.total_title_length,
          body_length: header.total_body_length,
          frequencies: { rust: 200 },
        },
      }),
    );
    expect(() =>
      invalid.common_hits(JSON.stringify(catalog), "[".repeat(16385), 200, "[]"),
    ).toThrow();
    expect(() =>
      invalid.common_hits(
        JSON.stringify(catalog),
        '[{"field":"body","terms":["rust"],"length":1,"longer":false,"documents":[{"row":0,"id":"","data":{"offset":0,"length":8}}]}]',
        200,
        "[]",
      ),
    ).toThrow();
    expect(() =>
      invalid.common_hits(JSON.stringify(catalog), JSON.stringify(leaders), 200, "[0,0]"),
    ).toThrow();
    expect(() =>
      invalid.common_hits(JSON.stringify(catalog), JSON.stringify(leaders), 200, "[200]"),
    ).toThrow();
    expect(
      invalid.common_hits(
        JSON.stringify(catalog),
        JSON.stringify(
          leaders.map((leader) => Object.assign({}, leader, { longer: true, length: 4294967295 })),
        ),
        200,
        "[]",
      ),
    ).toBeUndefined();
  }
});

test("leader ranking survives mutations and compaction with exact filtered controls", async () => {
  const name = "common-leader-mutations";
  for (const batch of Array.from({ length: 8 }, (_, index) => index)) {
    const docs = Array.from({ length: 64 }, (_, index) =>
      document(
        `${batch}-${String(index).padStart(3, "0")}`,
        `rust cloudflare ${"padding ".repeat(index % 4)}`,
        { year: 2025 },
      ),
    );
    expect((await request(worker, name, "write", write(docs))).status).toBe(200);
  }
  for (const mode of ["any", "all", "phrase"] as const) {
    const response = await request(worker, name, "query", {
      ...textQuery("rust cloudflare"),
      match: mode,
    });
    const control = await request(worker, name, "query", {
      ...textQuery("rust cloudflare", 10, [{ field: "year", op: "gte", value: 0 }]),
      match: mode,
    });
    expect(response.status).toBe(200);
    expect(control.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(
      Schema.decodeUnknownSync(QueryResult)(await control.json()),
    );
    if (mode === "phrase")
      expect(response.headers.get("server-timing")).toContain(
        'text_common_leaders;desc="segments=0"',
      );
    else
      expect(response.headers.get("server-timing")).toMatch(
        /text_common_leaders;desc="segments=[1-9]/,
      );
  }
  const phrase = await request(worker, name, "query", {
    ...textQuery("RUST"),
    match: "phrase",
  });
  expect(phrase.status).toBe(200);
  expect(phrase.headers.get("server-timing")).toMatch(/text_common_leaders;desc="segments=[1-9]/);
  expect(phrase.headers.get("server-timing")).toContain('catalog_root_prefix;desc="hit"');
  expect(phrase.headers.get("server-timing")).not.toContain('catalog_root_joint;desc="hit"');
  const phraseResult = Schema.decodeUnknownSync(QueryResult)(await phrase.json());
  const phraseControl = await request(worker, name, "query", {
    ...textQuery("RUST", 10, [{ field: "year", op: "gte", value: 0 }]),
    match: "phrase",
  });
  expect(phraseControl.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await phraseControl.json())).toEqual(phraseResult);
  await clearLeaderIndex(worker, name);
  const withoutLeaders = await request(worker, name, "query", {
    ...textQuery("RUST"),
    match: "phrase",
  });
  expect(withoutLeaders.status).toBe(200);
  expect(withoutLeaders.headers.get("server-timing")).toContain(
    'text_common_leaders;desc="segments=0"',
  );
  expect(Schema.decodeUnknownSync(QueryResult)(await withoutLeaders.json())).toEqual(phraseResult);
  expect(withoutLeaders.headers.get("server-timing")).toContain('catalog_root_joint;desc="hit"');
  const deletes = Array.from({ length: 8 }, (_, batch) =>
    Array.from(
      { length: 7 },
      (_iteration, index) => `${batch}-${String(index * 4).padStart(3, "0")}`,
    ),
  ).flat();
  expect((await request(worker, name, "write", { ...write([]), deletes })).status).toBe(200);
  const deleted = await request(worker, name, "query", textQuery("rust cloudflare"));
  expect(deleted.headers.get("server-timing")).toContain('text_common_leaders;desc="segments=0"');
  const before = Schema.decodeUnknownSync(QueryResult)(await deleted.json());
  expect(before.rows.every((row) => !deletes.includes(row.id))).toBe(true);
  const control = await request(
    worker,
    name,
    "query",
    textQuery("rust cloudflare", 10, [{ field: "year", op: "gte", value: 0 }]),
  );
  expect(before).toEqual(Schema.decodeUnknownSync(QueryResult)(await control.json()));
  expect((await request(worker, name, "compact", {})).status).toBe(200);
  const compacted = await request(worker, name, "query", textQuery("rust cloudflare"));
  expect(compacted.headers.get("server-timing")).toMatch(
    /text_common_leaders;desc="segments=[1-9]/,
  );
  expect(Schema.decodeUnknownSync(QueryResult)(await compacted.json())).toEqual(before);
});
