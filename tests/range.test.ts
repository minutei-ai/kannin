import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { SegmentHeader } from "../src/protocol";
import { startWorker } from "./harness";
import {
  RangeProbeInput,
  RangeProbeResult,
  DirectoryScanInput,
  DirectoryScanResult,
  DirectoryAgingInput,
  DirectoryAgingResult,
  DecodedDirectoryScanResult,
} from "./range-contract";
import { initSync, Segment, directory_compress } from "../dist/wasm/raio_engine";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});

const artifactRoot = await mkdtemp(join(tmpdir(), "kannin-range-test-"));
const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "range-fixture.ts")],
  outdir: artifactRoot,
  naming: "worker.js",
  target: "browser",
  format: "esm",
  external: ["cloudflare:workers"],
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
if (!bundle.success) throw new AggregateError(bundle.logs);
await Bun.write(
  join(artifactRoot, "raio_engine_bg.wasm"),
  Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")),
);
const worker = await startWorker(undefined, false, artifactRoot);
afterAll(async () => {
  await worker.dispose();
  await rm(artifactRoot, { recursive: true, force: true });
});

test("simultaneous immutable range reads consume one body and share only decoded bytes", async () => {
  const key = "namespaces/range-same/segments/data.rsix";
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, new Uint8Array(1024 * 1024).fill(7));
  const response = await fetch(await worker.ready, {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))({
      key,
      offset: 0,
      length: 1024 * 1024,
      count: 32,
    }),
  });
  const result = Schema.decodeUnknownSync(RangeProbeResult)(await response.json());
  expect(result.successes).toBe(32);
  expect(result.failures).toBe(0);
  expect(result.reads).toBe(1);
  expect(result.bytes).toBe(1024 * 1024);
  expect(result.distinctBodies).toBe(1);
  expect(result.lengths).toEqual(Array.from({ length: 32 }, () => 1024 * 1024));
});

test("a failed shared acquisition is removed before retrying canonical storage", async () => {
  const key = "namespaces/range-retry/segments/data.rsix";
  const input = Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))({
    key,
    offset: 0,
    length: 16,
    count: 8,
  });
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const failed = Schema.decodeUnknownSync(RangeProbeResult)(
    await (await fetch(await worker.ready, { method: "POST", headers, body: input })).json(),
  );
  expect(failed.failures).toBe(8);
  expect(failed.reads).toBe(1);
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, new Uint8Array(16).fill(7));
  const recovered = Schema.decodeUnknownSync(RangeProbeResult)(
    await (await fetch(await worker.ready, { method: "POST", headers, body: input })).json(),
  );
  expect(recovered.successes).toBe(8);
  expect(recovered.failures).toBe(0);
  expect(recovered.reads).toBe(1);
  expect(recovered.distinctBodies).toBe(1);
});

test("a full range evicts decoded posting handles within the shared twelve-MiB budget", async () => {
  const key = "namespaces/range-shared-budget/segments/data.rsix";
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, new Uint8Array(12 * 1024 * 1024 - 512).fill(7));
  const response = await fetch(await worker.ready, {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))({
      key,
      offset: 0,
      length: 12 * 1024 * 1024 - 512,
      count: 1,
      preloadFrequency: true,
    }),
  });
  const result = Schema.decodeUnknownSync(RangeProbeResult)(await response.json());
  expect(result.postingBefore).toBeGreaterThan(0);
  expect(result.postingAfter).toBe(0);
  expect(result.rangeAfter).toBe(12 * 1024 * 1024 - 512);
  expect(result.successes).toBe(1);
  expect(result.rangeChargedAfter).toBeGreaterThan(result.rangeAfter);
  expect(result.rangeChargedAfter).toBeLessThanOrEqual(12 * 1024 * 1024);
});

