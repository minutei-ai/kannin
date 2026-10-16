import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Response } from "miniflare";
import { initSync, Segment, Directory, directory_compress } from "../dist/wasm/raio_engine";
import { SegmentHeader } from "../src/protocol";
import { corpus } from "../tooling/corpus";
import { DirectoryBudgetInput } from "./range-contract";
import { startWorker } from "./harness";

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
const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());

const final = header.documents[4999];
if (final === undefined) throw new Error("Missing fixture row");

function padded(padding: string) {
  const first = documents[0];
  if (first === undefined) throw new Error("Missing fixture document");
  return [{ ...first, attributes: { ...first.attributes, padding } }, ...documents.slice(1)];
}

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
  const cacheKey = new URL("https://raio-cache.internal/directory-v1");
  cacheKey.searchParams.set("key", key);
  cacheKey.searchParams.set("offset", "0");
  cacheKey.searchParams.set("length", String(headerBytes));
  cacheKey.searchParams.set("bucket", "raio-test");
  await (
    await (await worker.getCaches()).open("raio-segments-v1")
  ).put(
    cacheKey,
    new Response(new Uint8Array(bytes), { headers: { "cache-control": "public, max-age=3600" } }),
  );
}

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
  await cacheFrame(worker, broken, length, frame);
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
  using seed = new Segment(JSON.stringify(padded("")));
  const seedBytes = seed.bytes();
  const seedHeader = 16 + new DataView(seedBytes.buffer, seedBytes.byteOffset).getUint32(8, true);
  const boundary = {
    padding: 2 * 1024 * 1024 + 1 - seedHeader,
    bytes: seedBytes,
    length: seedHeader,
  };
  for (const attempt of Array.from({ length: 8 }, (_, index) => index)) {
    using oversized = new Segment(JSON.stringify(padded("x".repeat(boundary.padding))));
    boundary.bytes = oversized.bytes();
    boundary.length =
      16 + new DataView(boundary.bytes.buffer, boundary.bytes.byteOffset).getUint32(8, true);
    if (boundary.length === 2 * 1024 * 1024 + 1) break;
    if (attempt === 7) throw new Error("Could not construct the exact directory boundary");
    boundary.padding -= boundary.length - (2 * 1024 * 1024 + 1);
  }
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
