import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { CorrelatedOverview, QueryResult, Root, StoredOverviewBatch } from "../src/protocol";
import { initSync, pack, unpack } from "../dist/wasm/raio_engine";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});
async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-overview-publication-"));
  const cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "overview-batch-worker.ts")],
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
  const retained = cleanup.move();
  return { worker, [Symbol.asyncDispose]: () => retained.disposeAsync() };
}

async function seed(worker: Awaited<ReturnType<typeof startWorker>>, namespace = "batch") {
  for (const index of Array.from({ length: 8 }, (_, i) => i))
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document(String(index), `alpha unique${index}`)]),
        )
      ).status,
    ).toBe(200);
  const response = await request(worker, namespace, "query", textQuery("alpha"));
  expect(response.status).toBe(200);
  const reference = Schema.decodeUnknownSync(QueryResult)(await response.json());
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const attempt of Array.from({ length: 100 }, (_, i) => i)) {
    const objects = await bucket.list({
      prefix: `cache/correlated-pool-batches-v1/namespaces/${namespace}/`,
    });
    const first = objects.objects[0];
    if (first !== undefined) return { reference, bucket, key: first.key };
    if (attempt === 99) throw new Error("Batch publication did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  throw new Error("No batch object");
}

test("oversized combined sources recover through admissible physical batches", async () => {
  await using instance = await fixture();
  const { worker } = instance;
  for (const index of Array.from({ length: 16 }, (_, i) => i))
    expect(
      (
        await request(
          worker,
          "large-overviews",
          "write",
          write([document(String(index), `alpha unique${index}`)]),
        )
      ).status,
    ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get("namespaces/large-overviews/root.json");
  if (object === null) throw new Error("Missing manifest");
  const root = Schema.decodeSync(Schema.fromJsonString(Root))(await object.text());
  const sources = [];
  for (const segment of root.segments) {
    const key = `cache/correlated-pool-v1/${segment.key}`;
    const cached = await bucket.get(key);
    if (cached === null) throw new Error("Missing correlated source");
    const source = Schema.decodeSync(Schema.fromJsonString(CorrelatedOverview))(
      await cached.text(),
    );
    const decoded = inflateSync(source.overview.subarray(8));
    const padded = new Uint8Array(30000).fill(32);
    padded.set(decoded);
    const compressed = deflateSync(padded, { level: 0 });
    const overview = new Uint8Array(8 + compressed.byteLength);
    const frame = new DataView(overview.buffer);
    frame.setUint32(0, padded.byteLength, true);
    frame.setUint32(4, crc32(padded), true);
    overview.set(compressed, 8);
    const replacement = { ...source, overview };
    sources.push(replacement);
    await bucket.put(
      key,
      Schema.encodeSync(Schema.fromJsonString(CorrelatedOverview))(replacement),
    );
  }
  const first = sources[0];
  if (first === undefined) throw new Error("Missing physical source");
  const full = Schema.encodeSync(Schema.fromJsonString(StoredOverviewBatch))({
    bucket: first.bucket,
    ranges: sources.map((source) => source.source),
    overviews: sources.map((source) => source.overview),
  });
  expect(new TextEncoder().encode(full).byteLength).toBeGreaterThan(512 * 1024);
  const references: Array<typeof QueryResult.Type> = [];
  for (const pass of [0, 1]) {
    expect((await request(worker, "large-overviews", "rebuild", {})).status).toBe(200);
    const response = await request(
      worker,
      "large-overviews",
      "query",
      textQuery(`alpha missing${pass}`),
    );
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
    references.push(result);
    const reference = references[0];
    if (reference === undefined) throw new Error("Missing original result");
    expect(result).toEqual(reference);
    expect(result.sequence).toBe(16);
    expect(result.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 16 }, (_, i) => String(i))
        .toSorted()
        .slice(0, 10),
    );
    for (const attempt of Array.from({ length: 50 }, (_, i) => i)) {
      const objects = await bucket.list({ prefix: "cache/correlated-pool-batches-v1/" });
      if (objects.objects.length >= pass + 1 || attempt === 49) break;
      await Effect.runPromise(Effect.sleep("10 millis"));
    }
  }
  const persisted = await bucket.list({ prefix: "cache/correlated-pool-batches-v1/" });
  expect(persisted.objects).toHaveLength(2);
  expect((await request(worker, "large-overviews", "rebuild", {})).status).toBe(200);
  const recovered = await request(
    worker,
    "large-overviews",
    "query",
    textQuery("alpha recoveredmissing"),
  );
  expect(recovered.status).toBe(200);
  const reference = references[0];
  if (reference === undefined) throw new Error("Missing original result");
  expect(Schema.decodeUnknownSync(QueryResult)(await recovered.json())).toEqual(reference);
  expect(recovered.headers.get("server-timing")).toContain('desc="reads=2 hits=2');
  expect(recovered.headers.get("server-timing")).toContain("reads=0 hits=0 bytes=0 batch_peak=0");
});

