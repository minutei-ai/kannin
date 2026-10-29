import { expect, test } from "bun:test";
import type { DocumentColumnId } from "../src/protocol";
import { Schema } from "effect";
import { Miniflare } from "miniflare";
import {
  initSync,
  segment_build_text_fields,
  segment_local_field_statistics,
  segment_rank_fields,
} from "../dist/wasm/raio_engine";
import {
  CorpusStatistics,
  FieldBuild,
  FieldQuery,
  FieldRankHit,
  FieldStatisticsQuery,
} from "../src/protocol";
import { canonicalFixtureDocuments } from "./segment-fixture";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const encodeBuild = Schema.encodeSync(Schema.fromJsonString(FieldBuild));
const encodeQuery = Schema.encodeSync(Schema.fromJsonString(FieldQuery));
const encodeStatisticsQuery = Schema.encodeSync(Schema.fromJsonString(FieldStatisticsQuery));
const decodeStats = Schema.decodeSync(Schema.fromJsonString(CorpusStatistics), {
  onExcessProperty: "error",
});
const decodeHits = Schema.decodeSync(Schema.fromJsonString(Schema.Array(FieldRankHit)), {
  onExcessProperty: "error",
});
const title = { source: "native", role: "title" } as const;
const text = { source: "native", role: "text" } as const;
const tags = { source: "attribute", name: "tags" } as const;
const documents = [
  {
    id: "a",
    title: "nebula",
    text: "red fox",
    attributes: { tags: "blue fox", title: "red fox" },
  },
  {
    id: "b",
    title: "red fox",
    text: "nebula",
    attributes: { tags: "red fox", title: "nebula" },
  },
  {
    id: "c",
    title: "quiet",
    text: "red fox",
    attributes: { tags: "red fox", title: "nebula" },
  },
];
const build = (docs: typeof documents) =>
  segment_build_text_fields(
    encodeBuild({
      documents: canonicalFixtureDocuments(docs),
      text_fields: [{ name: "tags" }, { name: "title" }],
    }),
  );
const query = (
  fields: ReadonlyArray<typeof DocumentColumnId.Type>,
  extra: Partial<Omit<typeof FieldQuery.Type, "fields">> = {},
) => encodeQuery({ fields, text: "red fox", mode: "all", ...extra });

test("WASM named field indexing keeps attribute text distinct from native title and body", () => {
  const bytes = build(documents);
  expect(decodeHits(segment_rank_fields(bytes, query([title]))).map(({ row }) => row)).toEqual([1]);
  expect(decodeHits(segment_rank_fields(bytes, query([text]))).map(({ row }) => row)).toEqual([
    0, 2,
  ]);
  expect(decodeHits(segment_rank_fields(bytes, query([tags]))).map(({ row }) => row)).toEqual([
    1, 2,
  ]);
  expect(
    decodeHits(segment_rank_fields(bytes, query([{ source: "attribute", name: "title" }]))).map(
      ({ row }) => row,
    ),
  ).toEqual([0]);
});

test("separate segments use shared unfiltered global statistics and apply live filters afterward", () => {
  const fields = [tags] as const;
  const whole = build(documents);
  const left = build(documents.slice(0, 1));
  const right = build(documents.slice(1));
  const stats = (bytes: Uint8Array) =>
    decodeStats(
      segment_local_field_statistics(
        bytes,
        encodeStatisticsQuery({ fields, text: "red fox", mode: "all" }),
      ),
    );
  const local = [stats(left), stats(right)];
  const global = {
    documents: local.reduce((sum, value) => sum + value.documents, 0),
    fields: [
      {
        id: tags,
        tokens: local.reduce((sum, value) => sum + (value.fields[0]?.tokens ?? 0), 0),
        frequencies: { fox: 3, red: 2 },
      },
    ],
  };
  const expected = decodeHits(segment_rank_fields(whole, query(fields, { statistics: global })));
  const split = [left, right].flatMap((bytes) =>
    decodeHits(
      segment_rank_fields(
        bytes,
        query(fields, {
          statistics: global,
          filters: [{ field: "tags", op: "ne", value: "blue fox" }],
        }),
      ),
    ),
  );
  expect(split.map((hit) => hit.score)).toEqual(expected.map((hit) => hit.score));

  const tombstoned = decodeHits(segment_rank_fields(whole, query(fields, { dead: [1] })));
  expect(tombstoned.map(({ row }) => row)).toEqual([2]);
});

test("field JSON rejects unknown contract keys and unsafe global counts", () => {
  const bytes = build(documents);
  expect(() =>
    segment_rank_fields(bytes, '{"fields":[],"text":"fox","mode":"any","extra":true}'),
  ).toThrow();
  expect(() =>
    segment_rank_fields(
      bytes,
      query([tags], {
        statistics: { documents: Number.MAX_SAFE_INTEGER + 1, fields: [] },
      }),
    ),
  ).toThrow();
  expect(() =>
    segment_local_field_statistics(
      bytes,
      '{"fields":[{"source":"attribute","name":"tags"}],"text":"fox","mode":"any","top_k":1}',
    ),
  ).toThrow();
  expect(() =>
    segment_rank_fields(
      bytes,
      '{"fields":[{"source":"attribute","name":"tags"}],"text":"fox","mode":"any","filters":[{"field":"tags","op":"eq","value":9007199254740993}]}',
    ),
  ).toThrow();
});

test("named field WASM runs in workerd without platform bindings and rejects unsafe stats", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./field-ranking-worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: true,
    plugins: [
      {
        name: "wasm",
        setup(builder) {
          builder.onResolve({ filter: /^raio:wasm$/ }, () => ({
            path: "./raio_engine_bg.wasm",
            external: true,
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs);
  const script = built.outputs[0];
  if (script === undefined) throw new Error("Missing field ranking worker");
  await using cleanup = new AsyncDisposableStack();
  const worker = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    inspectorPort: 0,
    workers: [
      {
        config: {
          name: "field-ranking",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "field-ranking.js",
            modules: {
              "field-ranking.js": { type: "esm", contents: await script.text() },
              "raio_engine_bg.wasm": {
                type: "wasm",
                contents: new Uint8Array(
                  await Bun.file(
                    new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url),
                  ).arrayBuffer(),
                ),
              },
            },
          },
        },
      },
    ],
  });
  cleanup.defer(() => worker.dispose());
  const response = await worker.dispatchFetch(await worker.ready);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ documents: 2, hitRows: [1], unsafeRejected: true });
});
