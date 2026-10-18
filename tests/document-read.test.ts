import { expect, test } from "bun:test";
import { Match, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Directory, initSync } from "../dist/wasm/raio_engine";
import { Root, SegmentHeader, SegmentRange, QueryResult } from "../src/protocol";
import { request, startWorker, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});

for (const kind of ["text", "vector"])
  for (const size of ["small", "large"])
    test(`${kind} ${size} scattered document materialization preserves its byte-dependent reader limit`, async () => {
      const artifacts = await mkdtemp(join(tmpdir(), "kannin-document-read-"));
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "document-read-fixture.ts")],
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
      const namespace = `document-read-${kind}-${size}`;
      const vector = [1, ...Array.from({ length: 767 }, () => 0)];
      const entropy = new Uint8Array(32768);
      if (size === "large") crypto.getRandomValues(entropy);
      const padding = { value: "" };
      if (size === "large") padding.value = entropy.toBase64();
      for (const index of Array.from({ length: 8 }, (_, ordinal) => ordinal))
        expect(
          (
            await request(
              worker,
              namespace,
              "write",
              write([
                {
                  id: String(index),
                  text: "alpha beta",
                  attributes: { padding: padding.value },
                  vector,
                },
              ]),
            )
          ).status,
        ).toBe(200);
      if (kind === "vector")
        expect((await request(worker, namespace, "vector-sync", {})).status).toBe(200);
      const bucket = await worker.getR2Bucket("STORAGE");
      const rootObject = await bucket.get(`namespaces/${namespace}/root.json`);
      if (rootObject === null) throw new Error("Missing root");
      const root = Schema.decodeUnknownSync(Root)(await rootObject.json());
      const ranges = [];
      const payloadBytes = { total: 0 };
      for (const segment of root.segments) {
        const object = await bucket.get(segment.key, {
          range: { offset: 0, length: segment.headerBytes },
        });
        if (object === null) throw new Error("Missing segment");
        const bytes = new Uint8Array(await object.arrayBuffer());
        using directory = Directory.canonical(bytes, segment.headerBytes);
        const documents = Schema.decodeSync(Schema.fromJsonString(SegmentHeader.fields.documents))(
          directory.rows(JSON.stringify(Array.from({ length: segment.count }, (_, row) => row))),
        );
        for (const document of documents) {
          payloadBytes.total += document.data.length;
          const range = {
            key: segment.key,
            offset: segment.headerBytes + document.data.offset,
            length: document.data.length,
          };
          if (range.length <= 32768) {
            const end = Math.min(
              segment.bytes,
              Math.ceil((range.offset + range.length) / 32768) * 32768,
            );
            range.offset = Math.floor(range.offset / 32768) * 32768;
            range.length = end - range.offset;
          }
          ranges.push(range);
        }
      }
      const total = payloadBytes.total;
      if (size === "small") expect(total).toBeLessThanOrEqual(65536);
      else expect(total).toBeGreaterThan(65536);
      expect(
        (
          await fetch(new URL("/fixture/documents", await worker.ready), {
            method: "POST",
            body: Schema.encodeSync(Schema.fromJsonString(Schema.Array(SegmentRange)))(ranges),
          })
        ).status,
      ).toBe(204);
      const input = Match.value(kind).pipe(
        Match.when("text", () => ({ kind: "text", text: "alpha", topK: 10, filters: [] })),
        Match.orElse(() => ({ kind: "vector", vector, topK: 10, filters: [] })),
      );
      const response = await request(worker, namespace, "query", input);
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
      expect(result.sequence).toBe(8);
      expect(result.rows.map((row) => row.id).toSorted()).toEqual(
        Array.from({ length: 8 }, (_, index) => String(index)),
      );
      expect(
        result.rows.every(
          (row) => row.text === "alpha beta" && row.attributes.padding === padding.value,
        ),
      ).toBe(true);
      const starts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(
        response.headers.get("x-fixture-starts"),
      );
      expect(starts).toHaveLength(8);
      if (size === "small") {
        expect(response.headers.get("x-fixture-peak")).toBe("8");
        expect(starts.every((completed) => completed === 0)).toBe(true);
      } else {
        expect(response.headers.get("x-fixture-peak")).toBe("4");
        expect(starts.slice(4).every((completed) => completed >= 1)).toBe(true);
      }
    }, 20000);