for (const variant of [
  "valid",
  "absent",
  "corrupt",
  "metadata",
  "oversized",
  "identity",
  "range",
]) {
  test(`R2 overview batch ${variant} preserves complete results`, async () => {
    await using instance = await fixture();
    const { worker } = instance;
    const { reference, bucket, key } = await seed(worker);
    const object = await bucket.get(key);
    if (object === null) throw new Error("Missing published batch");
    if (variant === "absent") await bucket.delete(key);
    if (variant === "corrupt")
      await bucket.put(key, new Uint8Array([1, 2, 3]), {
        customMetadata: object.customMetadata ?? {},
      });
    if (variant === "metadata")
      await bucket.put(key, await object.arrayBuffer(), { customMetadata: { rawBytes: "1" } });
    if (variant === "oversized")
      await bucket.put(key, new Uint8Array(512 * 1024 + 1), {
        customMetadata: object.customMetadata ?? {},
      });
    if (variant === "identity" || variant === "range") {
      const frame = unpack(new Uint8Array(await object.arrayBuffer()));
      const envelope = Schema.decodeSync(Schema.fromJsonString(StoredOverviewBatch))(frame);
      const altered = { ...envelope };
      if (variant === "identity") altered.bucket = "another-bucket";
      else altered.ranges = envelope.ranges.toReversed();
      const encoded = Schema.encodeSync(Schema.fromJsonString(StoredOverviewBatch))(altered);
      await bucket.put(key, new Uint8Array(pack(encoded)), {
        customMetadata: { rawBytes: String(new TextEncoder().encode(encoded).byteLength) },
      });
    }
    expect((await request(worker, "batch", "rebuild", {})).status).toBe(200);
    const response = await request(worker, "batch", "query", textQuery("alpha missing"));
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    if (variant === "valid") {
      expect(response.headers.get("server-timing")).toContain('desc="reads=1 hits=1');
      expect(response.headers.get("server-timing")).toContain(
        "reads=0 hits=0 bytes=0 batch_peak=0",
      );
    } else expect(response.headers.get("server-timing")).toContain("reads=8 hits=8");
  }, 15000);
}

for (const phase of ["headers", "body"]) {
  test(`R2 batch ${phase} timeout preserves fallback and the original deadline`, async () => {
    await using instance = await fixture();
    const { worker } = instance;
    const { reference } = await seed(worker);
    await fetch(new URL(`/fixture/${phase}`, await worker.ready));
    expect((await request(worker, "batch", "rebuild", {})).status).toBe(200);
    const started = performance.now();
    const response = await request(worker, "batch", "query", textQuery("alpha firstmissing"));
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("timeouts=1");
    expect(performance.now() - started).toBeLessThan(1500);
    const before = await fetch(new URL("/fixture/state", await worker.ready));
    expect((await request(worker, "batch", "rebuild", {})).status).toBe(200);
    const joinedAt = performance.now();
    const joined = await request(worker, "batch", "query", textQuery("alpha secondmissing"));
    expect(joined.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await joined.json())).toEqual(reference);
    expect(performance.now() - joinedAt).toBeLessThan(450);
    const after = await fetch(new URL("/fixture/state", await worker.ready));
    expect(after.headers.get("x-gets")).toBe(before.headers.get("x-gets"));
  }, 15000);
}

test("R2 overview body admission overlaps two charged frames without losing another invocation", async () => {
  await using instance = await fixture();
  const { worker } = instance;
  const references = [];
  for (const namespace of ["budget0", "budget1", "budget2"]) {
    const seeded = await seed(worker, namespace);
    const object = await seeded.bucket.get(seeded.key);
    if (object === null) throw new Error("Missing frame");
    const encoded = unpack(new Uint8Array(await object.arrayBuffer()));
    const padded = encoded + " ".repeat(512 * 1024 - new TextEncoder().encode(encoded).byteLength);
    await seeded.bucket.put(seeded.key, new Uint8Array(pack(padded)), {
      customMetadata: { rawBytes: String(512 * 1024) },
    });
    references.push({ namespace, result: seeded.reference });
    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  }
  await fetch(new URL("/fixture/slow-body", await worker.ready));
  const results = await Promise.all(
    references.map(async (reference) => {
      const response = await request(
        worker,
        reference.namespace,
        "query",
        textQuery("alpha budgetmissing"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("server-timing")).toContain('desc="reads=1 hits=1');
      expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(
        reference.result,
      );
    }),
  );
  expect(results).toHaveLength(3);
  const state = await fetch(new URL("/fixture/state", await worker.ready));
  expect(state.headers.get("x-body-peak")).toBe("2");
  expect(state.headers.get("x-body-active")).toBe("0");
  expect(state.headers.get("x-body-completed")).toBe("3");
  expect(Number(state.headers.get("x-body-handoff-ms"))).toBeLessThan(120);
}, 15000);

test("failed R2 batch publication preserves rows and a later request can publish", async () => {
  await using instance = await fixture();
  const { worker } = instance;
  await fetch(new URL("/fixture/fail-put", await worker.ready));
  for (const index of Array.from({ length: 9 }, (_, i) => i))
    expect(
      (await request(worker, "publication", "write", write([document(String(index), "alpha")])))
        .status,
    ).toBe(200);
  const first = await request(worker, "publication", "query", textQuery("alpha"));
  expect(first.status).toBe(200);
  const reference = Schema.decodeUnknownSync(QueryResult)(await first.json());
  const bucket = await worker.getR2Bucket("STORAGE");
  expect((await bucket.list({ prefix: "cache/correlated-pool-batches-v1/" })).objects).toHaveLength(
    0,
  );
  await fetch(new URL("/fixture/normal", await worker.ready));
  expect((await request(worker, "publication", "rebuild", {})).status).toBe(200);
  const recovered = await request(worker, "publication", "query", textQuery("alpha missing"));
  expect(recovered.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await recovered.json())).toEqual(reference);
  for (const attempt of Array.from({ length: 100 }, (_, i) => i)) {
    if ((await bucket.list({ prefix: "cache/correlated-pool-batches-v1/" })).objects.length === 1)
      return;
    if (attempt === 99) throw new Error("Publication did not recover");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
}, 15000);

test("same physical batch shares one source across concurrent selectors", async () => {
  await using instance = await fixture();
  const { worker } = instance;
  const { reference } = await seed(worker);
  expect((await request(worker, "batch", "rebuild", {})).status).toBe(200);
  await fetch(new URL("/fixture/slow-headers", await worker.ready));
  const before = await fetch(new URL("/fixture/state", await worker.ready));
  await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const response = await request(
        worker,
        "batch",
        "query",
        textQuery(`alpha concurrentmissing${index}`),
      );
      expect(response.status).toBe(200);
      expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    }),
  );
  const after = await fetch(new URL("/fixture/state", await worker.ready));
  expect(Number(after.headers.get("x-gets")) - Number(before.headers.get("x-gets"))).toBe(1);
}, 15000);

