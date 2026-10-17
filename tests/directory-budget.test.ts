import { expect, test } from "bun:test";
import { Effect, Match, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Response } from "miniflare";
import { initSync, Segment, Directory, directory_compress } from "../dist/wasm/raio_engine";
import { QueryResult, Root, SegmentHeader, TermProjectionRange } from "../src/protocol";
import { corpus } from "../tooling/corpus";
import { DirectoryBudgetInput } from "./range-contract";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});
const documents = Array.from({ length: 10 }, (_, index) => corpus(index * 500, 1000000)).flat();
using segment = new Segment(JSON.stringify(documents));
const canonical = segment.bytes();
const length = 16 + new DataView(canonical.buffer, canonical.byteOffset).getUint32(8, true);
const frame = new Uint8Array(directory_compress(canonical.subarray(0, length)));
using smallSegment = new Segment(JSON.stringify([document("a", "alpha")]));
const smallCanonical = smallSegment.bytes();
const smallLength =
  16 + new DataView(smallCanonical.buffer, smallCanonical.byteOffset).getUint32(8, true);
const smallFrame = new Uint8Array(directory_compress(smallCanonical.subarray(0, smallLength)));
const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());

const final = header.documents[4999];
if (final === undefined) throw new Error("Missing fixture row");

function directoryWithLength(expected: number) {
  const first = documents[0];
  if (first === undefined) throw new Error("Missing fixture document");
  const boundary = { padding: expected - length, bytes: canonical, length };
  for (const attempt of Array.from({ length: 8 }, (_, index) => index)) {
    using built = new Segment(
      JSON.stringify([
        { ...first, attributes: { ...first.attributes, padding: "x".repeat(boundary.padding) } },
        ...documents.slice(1),
      ]),
    );
    boundary.bytes = built.bytes();
    boundary.length =
      16 + new DataView(boundary.bytes.buffer, boundary.bytes.byteOffset).getUint32(8, true);
    if (boundary.length === expected) return boundary;
    boundary.padding += expected - boundary.length;
    if (attempt === 7) throw new Error("Unable to construct directory boundary");
  }
  throw new Error("Missing directory boundary");
}

const admissionLarge = directoryWithLength(2 * 1024 * 1024);
const admissionLargeFrame = new Uint8Array(
  directory_compress(admissionLarge.bytes.subarray(0, admissionLarge.length)),
);

async function fixture() {
  await using cleanup = new AsyncDisposableStack();
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-directory-budget-"));
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "directory-budget-fixture.ts")],
    outdir: artifacts,
    naming: "worker.js",
    target: "browser",
    format: "esm",
    minify: true,
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
  if (!built.success) throw new AggregateError(built.logs);
  await Bun.write(
    join(artifacts, "raio_engine_bg.wasm"),
    Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")),
  );
  const worker = await startWorker(undefined, false, artifacts);
  cleanup.defer(async () => {
    await worker.dispose();
  });
  const lifetime = cleanup.move();
  return { worker, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

async function cacheFrame(
  worker: Awaited<ReturnType<typeof startWorker>>,
  key: string,
  headerBytes: number,
  bytes: Uint8Array,
) {
  const cacheKey = new URL("https://raio-cache.internal/directory-v2");
  cacheKey.searchParams.set("key", key);
  cacheKey.searchParams.set("offset", "0");
  cacheKey.searchParams.set("length", String(headerBytes));
  cacheKey.searchParams.set("bucket", "raio-test");
  cacheKey.searchParams.set("format", "compact-json-v2");
  await (
    await (await worker.getCaches()).open("raio-segments-v1")
  ).put(
    cacheKey,
    new Response(new Uint8Array(bytes), { headers: { "cache-control": "public, max-age=3600" } }),
  );
}

test("R2 directory frames recover cold readers with compressed bytes across isolates", async () => {
  const key = "namespaces/directory-r2/segments/shared.rsix";
  const identity = `cache/directory-v2/${key}/${length}`;
  const input = Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
    key,
    offset: 0,
    length,
    count: 32,
  });
  await using first = await fixture();
  const bucket = await first.worker.getR2Bucket("STORAGE");
  await bucket.put(key, canonical);
  await cacheFrame(first.worker, key, length, frame);
  const initial = await fetch(await first.worker.ready, { method: "POST", body: input });
  expect(initial.status).toBe(200);
  expect(new Uint8Array(await initial.arrayBuffer())).toEqual(frame);
  expect(initial.headers.get("x-fallback-bytes")).toBe(String(length));
  for (const attempt of Array.from({ length: 40 }, (_, index) => index)) {
    if ((await bucket.head(identity)) !== null) break;
    if (attempt === 39) throw new Error("Directory publication did not settle");
    await Effect.runPromise(Effect.sleep("50 millis"));
  }
  const saved = await bucket.get(identity);
  if (saved === null) throw new Error("Missing directory frame");
  const bytes = new Uint8Array(await saved.arrayBuffer());
  expect(bytes).toEqual(frame);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(TermProjectionRange))(
      saved.customMetadata?.source,
    ),
  ).toEqual({ key, headerBytes: length });
  await using second = await fixture();
  const remote = await second.worker.getR2Bucket("STORAGE");
  await remote.put(key, canonical);
  await remote.put(identity, bytes, {
    customMetadata: {
      source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
        key,
        headerBytes: length,
      }),
    },
  });
  await cacheFrame(second.worker, key, length, frame);
  const recovered = await fetch(await second.worker.ready, { method: "POST", body: input });
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(frame);
  expect(recovered.headers.get("x-fallbacks")).toBe("0");
  expect(recovered.headers.get("x-fallback-bytes")).toBe("0");
  expect(recovered.headers.get("x-directory-r2-hits")).toBe("1");
  expect(recovered.headers.get("x-directory-r2-bytes")).toBe(String(frame.byteLength));
  expect(recovered.headers.get("x-distinct-bodies")).toBe("1");
  expect(frame.byteLength).toBeLessThan(length);
}, 15000);

