import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RangeProbeInput } from "./range-contract";
import { startWorker } from "./harness";

for (const sample of [
  { length: 65536, name: "headers" },
  { length: 65536, name: "body" },
  { length: 65537, name: "larger" },
])
  test(`immutable cache budget preserves shared bytes with delayed ${sample.name}`, async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "kannin-range-budget-"));
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "range-budget-fixture.ts")],
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
    const key = `namespaces/range-budget/segments/${sample.name}.rsix`;
    const bucket = await worker.getR2Bucket("STORAGE");
    await bucket.put(key, new Uint8Array(sample.length).fill(7));
    const pending = fetch(await worker.ready, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))({
        key,
        offset: 0,
        length: sample.length,
        count: 32,
      }),
    });
    const timely = await Promise.race([
      pending.then(() => true),
      Effect.runPromise(Effect.sleep("650 millis")).then(() => false),
    ]);
    const response = await pending;
    if (sample.length <= 65536) expect(timely).toBe(true);
    else expect(timely).toBe(false);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(sample.length).fill(7),
    );
    if (sample.length <= 65536) {
      expect(response.headers.get("x-fixture-timeouts")).toBe("1");
      expect(response.headers.get("x-fixture-fallbacks")).toBe("1");
      expect(response.headers.get("x-fixture-fallback-bytes")).toBe(String(sample.length));
    } else {
      expect(response.headers.get("x-fixture-timeouts")).toBe("0");
      expect(response.headers.get("x-fixture-fallbacks")).toBe("0");
    }
    expect(response.headers.get("x-fixture-reads")).toBe("1");
    expect(response.headers.get("x-fixture-bodies")).toBe("1");
    if (sample.name === "headers") {
      const missing = {
        key: "namespaces/range-budget/segments/missing.rsix",
        offset: 0,
        length: 16,
        count: 32,
      };
      const body = Schema.encodeSync(Schema.fromJsonString(RangeProbeInput))(missing);
      expect((await fetch(await worker.ready, { method: "POST", body })).status).toBe(503);
      await bucket.put(missing.key, new Uint8Array(16).fill(9));
      const retried = await fetch(await worker.ready, { method: "POST", body });
      expect(retried.status).toBe(200);
      expect(retried.headers.get("x-fixture-reads")).toBe("1");
      expect(retried.headers.get("x-fixture-fallbacks")).toBe("1");
      expect(new Uint8Array(await retried.arrayBuffer())).toEqual(new Uint8Array(16).fill(9));
    }
  }, 15000);
