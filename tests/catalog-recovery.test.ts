import { canonicalFixtureDocuments } from "./segment-fixture";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSync, Segment } from "../dist/wasm/raio_engine";
import { TermProjectionProps, TermFilterHeader, TermCatalogBatch } from "../src/protocol";
import { startWorker } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});

for (const sample of [
  { name: "small", bytes: 4096, peak: 2, groups: 1 },
  { name: "64-kib", bytes: 64 * 1024, peak: 2, groups: 1 },
  { name: "small-shared", bytes: 64 * 1024, peak: 16, groups: 8 },
  { name: "above-64-kib", bytes: 64 * 1024 + 1, peak: 1, groups: 1 },
  { name: "above-four-mib", bytes: 4 * 1024 * 1024 + 1, peak: 1, groups: 1 },
  { name: "shared-admission", bytes: 1024 * 1024, peak: 8, groups: 9 },
])
  test(`canonical catalog ${sample.name} acquisition overlaps only admissible header bodies`, async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "kannin-catalog-recovery-"));
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "catalog-recovery-worker.ts")],
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
    const bucket = await worker.getR2Bucket("STORAGE");
    const groups = [];
    for (const group of Array.from({ length: sample.groups }, (_, index) => index)) {
      const ranges = [];
      for (const index of [0, 1, 2, 3]) {
        const padding = { bytes: sample.bytes - 512, complete: false };
        for (const attempt of [0, 1, 2]) {
          using segment = new Segment(
            JSON.stringify(
              canonicalFixtureDocuments([
                {
                  id: String(index),
                  revision: 1,
                  title: "",
                  text: "alpha ".repeat(index + 1),
                  attributes: { padding: "x".repeat(padding.bytes) },
                },
              ]),
            ),
          );
          const bytes = segment.bytes();
          const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
          if (headerBytes !== sample.bytes) {
            padding.bytes += sample.bytes - headerBytes;
            if (attempt === 2) throw new Error("Unable to prepare header boundary");
            continue;
          }
          const key = `namespaces/catalog-recovery-${sample.name}-${group}/segments/${index}.rsix`;
          await bucket.put(key, bytes);
          ranges.push({ key, headerBytes });
          padding.complete = true;
          break;
        }
        expect(padding.complete).toBe(true);
      }
      groups.push(ranges);
    }
    const origin = await worker.ready;
    const responses = await Promise.all(
      groups.map((ranges) =>
        fetch(new URL("/__catalog", origin), {
          method: "POST",
          headers: { "x-kannin-filters": Schema.encodeSync(TermFilterHeader)([]) },
          body: Schema.encodeSync(Schema.fromJsonString(TermProjectionProps))({
            bucket: "raio-test",
            terms: ["alpha"],
            selection: { kind: "fields", fields: [] },
            ranges,
          }),
        }),
      ),
    );
    for (const response of responses) {
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const catalog = Schema.decodeSync(Schema.fromJsonString(TermCatalogBatch))(body);
      expect(catalog.catalogs.map((entry) => entry.dictionary.alpha)).toEqual(
        [0, 1, 2, 3].map((index) => ({ df: 1, bounds: [[0, index + 1, 0, index + 1]] })),
      );
    }
    const state = await fetch(new URL("/__state", await worker.ready));
    expect(state.headers.get("x-started")).toBe(String(4 * sample.groups));
    expect(state.headers.get("x-active")).toBe("0");
    expect(state.headers.get("x-peak")).toBe(String(sample.peak));
    expect(Number(state.headers.get("x-peak-bytes"))).toBeLessThanOrEqual(
      Math.max(Math.min(2, sample.groups) * 4 * 1024 * 1024, sample.bytes),
    );
    if (sample.groups === 1) expect(state.headers.get("x-large-overlap")).toBe("false");
    if (sample.groups === 1) expect(state.headers.get("x-reordered")).toBe(String(sample.peak > 1));
  }, 30000);