test("invalid R2 directory frames recover canonical data and repair disposable artifacts", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const failure of ["checksum", "identity", "oversized", "missing"]) {
    const key = `namespaces/directory-r2/segments/${failure}.rsix`;
    const identity = `cache/directory-v2/${key}/${length}`;
    await bucket.put(key, canonical);
    await cacheFrame(worker, key, length, frame);
    const bytes = frame.slice();
    if (failure === "checksum") bytes[16] = (bytes[16] ?? 0) ^ 1;
    const source = { key, headerBytes: length };
    if (failure === "identity") source.key = "namespaces/other/segments/other.rsix";
    const metadata = {
      source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))(source),
    };
    if (failure === "oversized")
      await bucket.put(identity, new Uint8Array(length + 8193), { customMetadata: metadata });
    else if (failure !== "missing") await bucket.put(identity, bytes, { customMetadata: metadata });
    const response = await fetch(await worker.ready, {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
        key,
        offset: 0,
        length,
        count: 8,
      }),
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
    expect(response.headers.get("x-fallbacks")).toBe("1");
    expect(response.headers.get("x-fallback-bytes")).toBe(String(length));
    if (failure === "missing") expect(response.headers.get("x-directory-r2-rejected")).toBe("0");
    else expect(response.headers.get("x-directory-r2-rejected")).toBe("1");
    for (const attempt of Array.from({ length: 40 }, (_, index) => index)) {
      const repaired = await bucket.get(identity);
      if (
        repaired !== null &&
        repaired.size === frame.byteLength &&
        repaired.customMetadata?.source ===
          Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
            key,
            headerBytes: length,
          })
      ) {
        expect(new Uint8Array(await repaired.arrayBuffer())).toEqual(frame);
        break;
      }
      if (attempt === 39) throw new Error("Directory repair did not settle");
      if (repaired !== null) await repaired.body.cancel();
      await Effect.runPromise(Effect.sleep("50 millis"));
    }
  }
}, 15000);

test("malformed native directory responses recover through bounded canonical reads", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const key = "namespaces/directory-native-corrupt/segments/header.rsix";
  await (await worker.getR2Bucket("STORAGE")).put(key, canonical);
  expect((await fetch(new URL("/corrupt-directory", await worker.ready))).status).toBe(204);
  const body = Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
    key,
    offset: 0,
    length,
    count: 8,
  });
  const response = await fetch(await worker.ready, { method: "POST", body });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  expect(response.headers.get("x-fallbacks")).toBe("1");
  expect(response.headers.get("x-fallback-bytes")).toBe(String(length));
  using expected = Directory.compressed(frame, length);
  const decoded = await fetch(new URL("/decoded", await worker.ready), { method: "POST", body });
  expect(decoded.status).toBe(200);
  expect(await decoded.text()).toBe(expected.terms('["unique3711"]'));
  const repeated = await fetch(await worker.ready, { method: "POST", body });
  expect(repeated.status).toBe(200);
  expect(new Uint8Array(await repeated.arrayBuffer())).toEqual(frame);
  expect(repeated.headers.get("x-fallbacks")).toBe("0");
  const missing = await fetch(await worker.ready, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key: "namespaces/directory-native-corrupt/segments/missing.rsix",
      offset: 0,
      length,
      count: 1,
    }),
    signal: AbortSignal.timeout(5000),
  });
  expect(missing.status).toBe(503);
});

test("unavailable R2 directory cache preserves canonical recovery", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const key = "namespaces/directory-r2/segments/unavailable.rsix";
  await (await worker.getR2Bucket("STORAGE")).put(key, canonical);
  await cacheFrame(worker, key, length, frame);
  expect((await fetch(new URL("/cache-failure", await worker.ready))).status).toBe(204);
  const response = await fetch(await worker.ready, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length,
      count: 8,
    }),
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  expect(response.headers.get("x-fallbacks")).toBe("1");
  expect(response.headers.get("x-fallback-bytes")).toBe(String(length));
});