test("posting range pressure does not reacquire a warm compressed directory", async () => {
  const key = "namespaces/range-directory-retention/segments/data.rsix";
  using segment = new Segment('[{"id":"a","text":"alpha","attributes":{}}]');
  const payload = new Uint8Array(16 * 1024 * 1024).fill(7);
  payload.set(segment.bytes());
  const headerBytes = 16 + new DataView(payload.buffer).getUint32(8, true);
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, payload);
  const response = await fetch(await worker.ready, {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))({
      key,
      offset: 0,
      length: headerBytes,
      count: 8,
      evictionRanges: Array.from({ length: 4 }, (_, index) => ({
        key,
        offset: index * 4 * 1024 * 1024,
        length: 4 * 1024 * 1024,
      })),
    }),
  });
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(RangeProbeResult)(await response.json());
  expect(result.reads).toBe(0);
  expect(result.encodedDirectoryCacheChargedBytes).toBeGreaterThan(0);
  expect(result.encodedDirectoryCacheChargedBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
  expect(result.successes).toBe(8);
  expect(result.failures).toBe(0);
  expect(result.distinctBodies).toBe(8);
  expect(result.matchingContents).toBe(true);
  const expected = directory_compress(segment.bytes().subarray(0, headerBytes));
  expect(result.lengths).toEqual(Array.from({ length: 8 }, () => expected.byteLength));
});

test("directories above cache admission retain the existing forty-MiB validation limit", async () => {
  const key = "namespaces/range-directory-large/segments/data.rsix";
  using segment = new Segment('[{"id":"a","text":"alpha","attributes":{}}]');
  const original = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const json = new TextEncoder().encode(
    JSON.stringify([
      original.version,
      original.documents,
      Object.fromEntries(Array.from({ length: 840000 }, (_, index) => [String(index), [0, []]])),
      original.total_title_length,
      original.total_body_length,
    ]),
  );
  const frame = new Uint8Array(16 + json.byteLength);
  frame.set(new TextEncoder().encode("RAIOSEG1"));
  const view = new DataView(frame.buffer);
  view.setUint32(8, json.byteLength, true);
  view.setUint32(12, crc32(json), true);
  frame.set(json, 16);
  expect(frame.byteLength).toBeLessThan(16 * 1024 * 1024);
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, frame);
  const response = await fetch(await worker.ready, {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))({
      key,
      offset: 0,
      length: frame.byteLength,
      count: 1,
      decodeDirectory: true,
    }),
  });
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(RangeProbeResult)(await response.json());
  expect(result.decodedDirectoryBytes).toBeGreaterThan(20 * 1024 * 1024);
  expect(result.decodedDirectoryBytes).toBeLessThanOrEqual(40 * 1024 * 1024);
  expect(result.directoryCacheChargedBytes).toBe(0);
  expect(result.successes).toBe(1);
}, 30000);

test("ranges above cache admission still return their complete uncached payload", async () => {
  const key = "namespaces/range-uncached-large/segments/data.rsix";
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, new Uint8Array(16 * 1024 * 1024).fill(7));
  const response = await fetch(await worker.ready, {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))({
      key,
      offset: 0,
      length: 16 * 1024 * 1024,
      count: 1,
      preloadFrequency: true,
    }),
  });
  const result = Schema.decodeUnknownSync(RangeProbeResult)(await response.json());
  expect(result.successes).toBe(1);
  expect(result.failures).toBe(0);
  expect(result.lengths).toEqual([16 * 1024 * 1024]);
  expect(result.rangeAfter).toBe(result.rangeBefore);
  expect(result.postingAfter).toBe(result.postingBefore);
  expect(result.postingAfter).toBeGreaterThan(0);
});

