import { expect, test } from "bun:test";
import { Schema } from "effect";
import { initSync, Segment, segment_header, VectorRanker } from "../dist/wasm/raio_engine";
import {
  DistanceMetric,
  NativeVectorHits,
  SegmentHeader,
  VectorDistanceHits,
} from "../src/protocol";
import { encodeCanonicalDocuments } from "./segment-fixture";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const decode = Schema.decodeSync(Schema.fromJsonString(VectorDistanceHits), {
  onExcessProperty: "error",
});
const decodeNative = Schema.decodeSync(Schema.fromJsonString(NativeVectorHits));
const decodeHeader = Schema.decodeSync(Schema.fromJsonString(SegmentHeader), {
  onExcessProperty: "error",
});
function frame(vector: readonly number[]) {
  using segment = new Segment(
    encodeCanonicalDocuments([
      { id: "frame", text: "vector", attributes: {}, vector: [...vector] },
    ]),
  );
  const bytes = segment.bytes();
  const header = decodeHeader(segment_header(bytes));
  const range = header.vector_ranges[0];
  if (range === undefined) throw new Error("Missing persisted vector frame");
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  return bytes.slice(base + range.offset, base + range.offset + range.length);
}

test("distance metrics rank persisted frames in ascending order while native similarity stays unchanged", () => {
  using distance = VectorRanker.with_metric(new Float32Array([1, 0]), 3, "cosine_distance");
  using native = new VectorRanker(new Float32Array([1, 0]), 3);
  for (const [key, values] of [
    ["opposite", [-1, 0]],
    ["orthogonal", [0, 2]],
    ["parallel", [10, 0]],
  ] as const) {
    const bytes = frame(values);
    distance.push_frame(key, bytes);
    native.push_frame(key, bytes);
  }
  expect(decode(distance.finish())).toEqual([
    ["parallel", 0],
    ["orthogonal", 1],
    ["opposite", 2],
  ]);
  expect(decodeNative(native.finish())).toEqual([
    ["parallel", 1],
    ["orthogonal", 0],
    ["opposite", -1],
  ]);
});

test("squared Euclidean uses raw vector magnitude and supports zero query vectors", () => {
  using ranker = VectorRanker.with_metric(new Float32Array([3, 4]), 1, "euclidean_squared");
  expect(ranker.push_frame("parallel", frame([6, 8]))).toBeUndefined();
  expect(ranker.push_frame("same", frame([3, 4]))).toBe("parallel");
  expect(decode(ranker.finish())).toEqual([["same", 0]]);
  using origin = VectorRanker.with_metric(new Float32Array([0, 0]), 1, "euclidean_squared");
  origin.push_frame("distance-five", frame([3, 4]));
  expect(decode(origin.finish())).toEqual([["distance-five", 25]]);
  expect(() => VectorRanker.with_metric(new Float32Array([0]), 1, "cosine_distance")).toThrow();
  expect(() => new VectorRanker(new Float32Array([0]), 1)).toThrow();
});

test("every explicit distance mode preserves retained results after malformed frame offers", () => {
  for (const metric of ["cosine_distance", "euclidean_squared"] as const) {
    using ranker = VectorRanker.with_metric(new Float32Array([1, 0]), 1, metric);
    const valid = frame([1, 0]);
    ranker.push_frame("retained", valid);
    const expected = ranker.finish();
    const corrupt = new Uint8Array(valid);
    corrupt[4] = (corrupt[4] ?? 0) ^ 1;
    for (const invalid of [corrupt, frame([1]), new Uint8Array([255, 255, 255, 255])]) {
      expect(() => ranker.push_frame("invalid", invalid)).toThrow();
      expect(ranker.finish()).toBe(expected);
    }
    expect(() => ranker.push_frame("retained", valid)).toThrow();
    expect(ranker.finish()).toBe(expected);
  }
});

test("explicit metric and hit contracts reject unsupported modes, negative distances and oversized bounds", () => {
  for (const metric of ["dot_product", "COSINE_DISTANCE", ""]) {
    expect(() => VectorRanker.with_metric(new Float32Array([1]), 1, metric)).toThrow();
    expect(Schema.is(DistanceMetric)(metric)).toBe(false);
  }
  for (const metric of ["cosine_distance", "euclidean_squared"] as const) {
    expect(() => VectorRanker.with_metric(new Float32Array([1]), 0, metric)).toThrow();
    expect(() => VectorRanker.with_metric(new Float32Array([1]), 10_001, metric)).toThrow();
    expect(() => VectorRanker.with_metric(new Float32Array([Number.NaN]), 1, metric)).toThrow();
    using bounded = VectorRanker.with_metric(new Float32Array([1]), 10_000, metric);
    expect(decode(bounded.finish())).toEqual([]);
    const key = "x".repeat(512);
    bounded.push_frame(key, frame([1]));
    expect(decode(bounded.finish())).toEqual([[key, 0]]);
    expect(() => bounded.push_frame("x".repeat(513), frame([1]))).toThrow();
    expect(decode(bounded.finish())).toEqual([[key, 0]]);
  }
  expect(() => decode('[["id",-1]]')).toThrow();
  expect(() => decode('[["id",1e309]]')).toThrow();
  expect(() => decode('[["",0]]')).toThrow();
});