test("segment origins validate R2 frames before publishing the native Cache API response", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const key = "namespaces/directory-origin/segments/shared.rsix";
  const identity = `cache/directory-v2/${key}/${length}`;
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, canonical);
  await bucket.put(identity, frame, {
    customMetadata: {
      source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
        key,
        headerBytes: length,
      }),
    },
  });
  const body = Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
    key,
    offset: 0,
    length,
    count: 1,
  });
  const response = await fetch(new URL("/origin", await worker.ready), { method: "POST", body });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-raio-cache")).toBe("r2-directory-hit");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  const decoded = await fetch(new URL("/decoded", await worker.ready), { method: "POST", body });
  expect(decoded.status).toBe(200);
  using expected = Directory.compressed(frame, length);
  expect(await decoded.text()).toBe(expected.terms('["unique3711"]'));
  expect(decoded.headers.get("x-directory-hits")).toBe("1");
  expect(Number(decoded.headers.get("x-directory-bytes"))).toBeGreaterThan(0);
  expect(Number(decoded.headers.get("x-directory-bytes"))).toBeLessThanOrEqual(20 * 1024 * 1024);
  expect((await fetch(new URL("/fast-origin", await worker.ready))).status).toBe(204);
  const relayed = await fetch(await worker.ready, { method: "POST", body });
  expect(relayed.status).toBe(200);
  expect(new Uint8Array(await relayed.arrayBuffer())).toEqual(frame);
  expect(relayed.headers.get("x-directory-r2-origins")).toBe("1");
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-canonical-reads")).toBe("0");
  await bucket.delete(identity);
  for (const attempt of Array.from({ length: 40 }, (_, index) => index)) {
    const cached = await fetch(new URL("/origin", await worker.ready), { method: "POST", body });
    expect(cached.status).toBe(200);
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(frame);
    if (cached.headers.get("x-raio-cache") === "api-hit") break;
    if (attempt === 39) throw new Error("Cache API publication did not settle");
    await Effect.runPromise(Effect.sleep("50 millis"));
  }
});

test("canonical catalog acquisition retains validated metadata without rebuilding directory frames", async () => {
  await using active = await fixture();
  const worker = active.worker;
  expect((await fetch(new URL("/fast-origin", await worker.ready))).status).toBe(204);
  const key = "namespaces/canonical-catalog/segments/source.rsix";
  await (await worker.getR2Bucket("STORAGE")).put(key, canonical);
  const response = await fetch(new URL("/decoded-canonical", await worker.ready), {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length,
      count: 8,
    }),
  });
  expect(response.status).toBe(200);
  using expected = new Directory(canonical);
  expect(await response.text()).toBe(expected.terms('["unique3711"]'));
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-directory-parses")).toBe("0");
  expect(state.headers.get("x-directory-publications")).toBe("0");
  expect(state.headers.get("x-canonical-reads")).toBe("1");
});

test("catalog recovery reuses a surviving compressed R2 directory before canonical bytes", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const key = "namespaces/canonical-partial-loss/segments/source.rsix";
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, canonical);
  await bucket.put(`cache/directory-v2/${key}/${length}`, frame, {
    customMetadata: {
      source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
        key,
        headerBytes: length,
      }),
    },
  });
  const response = await fetch(new URL("/decoded-canonical", await worker.ready), {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length,
      count: 1,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  using expected = new Directory(canonical);
  expect(await response.text()).toBe(expected.terms('["unique3711"]'));
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-canonical-reads")).toBe("0");
  expect(state.headers.get("x-directory-r2-bytes")).toBe(String(frame.byteLength));
  expect(state.headers.get("x-directory-parses")).toBe("1");
  expect(state.headers.get("x-directory-publications")).toBe("0");
});

test("canonical metadata acquisition shares one R2 body across native requests", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const key = "namespaces/canonical-concurrent/segments/source.rsix";
  await (await worker.getR2Bucket("STORAGE")).put(key, canonical);
  const origin = await worker.ready;
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(new URL("/decoded-canonical", origin), {
        method: "POST",
        body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
          key,
          offset: 0,
          length,
          count: 1,
        }),
      }),
    ),
  );
  using expected = new Directory(canonical);
  for (const response of responses) {
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toBe(expected.terms('["unique3711"]'));
  }
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-canonical-reads")).toBe("1");
  expect(state.headers.get("x-directory-publications")).toBe("0");
});

test("failed canonical metadata acquisition releases shared readers for recovery", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const bucket = await worker.getR2Bucket("STORAGE");
  const key = "namespaces/canonical-failure/segments/source.rsix";
  const damaged = new Uint8Array(canonical);
  damaged[12] = (damaged[12] ?? 0) ^ 1;
  await bucket.put(key, damaged);
  const input = Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
    key,
    offset: 0,
    length,
    count: 1,
  });
  const failures = await Promise.all(
    Array.from({ length: 4 }, () =>
      fetch(new URL("/decoded-canonical", origin), { method: "POST", body: input }),
    ),
  );
  for (const response of failures) {
    expect(response.status).toBe(500);
    await response.text();
  }
  await bucket.put(key, canonical);
  const recovered = await fetch(new URL("/decoded-canonical", origin), {
    method: "POST",
    body: input,
  });
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  using expected = new Directory(canonical);
  expect(await recovered.text()).toBe(expected.terms('["unique3711"]'));
  const state = await fetch(new URL("/state", origin));
  expect(state.headers.get("x-canonical-reads")).toBe("2");
  expect(state.headers.get("x-r2-active")).toBe("0");
});