test("repeated directory scans retain a hot subset when the namespace exceeds admission", async () => {
  const entropy = new Uint8Array(2 * 1024 * 1024);
  for (const offset of Array.from(
    { length: entropy.byteLength / 65536 },
    (_, index) => index * 65536,
  ))
    crypto.getRandomValues(entropy.subarray(offset, offset + 65536));
  using segment = new Segment('[{"id":"a","text":"alpha","attributes":{}}]');
  const original = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const document = original.documents[0];
  if (document === undefined) throw new Error("Missing header fixture row");
  const json = new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(SegmentHeader))({
      ...original,
      documents: [
        {
          ...document,
          attributes: { entropy: Schema.encodeSync(Schema.Uint8ArrayFromBase64)(entropy) },
        },
      ],
    }),
  );
  const frame = new Uint8Array(16 + json.byteLength);
  frame.set(new TextEncoder().encode("RAIOSEG1"));
  const view = new DataView(frame.buffer);
  view.setUint32(8, json.byteLength, true);
  view.setUint32(12, crc32(json), true);
  frame.set(json, 16);
  const inputs = Array.from({ length: 10 }, (_, index) => ({
    key: `namespaces/range-directory-scan/segments/blob-${index}.rsix`,
    offset: 0,
    length: frame.byteLength,
  }));
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const input of inputs) await bucket.put(input.key, frame);
  const response = await fetch(new URL("/directory-scan", await worker.ready), {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryScanInput))(inputs),
  });
  expect(response.status).toBe(200);
  const reports = Schema.decodeUnknownSync(DirectoryScanResult)(await response.json());
  expect(reports[0]?.reads).toBe(10);
  const last = reports[2];
  if (last === undefined) throw new Error("Missing directory scan report");
  expect(last.encodedDirectoryCacheEntries).toBeGreaterThan(0);
  expect(last.encodedDirectoryCacheEntries).toBeLessThan(10);
  expect(last.reads).toBe(10 - last.encodedDirectoryCacheEntries);
  expect(last.encodedDirectoryCacheChargedBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
  expect(last.encodedDirectoryAdmissionChargedBytes).toBeGreaterThan(0);
  expect(last.encodedDirectoryAdmissionChargedBytes).toBeLessThanOrEqual(1024 * 1024);
}, 30000);

test("decoded directory scans retain validated metadata beyond cache capacity", async () => {
  using segment = new Segment('[{"id":"a","text":"alpha","attributes":{}}]');
  const original = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const json = new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(SegmentHeader))({
      ...original,
      terms: {
        ...original.terms,
        ...Object.fromEntries(
          Array.from({ length: 40000 }, (_, index) => [`term${index}`, { df: 0, blocks: [] }]),
        ),
      },
    }),
  );
  const frame = new Uint8Array(16 + json.byteLength);
  frame.set(new TextEncoder().encode("RAIOSEG1"));
  const view = new DataView(frame.buffer);
  view.setUint32(8, json.byteLength, true);
  view.setUint32(12, crc32(json), true);
  frame.set(json, 16);
  const inputs = Array.from({ length: 8 }, (_, index) => ({
    key: `namespaces/decoded-directory-scan/segments/blob-${index}.rsix`,
    offset: 0,
    length: frame.byteLength,
  }));
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const input of inputs) await bucket.put(input.key, frame);
  const response = await fetch(new URL("/decoded-directory-scan", await worker.ready), {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryScanInput))(inputs),
  });
  expect(response.status).toBe(200);
  const reports = Schema.decodeUnknownSync(DecodedDirectoryScanResult)(await response.json());
  expect(reports[0]?.hits).toBe(0);
  for (const report of reports) {
    expect(report.metadata).toEqual(inputs.map(() => original.terms));
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.bytes).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(report.history).toBeLessThanOrEqual(1024 * 1024);
  }
  expect(reports[1]?.hits).toBeGreaterThan(0);
  expect(reports[2]?.hits).toBeGreaterThanOrEqual(reports[1]?.hits ?? 0);
}, 30000);

test("directory admission ages cold history while retaining a repeatedly read header", async () => {
  using segment = new Segment('[{"id":"a","text":"alpha","attributes":{}}]');
  const bytes = segment.bytes();
  const headerBytes = 16 + new DataView(bytes.buffer).getUint32(8, true);
  const bucket = await worker.getR2Bucket("STORAGE");
  const hot = {
    key: "namespaces/range-directory-aging/segments/hot.rsix",
    offset: 0,
    length: headerBytes,
  };
  const cold = {
    key: "namespaces/range-directory-aging/segments/cold.rsix",
    offset: 0,
    length: headerBytes,
  };
  for (const input of [hot, cold]) await bucket.put(input.key, bytes);
  const response = await fetch(new URL("/directory-aging", await worker.ready), {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryAgingInput))([hot, cold]),
  });
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(DirectoryAgingResult)(await response.json());
  expect(result.reads).toBe(0);
  expect(result.hits).toBe(4096);
  expect(result.after).toBeGreaterThan(0);
  expect(result.after).toBeLessThan(result.before);
});
