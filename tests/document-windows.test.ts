import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { initSync, Segment, Directory } from "../dist/wasm/raio_engine";
import { SegmentHeader, StoredDocument } from "../src/protocol";
import { DocumentPageProbeInput } from "./range-contract";
import { startWorker } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});

async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-document-windows-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "range-fixture.ts")],
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

test("nearby document reads reuse byte windows without decoding an unselected corrupt frame", async () => {
  await using active = await fixture();
  using segment = new Segment(
    JSON.stringify(
      [0, 1, 2].map((index) => ({
        id: String(index),
        revision: 1,
        title: "",
        text: `alpha unique${index}`,
        attributes: { group: index },
      })),
    ),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const bytes = segment.bytes();
  const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const corrupt = header.documents[1];
  if (corrupt === undefined) throw new Error("Missing neighboring frame");
  const corruptAt = headerBytes + corrupt.data.offset + 4;
  bytes[corruptAt] = (bytes[corruptAt] ?? 0) ^ 1;
  const key = "namespaces/document-windows/segments/1-neighbors.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
  for (const sample of [
    { row: 0, status: 200, reads: 1 },
    { row: 2, status: 200, reads: 0 },
    { row: 1, status: 503, reads: 0 },
  ]) {
    const selected = header.documents[sample.row];
    if (selected === undefined) throw new Error("Missing selected frame");
    const response = await fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: bytes.byteLength,
        pages: [selected.data],
      }),
    });
    expect(response.status).toBe(sample.status);
    expect(response.headers.get("x-reads")).toBe(String(sample.reads));
    if (sample.status === 200) {
      const documents = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(
        await response.json(),
      );
      expect(documents.map((document) => document.id)).toEqual([String(sample.row)]);
      expect(documents[0]?.text).toBe(`alpha unique${sample.row}`);
    }
  }
});

test("a document crossing a byte-window boundary retains its complete frame and clips the final range", async () => {
  await using active = await fixture();
  using segment = new Segment(
    JSON.stringify([{ id: "edge", revision: 1, title: "", text: "alpha beta", attributes: {} }]),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const original = segment.bytes();
  const originalHeader = 16 + new DataView(original.buffer, original.byteOffset).getUint32(8, true);
  const sourceDocument = header.documents[0];
  const page = original.slice(
    originalHeader + sourceDocument.data.offset,
    originalHeader + sourceDocument.data.offset + sourceDocument.data.length,
  );
  const layout = { offset: 32760, json: new Uint8Array(0), headerBytes: 0 };
  for (const attempt of [0, 1, 2]) {
    layout.json = new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(SegmentHeader))({
        ...header,
        documents: [{ ...sourceDocument, data: { ...sourceDocument.data, offset: layout.offset } }],
      }),
    );
    layout.headerBytes = 16 + layout.json.byteLength;
    if (layout.headerBytes + layout.offset === 32760) break;
    layout.offset += 32760 - layout.headerBytes - layout.offset;
    if (attempt === 2) throw new Error("Unable to place boundary frame");
  }
  const bytes = new Uint8Array(32760 + page.byteLength);
  bytes.set(original.subarray(0, 8));
  const view = new DataView(bytes.buffer);
  view.setUint32(8, layout.json.byteLength, true);
  view.setUint32(12, crc32(layout.json), true);
  bytes.set(layout.json, 16);
  bytes.set(original.subarray(originalHeader), layout.headerBytes);
  bytes.set(page, 32760);
  using directory = Directory.canonical(bytes.subarray(0, layout.headerBytes), layout.headerBytes);
  expect(directory.summary('["alpha"]')).toContain('"df":1');
  const key = "namespaces/document-windows/segments/1-crossing.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
  const response = await fetch(new URL("/document-pages", await active.worker.ready), {
    method: "POST",
    headers: { authorization: "Bearer local-test-token" },
    body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
      source: { key, headerBytes: layout.headerBytes },
      bytes: bytes.byteLength,
      pages: [{ offset: layout.offset, length: page.byteLength }],
    }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-reads")).toBe("1");
  expect(response.headers.get("x-bytes")).toBe(String(bytes.byteLength));
  const documents = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(await response.json());
  expect(documents.map((document) => document.id)).toEqual(["edge"]);
  expect(documents[0]?.text).toBe("alpha beta");
});