test("canonical metadata admission bounds overlapping raw header bodies", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const boundary = directoryWithLength(4 * 1024 * 1024);
  const keys = Array.from(
    { length: 4 },
    (_, index) => `namespaces/canonical-quota/segments/${index}.rsix`,
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const key of keys) await bucket.put(key, boundary.bytes);
  const responses = await Promise.all(
    keys.map((key) =>
      fetch(new URL("/decoded-canonical", origin), {
        method: "POST",
        body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
          key,
          offset: 0,
          length: boundary.length,
          count: 1,
        }),
      }),
    ),
  );
  using expected = new Directory(boundary.bytes);
  for (const response of responses) {
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toBe(expected.terms('["unique3711"]'));
  }
  const state = await fetch(new URL("/state", origin));
  expect(state.headers.get("x-canonical-reads")).toBe("4");
  expect(Number(state.headers.get("x-r2-peak"))).toBeLessThanOrEqual(2);
  expect(state.headers.get("x-r2-active")).toBe("0");
});

test("slow compressed frame waits leave canonical body admission available", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  expect((await fetch(new URL("/cache-stall", origin))).status).toBe(204);
  const boundary = directoryWithLength(4 * 1024 * 1024);
  const compressed = new Uint8Array(
    directory_compress(boundary.bytes.subarray(0, boundary.length)),
  );
  const keys = Array.from(
    { length: 16 },
    (_, index) => `namespaces/canonical-frame-waits/segments/${index}.rsix`,
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const key of keys) {
    await bucket.put(key, boundary.bytes);
    await bucket.put(`cache/directory-v2/${key}/${boundary.length}`, compressed, {
      customMetadata: {
        source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
          key,
          headerBytes: boundary.length,
        }),
      },
    });
  }
  const responses = await Promise.all(
    keys.map((key) =>
      fetch(new URL("/decoded-canonical", origin), {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
          key,
          offset: 0,
          length: boundary.length,
          count: 1,
        }),
      }),
    ),
  );
  using expected = new Directory(boundary.bytes);
  for (const response of responses) {
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toBe(expected.terms('["unique3711"]'));
  }
  const state = await fetch(new URL("/state", origin));
  expect(Number(state.headers.get("x-canonical-reads"))).toBeGreaterThan(0);
}, 20000);

test("distinct directory frames briefly share body admission before canonical fallback", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  expect((await fetch(new URL("/frame-burst", await worker.ready))).status).toBe(204);
  const keys = ["first", "second"].map(
    (name) => `namespaces/directory-frame-burst/segments/${name}.rsix`,
  );
  for (const key of keys)
    await bucket.put(`cache/directory-v2/${key}/${admissionLarge.length}`, admissionLargeFrame, {
      customMetadata: {
        source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
          key,
          headerBytes: admissionLarge.length,
        }),
      },
    });
  const responses = await Promise.all(
    keys.map(async (key) => {
      const response = await fetch(new URL("/frame", await worker.ready), {
        method: "POST",
        body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
          key,
          offset: 0,
          length: admissionLarge.length,
          count: 1,
        }),
      });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    }),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  for (const response of responses) expect(response.bytes).toEqual(admissionLargeFrame);
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-canonical-reads")).toBe("0");
  expect(state.headers.get("x-r2-started")).toBe("2");
  expect(state.headers.get("x-r2-active")).toBe("0");
  expect(state.headers.get("x-r2-peak")).toBe("1");
});

test("waiting frame admissions bypass a concurrent missing cache source", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  expect((await fetch(new URL("/frame-absent", origin))).status).toBe(204);
  const responses = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      fetch(new URL("/frame", origin), {
        method: "POST",
        body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
          key: `namespaces/directory-absent/segments/${index}.rsix`,
          offset: 0,
          length: admissionLarge.length,
          count: 1,
        }),
      }),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503]);
  const state = await fetch(new URL("/state", origin));
  expect(state.headers.get("x-directory-r2-reads")).toBe("1");
  expect(state.headers.get("x-r2-started")).toBe("0");
});

