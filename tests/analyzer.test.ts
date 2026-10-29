import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Miniflare } from "miniflare";
import { initSync, tokenize, word_v4 } from "../dist/wasm/raio_engine";
import { AnalyzedTokens, WordV4Config } from "../src/protocol";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const encode = Schema.encodeSync(Schema.fromJsonString(WordV4Config));
const decode = Schema.decodeSync(Schema.fromJsonString(AnalyzedTokens), {
  onExcessProperty: "error",
});
const defaults = {
  max_token_length: 39,
  case_sensitive: false,
  stopwords: "english",
  stemming: null,
  ascii_folding: false,
} as const;
function analyze(inputs: readonly string[], options: Partial<typeof WordV4Config.Type> = {}) {
  return decode(word_v4(encode({ ...defaults, ...options }), JSON.stringify(inputs)));
}

test("word_v4 preserves accents, stopword gaps and raw UTF-8 spans independently of native text", () => {
  const tokens = analyze(["The CAFÉ and foxes"]);
  expect(tokens).toEqual([
    {
      text: "café",
      position: 1,
      position_length: 1,
      input_index: 0,
      byte_start: 4,
      byte_end: 9,
    },
    {
      text: "foxes",
      position: 3,
      position_length: 1,
      input_index: 0,
      byte_start: 14,
      byte_end: 19,
    },
  ]);
  expect(tokenize("The CAFÉ and foxes")).toBe("the cafe and foxes");
});

test("word_v4 retains array boundaries and filtered positions across empty elements", () => {
  const tokens = analyze(["fox", "", "the dog"]);
  expect(
    tokens.map(({ text, position, input_index }) => ({ text, position, input_index })),
  ).toEqual([
    { text: "fox", position: 0, input_index: 0 },
    { text: "dog", position: 2, input_index: 2 },
  ]);
  expect(analyze(["fox dog"]).map((token) => token.input_index)).toEqual([0, 0]);
  expect(analyze([])).toEqual([]);
});

test("word_v4 filters by character length before case or accent folding", () => {
  expect(
    analyze(["éé abc defg x"], { max_token_length: 3 }).map(({ text, position }) => [
      text,
      position,
    ]),
  ).toEqual([
    ["éé", 0],
    ["abc", 1],
    ["x", 3],
  ]);
  expect(analyze(["CAFÉ"], { ascii_folding: true }).map((token) => token.text)).toEqual(["cafe"]);
});

test("word_v4 executes stemming with WASM randomness and keeps reusable analyses independent", () => {
  expect(analyze(["running foxes"], { stemming: "english" }).map((token) => token.text)).toEqual([
    "run",
    "fox",
  ]);
  expect(analyze(["foxes"]).map((token) => token.text)).toEqual(["foxes"]);
  expect(
    analyze(["The THE"], { case_sensitive: true, stopwords: null }).map((token) => token.text),
  ).toEqual(["The", "THE"]);
});

test("word_v4 handles escaped JSON and preserves input byte ranges after normalization", () => {
  const inputs = ['CAFÉ\n"fox"', "cafe\u0301"];
  const tokens = analyze(inputs);
  expect(tokens.map((token) => token.text)).toEqual(["café", "fox", "cafe\u0301"]);
  expect(
    tokens.map((token) =>
      new TextDecoder().decode(
        new TextEncoder()
          .encode(inputs[token.input_index])
          .subarray(token.byte_start, token.byte_end),
      ),
    ),
  ).toEqual(["CAFÉ", "fox", "cafe\u0301"]);
});

test("word_v4 rejects unsupported configuration and oversized boundaries without native panics", () => {
  for (const config of [
    { max_token_length: 0 },
    { max_token_length: 256 },
    { max_token_length: 1.5 },
    { case_sensitive: true },
    { stopwords: "arabic" },
    { stemming: "unsupported" },
    { tokenizer: "unknown" },
  ])
    expect(() => word_v4(JSON.stringify(config), '["fox"]')).toThrow();
  expect(() => word_v4("{}", '"fox"')).toThrow();
  expect(() => word_v4("{}", "[null]")).toThrow();
  expect(() => word_v4("{}", JSON.stringify(["x".repeat(2 * 1024 * 1024)]))).toThrow("byte budget");
  expect(() => word_v4("{}", JSON.stringify(["fox ".repeat(65_537)]))).toThrow("token budget");
  expect(analyze(["fox"])).toHaveLength(1);
});

test("word_v4 stemming runs in workerd with the same WASM and no platform bindings", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./analyzer-worker.ts", import.meta.url).pathname],
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
  if (script === undefined) throw new Error("Missing analyzer worker");
  await using cleanup = new AsyncDisposableStack();
  const worker = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    inspectorPort: 0,
    workers: [
      {
        config: {
          name: "analyzer",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "analyzer.js",
            modules: {
              "analyzer.js": { type: "esm", contents: await script.text() },
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
  const tokens = decode(await response.text());
  expect(tokens.map(({ text, position, input_index }) => [text, position, input_index])).toEqual([
    ["run", 1, 0],
    ["fox", 2, 0],
    ["café", 3, 1],
  ]);
});