test("a persisted batch promotes into the faster overview Cache API tier", async () => {
  await using instance = await fixture();
  const { worker } = instance;
  const { reference } = await seed(worker);
  await fetch(new URL("/fixture/api", await worker.ready));
  expect((await request(worker, "batch", "rebuild", {})).status).toBe(200);
  const persisted = await request(worker, "batch", "query", textQuery("alpha firstpromotion"));
  expect(persisted.status).toBe(200);
  expect(persisted.headers.get("server-timing")).toContain('desc="reads=1 hits=1');
  expect(Schema.decodeUnknownSync(QueryResult)(await persisted.json())).toEqual(reference);
  for (const attempt of Array.from({ length: 100 }, (_, i) => i)) {
    const state = await fetch(new URL("/fixture/state", await worker.ready));
    if (state.headers.get("x-api-puts") === "1") break;
    if (attempt === 99) throw new Error("API promotion did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  expect((await request(worker, "batch", "rebuild", {})).status).toBe(200);
  const cached = await request(worker, "batch", "query", textQuery("alpha secondpromotion"));
  expect(cached.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await cached.json())).toEqual(reference);
  expect(cached.headers.get("server-timing")).toContain('desc="memory=0 api=8"');
  expect(cached.headers.get("server-timing")).toContain(
    'catalog_batch_r2_sum;dur=0;desc="reads=0 hits=0',
  );
}, 15000);

test("batch lookup admission retains sixteen sources until native headers settle", async () => {
  await using instance = await fixture();
  const { worker } = instance;
  const references = [];
  for (const index of Array.from({ length: 17 }, (_, i) => i)) {
    const namespace = `admission${index}`;
    const seeded = await seed(worker, namespace);
    references.push({ namespace, result: seeded.reference });
    expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  }
  await fetch(new URL("/fixture/headers", await worker.ready));
  const before = await fetch(new URL("/fixture/state", await worker.ready));
  await Promise.all(
    references.map(async (reference) => {
      const response = await request(
        worker,
        reference.namespace,
        "query",
        textQuery("alpha admissionmissing"),
      );
      expect(response.status).toBe(200);
      expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(
        reference.result,
      );
    }),
  );
  const state = await fetch(new URL("/fixture/state", await worker.ready));
  expect(Number(state.headers.get("x-gets")) - Number(before.headers.get("x-gets"))).toBe(16);
  expect(state.headers.get("x-header-peak")).toBe("16");
  for (const attempt of Array.from({ length: 100 }, (_, i) => i)) {
    const settled = await fetch(new URL("/fixture/state", await worker.ready));
    if (settled.headers.get("x-header-active") === "0") break;
    if (attempt === 99) throw new Error("Native headers did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  await fetch(new URL("/fixture/normal", await worker.ready));
  const first = references[0];
  if (first === undefined) throw new Error("Missing reference");
  expect((await request(worker, first.namespace, "rebuild", {})).status).toBe(200);
  const recovered = await request(
    worker,
    first.namespace,
    "query",
    textQuery("alpha recoveredadmission"),
  );
  expect(recovered.status).toBe(200);
  expect(recovered.headers.get("server-timing")).toContain('desc="reads=1 hits=1');
  expect(Schema.decodeUnknownSync(QueryResult)(await recovered.json())).toEqual(first.result);
}, 30000);