for (const sample of [
  { name: "large", frame: admissionLargeFrame, length: admissionLarge.length, active: 1 },
  { name: "small", frame: smallFrame, length: smallLength, active: 4 },
])
  test(`expired ${sample.name} frame waiters retain byte admission until body settlement`, async () => {
    await using active = await fixture();
    const worker = active.worker;
    const bucket = await worker.getR2Bucket("STORAGE");
    const origin = await worker.ready;
    expect((await fetch(new URL("/cache-stall", origin))).status).toBe(204);
    const keys = Array.from(
      { length: 24 },
      (_, index) => `namespaces/directory-frame-expiry/segments/${sample.name}-${index}.rsix`,
    );
    for (const key of keys)
      await bucket.put(`cache/directory-v2/${key}/${sample.length}`, sample.frame, {
        customMetadata: {
          source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
            key,
            headerBytes: sample.length,
          }),
        },
      });
    const responses = await Promise.all(
      keys.map((key) =>
        fetch(new URL("/frame", origin), {
          method: "POST",
          body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
            key,
            offset: 0,
            length: sample.length,
            count: 1,
          }),
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(keys.map(() => 503));
    const pending = await fetch(new URL("/state", origin));
    expect(pending.headers.get("x-r2-started")).toBe(String(sample.active));
    expect(pending.headers.get("x-r2-active")).toBe(String(sample.active));
    expect(pending.headers.get("x-r2-peak")).toBe(String(sample.active));
    for (const attempt of Array.from({ length: 60 }, (_, index) => index)) {
      const state = await fetch(new URL("/state", origin));
      if (state.headers.get("x-r2-active") === "0") break;
      if (attempt === 59) throw new Error("Frame body did not settle");
      await Effect.runPromise(Effect.sleep("50 millis"));
    }
    expect((await fetch(new URL("/frame-burst", origin))).status).toBe(204);
    const key = keys[sample.active];
    if (key === undefined) throw new Error("Missing recovery frame");
    const recovered = await fetch(new URL("/frame", origin), {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
        key,
        offset: 0,
        length: sample.length,
        count: 1,
      }),
    });
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(sample.frame);
    const settled = await fetch(new URL("/state", origin));
    expect(settled.headers.get("x-r2-started")).toBe(String(sample.active + 1));
    expect(settled.headers.get("x-r2-active")).toBe("0");
    expect(settled.headers.get("x-r2-peak")).toBe(String(sample.active));
  });

test("rejected cache admission shares a validated directory only for active readers", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  expect((await fetch(new URL("/fast-origin", await worker.ready))).status).toBe(204);
  using expected = Directory.compressed(frame, length);
  const metadata = expected.terms('["unique3711"]');
  const capacity = Math.floor((20 * 1024 * 1024) / expected.heap_bytes());
  expect(capacity).toBeGreaterThan(0);
  expect(capacity).toBeLessThan(32);
  const inputs = Array.from({ length: capacity + 1 }, (_, index) => ({
    key: `namespaces/directory-active/segments/blob-${index}.rsix`,
    offset: 0,
    length,
    count: 1,
  }));
  for (const input of inputs) {
    await bucket.put(input.key, canonical);
    await bucket.put(`cache/directory-v2/${input.key}/${length}`, frame, {
      customMetadata: {
        source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
          key: input.key,
          headerBytes: length,
        }),
      },
    });
  }
  for (const input of inputs.slice(0, -1)) {
    const response = await fetch(new URL("/decoded", await worker.ready), {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({ ...input, count: 32 }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(metadata);
  }
  const last = inputs.at(-1);
  if (last === undefined) throw new Error("Missing uncached directory");
  for (const input of [{ ...last, count: 16 }, last]) {
    const before = await fetch(new URL("/state", await worker.ready));
    const response = await fetch(new URL("/decoded", await worker.ready), {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))(input),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(metadata);
    expect(response.headers.get("x-directory-hits")).toBe("0");
    expect(Number(response.headers.get("x-directory-bytes"))).toBeLessThanOrEqual(20 * 1024 * 1024);
    const after = await fetch(new URL("/state", await worker.ready));
    expect(
      Number(after.headers.get("x-directory-parses")) -
        Number(before.headers.get("x-directory-parses")),
    ).toBe(1);
  }
}, 15000);

test("slow R2 directory cache bodies keep admission while canonical recovery returns", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  expect((await fetch(new URL("/cache-stall", await worker.ready))).status).toBe(204);
  for (const name of ["first", "second"]) {
    const key = `namespaces/directory-r2-stall/segments/${name}.rsix`;
    await bucket.put(key, admissionLarge.bytes);
    await bucket.put(`cache/directory-v2/${key}/${admissionLarge.length}`, admissionLargeFrame, {
      customMetadata: {
        source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
          key,
          headerBytes: admissionLarge.length,
        }),
      },
    });
    await cacheFrame(worker, key, admissionLarge.length, admissionLargeFrame);
    const response = await fetch(await worker.ready, {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
        key,
        offset: 0,
        length: admissionLarge.length,
        count: 8,
      }),
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(admissionLargeFrame);
    expect(response.headers.get("x-fallbacks")).toBe("1");
    const state = await fetch(new URL("/state", await worker.ready));
    expect(state.headers.get("x-r2-active")).toBe("1");
    expect(state.headers.get("x-r2-peak")).toBe("2");
    if (name === "first") {
      expect(response.headers.get("x-directory-r2-timeouts")).toBe("1");
      expect(state.headers.get("x-r2-started")).toBe("2");
    } else expect(state.headers.get("x-r2-started")).toBe("3");
  }
  for (const attempt of Array.from({ length: 60 }, (_, index) => index)) {
    const state = await fetch(new URL("/state", await worker.ready));
    if (state.headers.get("x-r2-active") === "0") return;
    if (attempt === 59) throw new Error("Directory cache body did not settle");
    await Effect.runPromise(Effect.sleep("50 millis"));
  }
}, 15000);

test("failed R2 directory publications preserve complete canonical results", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const key = "namespaces/directory-r2/segments/rejected-write.rsix";
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put(key, canonical);
  await cacheFrame(worker, key, length, frame);
  expect((await fetch(new URL("/cache-write-failure", await worker.ready))).status).toBe(204);
  const response = await fetch(await worker.ready, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length,
      count: 8,
    }),
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-rejected-writes")).toBe("1");
  expect(await bucket.head(`cache/directory-v2/${key}/${length}`)).toBeNull();
});

