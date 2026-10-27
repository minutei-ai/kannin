import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Directory, initSync, Segment } from "../dist/wasm/raio_engine";
import { RankingInput, SegmentHeader, StoredDocument, TermProjectionRange } from "../src/protocol";
import { startWorker } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});
const headers = {
  authorization: "Bearer local-test-token",
  "content-type": "application/json",
};

async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-common-publication-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "common-publication-worker.ts")],
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
  cleanup.defer(() => worker.dispose());
  const retained = cleanup.move();
  return { worker, [Symbol.asyncDispose]: () => retained.disposeAsync() };
}

async function wait(check: () => Promise<boolean>) {
  for (const _attempt of Array.from({ length: 1000 })) {
    if (await check()) return;
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  throw new Error("Publication fixture did not reach its barrier");
}

test("create-only common fallback preserves existing generations and concurrent hot upgrades", async () => {
  await using active = await fixture();
  const { worker } = active;
  const origin = await worker.ready;
  const bucket = await worker.getR2Bucket("STORAGE");
  const call = async (path: string, body?: string) => {
    if (body === undefined) return fetch(new URL(path, origin), { method: "POST", headers });
    return fetch(new URL(path, origin), { method: "POST", headers, body });
  };
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    expect((await call("/release")).status).toBe(204);
  });
  using segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(
      Array.from({ length: 96 }, (_, index) => ({
        id: String(index).padStart(3, "0"),
        revision: 1,
        title: "common rust",
        text: "common rust common",
        attributes: { group: index % 2 },
      })),
    ),
  );
  const bytes = segment.bytes();
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using directory = Directory.canonical(bytes.subarray(0, headerBytes), headerBytes);
  const full = directory.compressed_frame(headerBytes);
  const hot = directory.common_frame(headerBytes, bytes);
  expect(hot).not.toEqual(directory.common_frame(headerBytes));
  using decodedHot = Directory.common(hot, headerBytes, 40 * 1024 * 1024);
  expect(decodedHot.heap_bytes()).toBeGreaterThan(1);
  const input = Schema.encodeSync(RankingInput)({
    text: "common rust",
    mode: "phrase",
    top_k: 100,
    dead: [],
    filters: [],
    statistics: {
      documents: 96,
      title_length: header.total_title_length,
      body_length: header.total_body_length,
      frequencies: Object.fromEntries(
        Object.entries(header.terms).map(([term, meta]) => [term, meta.df]),
      ),
    },
  });
  const state = async () => {
    const response = await fetch(new URL("/state", origin), { headers });
    expect(response.status).toBe(200);
    return {
      headerStarted: Number(response.headers.get("x-header-started")),
      headerFinished: Number(response.headers.get("x-header-finished")),
      hotStarted: Number(response.headers.get("x-hot-started")),
      hotFinished: Number(response.headers.get("x-hot-finished")),
    };
  };
  for (const mode of [
    "present",
    "missing-race",
    "corrupt-race",
    "corrupt-repair",
    "budget-rejection",
    "corrupt-saturated",
  ]) {
    const key = `namespaces/cache-publication/segments/${mode}.rsix`;
    const source = { key, headerBytes };
    const sourceJson = Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))(source);
    const cache = `cache/directory-common-v3/${key}/${headerBytes}`;
    await bucket.put(key, bytes);
    await bucket.put(`cache/directory-v5/${key}/${headerBytes}`, full, {
      customMetadata: { source: sourceJson },
    });
    if (mode !== "missing-race")
      await bucket.put(cache, hot, { customMetadata: { source: sourceJson } });
    if (mode.startsWith("corrupt")) {
      const corrupt = hot.slice();
      corrupt[16] = (corrupt[16] ?? 0) ^ 1;
      await bucket.put(cache, corrupt, { customMetadata: { source: sourceJson } });
    }
    if (mode === "corrupt-saturated") {
      for (const index of Array.from({ length: 64 }, (_, offset) => offset)) {
        const heldKey = key.replace(/[^/]+$/, `hold-${index}.rsix`);
        const heldSource = Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
          key: heldKey,
          headerBytes,
        });
        await bucket.put(`cache/directory-v5/${heldKey}/${headerBytes}`, full, {
          customMetadata: { source: heldSource },
        });
      }
    }
    const storedBefore = await bucket.get(cache);
    const original = await storedBefore?.arrayBuffer();
    const before = await state();
    if (mode !== "present") expect((await call("/block")).status).toBe(204);
    const probed = await call(
      "/probe",
      JSON.stringify({
        source,
        input,
        miss: mode === "present" || mode === "missing-race",
        budgetReject: mode === "budget-rejection",
        saturate: mode === "corrupt-saturated",
      }),
    );
    expect(probed.status).toBe(204);
    if (mode === "corrupt-saturated") expect(probed.headers.get("x-held-directories")).toBe("64");
    await wait(async () => (await state()).headerStarted === before.headerStarted + 1);
    if (mode === "missing-race" || mode === "corrupt-race") {
      expect((await call("/hot", sourceJson)).status).toBe(204);
      await wait(async () => (await state()).hotFinished === before.hotFinished + 1);
    }
    if (mode !== "present") expect((await call("/release")).status).toBe(204);
    await wait(async () => (await state()).headerFinished === before.headerFinished + 1);
    const current = await bucket.get(cache);
    if (current === null) throw new Error("Missing common frame after fallback publication");
    const actual = new Uint8Array(await current.arrayBuffer());
    if (mode === "corrupt-repair" || mode === "corrupt-saturated") {
      if (original === undefined) throw new Error("Missing original corrupt common frame");
      expect(actual).toEqual(new Uint8Array(original));
    } else expect(actual).toEqual(new Uint8Array(hot));
  }
}, 60000);
