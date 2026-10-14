import { afterAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorker } from "./harness";
import { RangeProbeInput, RangeProbeResult } from "./range-contract";

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