test("writes and compaction publish valid immutable directory frames", async () => {
  await using cleanup = new AsyncDisposableStack();
  const worker = await startWorker();
  cleanup.defer(() => worker.dispose());
  const namespace = "directory-writer";
  for (const id of ["a", "b"])
    expect(
      (await request(worker, namespace, "write", write([document(id, "alpha beta")]))).status,
    ).toBe(200);
  const reference = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, namespace, "query", textQuery("alpha"))).json(),
  );
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const phase of ["write", "compact"]) {
    if (phase === "compact")
      expect((await request(worker, namespace, "compact", {})).status).toBe(200);
    const object = await bucket.get(`namespaces/${namespace}/root.json`);
    if (object === null) throw new Error("Missing canonical root");
    const root = Schema.decodeSync(Schema.fromJsonString(Root))(await object.text());
    for (const source of root.segments) {
      const identity = `cache/directory-v2/${source.key}/${source.headerBytes}`;
      for (const attempt of Array.from({ length: 40 }, (_, index) => index)) {
        const stored = await bucket.get(identity);
        if (stored !== null) {
          const bytes = new Uint8Array(await stored.arrayBuffer());
          using decoded = Directory.compressed(bytes, source.headerBytes);
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(TermProjectionRange))(
              stored.customMetadata?.source,
            ),
          ).toEqual({ key: source.key, headerBytes: source.headerBytes });
          expect(
            Schema.decodeSync(Schema.fromJsonString(SegmentHeader.fields.documents))(
              decoded.rows(JSON.stringify(Array.from({ length: source.count }, (_, row) => row))),
            ),
          ).toHaveLength(source.count);
          break;
        }
        if (attempt === 39) throw new Error("Writer directory publication did not settle");
        await Effect.runPromise(Effect.sleep("50 millis"));
      }
    }
    expect(
      Schema.decodeUnknownSync(QueryResult)(
        await (await request(worker, namespace, "query", textQuery("alpha"))).json(),
      ),
    ).toEqual(reference);
  }
});

for (const name of ["headers", "body"])
  test(`directory cache wait recovers through bounded R2 with delayed ${name}`, async () => {
    await using active = await fixture();
    const worker = active.worker;
    const key = `namespaces/directory-budget/segments/${name}.rsix`;
    await (await worker.getR2Bucket("STORAGE")).put(key, canonical);
    await cacheFrame(worker, key, length, frame);
    const response = await fetch(await worker.ready, {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
        key,
        offset: 0,
        length,
        count: 32,
      }),
    });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(frame);
    using directory = Directory.compressed(bytes, length);
    expect(
      Schema.decodeSync(Schema.fromJsonString(SegmentHeader.fields.documents))(
        directory.rows("[0,4999]"),
      ),
    ).toEqual([header.documents[0], final]);
    expect(response.headers.get("x-cache-completed")).toBe("0");
    expect(response.headers.get("x-timeouts")).toBe("1");
    expect(response.headers.get("x-fallbacks")).toBe("1");
    expect(response.headers.get("x-fallback-bytes")).toBe(String(length));
    expect(response.headers.get("x-distinct-bodies")).toBe("1");
    const state = await fetch(new URL("/state", await worker.ready));
    expect(state.headers.get("x-r2-started")).toBe("1");
    expect(state.headers.get("x-r2-completed")).toBe("1");
    expect(state.headers.get("x-r2-peak")).toBe("1");
    expect(state.headers.get("x-r2-active")).toBe("0");
  }, 15000);

test("a failed R2 backstop preserves a pending valid cached directory", async () => {
  await using active = await fixture();
  const worker = active.worker;
  expect((await fetch(new URL("/race", await worker.ready))).status).toBe(204);
  const key = "namespaces/directory-cache-survives/segments/header.rsix";
  await cacheFrame(worker, key, length, frame);
  const response = await fetch(await worker.ready, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length,
      count: 8,
    }),
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  expect(response.headers.get("x-fallbacks")).toBe("1");
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-r2-active")).toBe("0");
});

test("directory recovery serializes distinct R2 bodies and releases failed admissions", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  const keys = ["first", "second", "third"].map(
    (name) => `namespaces/directory-budget/segments/${name}.rsix`,
  );
  for (const key of keys) {
    await bucket.put(key, canonical);
    await cacheFrame(worker, key, length, frame);
  }
  const responses = await Promise.all(
    keys.map(async (key) =>
      fetch(await worker.ready, {
        method: "POST",
        body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
          key,
          offset: 0,
          length,
          count: 8,
        }),
      }),
    ),
  );
  for (const response of responses) {
    if (response.status !== 200) throw new Error(await response.text());
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  }
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-r2-started")).toBe("3");
  expect(state.headers.get("x-r2-completed")).toBe("3");
  expect(state.headers.get("x-r2-peak")).toBe("1");
  expect(state.headers.get("x-r2-active")).toBe("0");
  const broken = "namespaces/directory-budget/segments/broken.rsix";
  const input = Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
    key: broken,
    offset: 0,
    length,
    count: 8,
  });
  expect((await fetch(await worker.ready, { method: "POST", body: input })).status).toBe(503);
  const damaged = canonical.slice();
  damaged[16] = 0;
  await bucket.put(broken, damaged);
  expect((await fetch(await worker.ready, { method: "POST", body: input })).status).toBe(503);
  await bucket.put(broken, canonical);
  const repaired = await fetch(await worker.ready, { method: "POST", body: input });
  expect(repaired.status).toBe(200);
  expect(new Uint8Array(await repaired.arrayBuffer())).toEqual(frame);
  const settled = await fetch(new URL("/state", await worker.ready));
  expect(settled.headers.get("x-r2-peak")).toBe("1");
  expect(settled.headers.get("x-r2-active")).toBe("0");
}, 15000);

