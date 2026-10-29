import { expect, spyOn, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Miniflare } from "miniflare";
import { decodePublicJson, encodePublicJson } from "../src/public-json";
import { NativeJsonNumeric } from "../src/protocol";

const decode = (text: string) => Effect.runSync(decodePublicJson(text));
const encode = (value: unknown) => Effect.runSync(encodePublicJson(value));

test("public JSON retains integer bounds, nested structure, and every numeric lexeme", () => {
  const value = decode(
    '{"bounds":[-9223372036854775808,9223372036854775807,18446744073709551615],"nested":{"values":[1e+03,1.000000000000000000001,9007199254740993]},"ordinary":["text",true,null]}',
  );
  expect(encode(value)).toBe(
    '{"bounds":[-9223372036854775808,9223372036854775807,18446744073709551615],"nested":{"values":[1e+03,1.000000000000000000001,9007199254740993]},"ordinary":["text",true,null]}',
  );
});

test("public JSON emits bigint exactly and does not reinterpret numeric strings", () => {
  expect(encode({ id: 18446744073709551615n, text: "18446744073709551615" })).toBe(
    '{"id":18446744073709551615,"text":"18446744073709551615"}',
  );
});

test("invalid JSON preserves the native syntax error", () => {
  const failure = Effect.runSync(Effect.flip(decodePublicJson("{")));
  expect(failure.cause).toBeInstanceOf(SyntaxError);
});

test("numeric decoding rejects a runtime without native numeric source context", () => {
  const original = JSON.parse;
  using cleanup = new DisposableStack();
  const mocked = spyOn(JSON, "parse").mockImplementation((text, reviver) =>
    original(text, (key, value: unknown) => {
      if (reviver === undefined) return value;
      return reviver(key, value, {});
    }),
  );
  cleanup.defer(() => mocked.mockRestore());
  const failure = Effect.runSync(Effect.flip(decodePublicJson("18446744073709551615")));
  expect(failure.cause).toBeInstanceOf(TypeError);
});

test("a forged rawJSON property remains an ordinary object", () => {
  const value = decode('{"rawJSON":"18446744073709551615"}');
  expect(value).toEqual({ rawJSON: "18446744073709551615" });
  expect(encode(value)).toBe('{"rawJSON":"18446744073709551615"}');
});

test("native raw JSON transport schema rejects forged numeric fragments", () => {
  expect(Schema.is(NativeJsonNumeric)({ rawJSON: "1" })).toBe(false);
  expect(Schema.is(NativeJsonNumeric)(JSON.rawJSON("18446744073709551615"))).toBe(true);
  for (const literal of ['"text"', "null", "true", "false"]) {
    expect(Schema.is(NativeJsonNumeric)(JSON.rawJSON(literal))).toBe(false);
    const failure = Effect.runSync(Effect.flip(encodePublicJson(JSON.rawJSON(literal))));
    expect(failure.cause).toBeInstanceOf(TypeError);
  }
});

test("public JSON preserves native serialization failures and rejects non-finite numbers", () => {
  const cause = new RangeError("native serialization failed");
  const failure = Effect.runSync(
    Effect.flip(
      encodePublicJson({
        toJSON: () => {
          throw cause;
        },
      }),
    ),
  );
  expect(failure.cause).toBe(cause);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const invalid = Effect.runSync(Effect.flip(encodePublicJson({ value })));
    expect(invalid.cause).toBeInstanceOf(TypeError);
  }
});

test("native numeric lexeme transport runs in workerd", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./public-json-worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!built.success) throw new AggregateError(built.logs);
  const script = built.outputs[0];
  if (script === undefined) throw new Error("Missing public JSON worker fixture");
  const worker = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    inspectorPort: 0,
    workers: [
      {
        config: {
          name: "public-json",
          compatibilityDate: "2026-10-01",
          manifest: {
            modules: { "worker.js": { type: "esm", contents: await script.text() } },
            mainModule: "worker.js",
          },
        },
      },
    ],
  });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  const response = await worker.dispatchFetch(await worker.ready, {
    method: "POST",
    body: '{"id":18446744073709551615,"nested":[1.000000000000000000001]}',
  });
  expect(await response.text()).toBe(
    '{"id":18446744073709551615,"nested":[1.000000000000000000001]}',
  );
});