test("directory bodies above two MiB preserve the cached acquisition path", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const boundary = directoryWithLength(2 * 1024 * 1024 + 1);
  const large = boundary.bytes;
  const headerBytes = boundary.length;
  expect(headerBytes).toBe(2 * 1024 * 1024 + 1);
  const encoded = new Uint8Array(directory_compress(large.subarray(0, headerBytes)));
  const key = "namespaces/directory-budget/segments/oversized.rsix";
  await (await worker.getR2Bucket("STORAGE")).put(key, large);
  await cacheFrame(worker, key, headerBytes, encoded);
  const response = await fetch(await worker.ready, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length: headerBytes,
      count: 32,
    }),
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(encoded);
  expect(response.headers.get("x-cache-completed")).toBe("1");
  expect(response.headers.get("x-timeouts")).toBe("0");
  expect(response.headers.get("x-fallbacks")).toBe("0");
  const state = await fetch(new URL("/state", await worker.ready));
  expect(state.headers.get("x-r2-started")).toBe("0");
}, 15000);

test("a late validated directory wins while the losing canonical body retains its lifetime", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  const built = directoryWithLength(4 * 1024 * 1024);
  const encoded = new Uint8Array(directory_compress(built.bytes.subarray(0, built.length)));
  const key = "namespaces/directory-late/segments/late.rsix";
  await bucket.put(key, built.bytes);
  await bucket.put(`cache/directory-v2/${key}/${built.length}`, encoded, {
    customMetadata: {
      source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
        key,
        headerBytes: built.length,
      }),
    },
  });
  expect((await fetch(new URL("/late-frame", await worker.ready))).status).toBe(204);
  expect((await fetch(new URL("/cache-write-failure", await worker.ready))).status).toBe(204);
  const started = performance.now();
  const response = await fetch(new URL("/origin", await worker.ready), {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length: built.length,
      count: 1,
    }),
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(encoded);
  expect(response.headers.get("x-raio-cache")).toBe("r2-directory-hit");
  expect(performance.now() - started).toBeLessThan(900);
  const pending = await fetch(new URL("/state", await worker.ready));
  expect(pending.headers.get("x-r2-active")).toBe("1");
  expect(pending.headers.get("x-r2-peak")).toBe("2");
  for (const attempt of Array.from({ length: 40 }, (_, index) => index)) {
    const settled = await fetch(new URL("/state", await worker.ready));
    if (settled.headers.get("x-r2-active") === "0") {
      expect(settled.headers.get("x-rejected-writes")).toBe("0");
      return;
    }
    if (attempt === 39) throw new Error("Losing canonical body did not settle");
    await Effect.runPromise(Effect.sleep("50 millis"));
  }
}, 15000);

test("large directory caches bound compressed bodies and recover oversized frames", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  const built = directoryWithLength(4 * 1024 * 1024);
  const encoded = new Uint8Array(directory_compress(built.bytes.subarray(0, built.length)));
  expect((await fetch(new URL("/fast-origin", await worker.ready))).status).toBe(204);
  for (const kind of ["valid", "oversized"] as const) {
    const key = `namespaces/directory-large/segments/${kind}.rsix`;
    await bucket.put(key, built.bytes);
    await bucket.put(
      `cache/directory-v2/${key}/${built.length}`,
      Match.value(kind).pipe(
        Match.when("valid", () => encoded),
        Match.orElse(() => new Uint8Array(2 * 1024 * 1024 + 8193)),
      ),
      {
        customMetadata: {
          source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
            key,
            headerBytes: built.length,
          }),
        },
      },
    );
    const response = await fetch(new URL("/origin", await worker.ready), {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
        key,
        offset: 0,
        length: built.length,
        count: 1,
      }),
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(encoded);
    const state = await fetch(new URL("/state", await worker.ready));
    if (kind === "valid") {
      expect(response.headers.get("x-raio-cache")).toBe("r2-directory-hit");
      expect(state.headers.get("x-canonical-reads")).toBe("0");
      expect(state.headers.get("x-r2-started")).toBe("1");
    } else {
      expect(response.headers.get("x-raio-cache")).toBeNull();
      expect(state.headers.get("x-canonical-reads")).toBe("1");
      expect(state.headers.get("x-r2-started")).toBe("2");
    }
  }
}, 15000);

test("R2 directory publication includes exactly four MiB and excludes the next byte", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const extra of [0, 1]) {
    const built = directoryWithLength(4 * 1024 * 1024 + extra);
    const key = `namespaces/directory-boundary/segments/frame-${extra}.rsix`;
    const identity = `cache/directory-v2/${key}/${built.length}`;
    await bucket.put(key, built.bytes);
    const response = await fetch(new URL("/origin", await worker.ready), {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
        key,
        offset: 0,
        length: built.length,
        count: 1,
      }),
    });
    expect(response.status).toBe(200);
    const encoded = new Uint8Array(await response.arrayBuffer());
    expect(encoded).toEqual(
      new Uint8Array(directory_compress(built.bytes.subarray(0, built.length))),
    );
    if (extra === 1) expect(await bucket.head(identity)).toBeNull();
    else
      for (const attempt of Array.from({ length: 40 }, (_, index) => index)) {
        const stored = await bucket.get(identity);
        if (stored !== null) {
          expect(new Uint8Array(await stored.arrayBuffer())).toEqual(encoded);
          break;
        }
        if (attempt === 39) throw new Error("Boundary publication did not settle");
        await Effect.runPromise(Effect.sleep("50 millis"));
      }
  }
}, 15000);

test("a winning cache response does not wait for the R2 loser or release its body slot early", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  expect((await fetch(new URL("/race", origin))).status).toBe(204);
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const name of ["first", "second"]) {
    const key = `namespaces/directory-race/segments/${name}.rsix`;
    await bucket.put(key, canonical);
    await cacheFrame(worker, key, length, frame);
    const response = await fetch(origin, {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
        key,
        offset: 0,
        length,
        count: 8,
      }),
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
    const state = await fetch(new URL("/state", origin));
    expect(state.headers.get("x-r2-active")).toBe("1");
    expect(state.headers.get("x-r2-completed")).toBe("0");
    expect(state.headers.get("x-r2-started")).toBe("1");
  }
  for (const attempt of Array.from({ length: 50 }, (_, index) => index)) {
    const state = await fetch(new URL("/state", origin));
    if (state.headers.get("x-r2-completed") === "1") break;
    if (attempt === 49) throw new Error("The losing R2 body did not settle");
    await Effect.runPromise(Effect.sleep("50 millis"));
  }
  const key = "namespaces/directory-race/segments/third.rsix";
  await bucket.put(key, canonical);
  await cacheFrame(worker, key, length, frame);
  const response = await fetch(origin, {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length,
      count: 8,
    }),
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  for (const attempt of Array.from({ length: 50 }, (_, index) => index)) {
    const state = await fetch(new URL("/state", origin));
    if (state.headers.get("x-r2-completed") === "2") {
      expect(state.headers.get("x-r2-active")).toBe("0");
      expect(state.headers.get("x-r2-peak")).toBe("1");
      return;
    }
    if (attempt === 49) throw new Error("The released slot was not reused");
    await Effect.runPromise(Effect.sleep("50 millis"));
  }
}, 15000);

test("busy directory recovery stops admission retries while retaining the original cache read", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  expect((await fetch(new URL("/busy", origin))).status).toBe(204);
  const keys = ["held", "waiting"].map(
    (name) => `namespaces/directory-admission/segments/${name}.rsix`,
  );
  for (const key of keys) {
    await (await worker.getR2Bucket("STORAGE")).put(key, canonical);
    await cacheFrame(worker, key, length, frame);
  }
  const responses = await Promise.all(
    keys.map((key) =>
      fetch(origin, {
        method: "POST",
        body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
          key,
          offset: 0,
          length,
          count: 8,
        }),
      }),
    ),
  );
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  }
  const state = await fetch(new URL("/state", origin));
  expect(state.headers.get("x-r2-started")).toBe("1");
  expect(state.headers.get("x-r2-completed")).toBe("1");
  expect(state.headers.get("x-r2-active")).toBe("0");
  expect(state.headers.get("x-r2-peak")).toBe("1");
}, 15000);

test("coordinator contexts keep a losing directory body alive through native waitUntil", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const bindings = await worker.getDurableObjectNamespace("NAMESPACES");
  const stub = bindings.get(bindings.idFromName("directory-background"));
  expect((await stub.fetch("https://fixture.local/race")).status).toBe(204);
  const key = "namespaces/directory-coordinator/segments/headers.rsix";
  await (await worker.getR2Bucket("STORAGE")).put(key, canonical);
  await cacheFrame(worker, key, length, frame);
  const response = await stub.fetch("https://fixture.local/", {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(DirectoryBudgetInput))({
      key,
      offset: 0,
      length,
      count: 8,
    }),
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
  const pending = await stub.fetch("https://fixture.local/state");
  expect(pending.headers.get("x-r2-active")).toBe("1");
  expect(pending.headers.get("x-r2-completed")).toBe("0");
  for (const attempt of Array.from({ length: 60 }, (_, index) => index)) {
    const state = await stub.fetch("https://fixture.local/state");
    if (state.headers.get("x-r2-completed") === "1") {
      expect(state.headers.get("x-r2-active")).toBe("0");
      return;
    }
    if (attempt === 59) throw new Error("Coordinator background body did not settle");
    await Effect.runPromise(Effect.sleep("50 millis"));
  }
}, 15000);
