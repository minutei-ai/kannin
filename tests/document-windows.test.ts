import { canonicalFixtureDocuments } from "./segment-fixture";
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSync, Segment, Directory, segment_query_documents } from "../dist/wasm/raio_engine";
import { SegmentHeader, StoredDocument } from "../src/protocol";
import { DocumentPageProbeInput } from "./range-contract";
import { startWorker } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});

async function fixture(entrypoint = "range-fixture.ts") {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-document-windows-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, entrypoint)],
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
      canonicalFixtureDocuments(
        [0, 1, 2].map((index) => ({
          id: String(index),
          revision: 1,
          title: "",
          text: `alpha unique${index}`,
          attributes: { group: index },
        })),
      ),
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
    { row: 0, status: 200, reads: 1, hits: 0 },
    { row: 2, status: 200, reads: 0, hits: 1 },
    { row: 1, status: 503, reads: 0, hits: 1 },
    { row: 1, status: 503, reads: 0, hits: 1 },
  ]) {
    const selected = header.documents[sample.row];
    if (selected === undefined) throw new Error("Missing selected frame");
    const response = await fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: bytes.byteLength,
        metadataEnd: headerBytes + header.metadata_end,
        pages: [selected.data],
      }),
    });
    expect(response.status).toBe(sample.status);
    expect(response.headers.get("x-reads")).toBe(String(sample.reads));
    expect(response.headers.get("x-cache-hits")).toBe(String(sample.hits));
    if (sample.status === 200) {
      const documents = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(
        await response.json(),
      );
      expect(documents.map((document) => document.id)).toEqual([String(sample.row)]);
      expect(documents[0]?.text).toBe(`alpha unique${sample.row}`);
    }
  }
});

test("a document crossing a byte-window boundary retains its complete frame and clips the metadata range", async () => {
  await using active = await fixture();
  const state = { value: 0x6d2b79f5 };
  const padding = Uint8Array.from({ length: 8192 }, () => {
    state.value ^= state.value << 13;
    state.value ^= state.value >>> 17;
    state.value ^= state.value << 5;
    return state.value & 255;
  }).toBase64();
  const layout = {
    padding: 5000,
    bytes: new Uint8Array(0),
    headerBytes: 0,
    metadataEnd: 0,
    data: { offset: 0, length: 0 },
  };
  for (const attempt of Array.from({ length: 8 }, (_, index) => index)) {
    using segment = new Segment(
      JSON.stringify(
        canonicalFixtureDocuments([
          {
            id: "0-filler",
            revision: 1,
            title: "",
            text: "unused",
            attributes: { padding: padding.slice(0, layout.padding) },
          },
          { id: "edge", revision: 1, title: "", text: "alpha beta", attributes: {} },
        ]),
      ),
    );
    const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
    const document = header.documents[1];
    if (document === undefined) throw new Error("Missing boundary document");
    layout.bytes = new Uint8Array(segment.bytes());
    layout.headerBytes =
      16 + new DataView(layout.bytes.buffer, layout.bytes.byteOffset).getUint32(8, true);
    layout.metadataEnd = layout.headerBytes + header.metadata_end;
    layout.data = document.data;
    if (document.data.offset < 4096 && document.data.offset + document.data.length > 4096) break;
    layout.padding += 4088 - document.data.offset;
    if (attempt === 7) throw new Error("Unable to place boundary frame");
  }
  expect(layout.data.length).toBeLessThan(4096);
  using directory = Directory.canonical(
    layout.bytes.subarray(0, layout.headerBytes),
    layout.headerBytes,
  );
  expect(directory.summary('["alpha"]')).toContain('"df":1');
  const key = "namespaces/document-windows/segments/1-crossing.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, layout.bytes);
  const response = await fetch(new URL("/document-pages", await active.worker.ready), {
    method: "POST",
    headers: { authorization: "Bearer local-test-token" },
    body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
      source: { key, headerBytes: layout.headerBytes },
      bytes: layout.bytes.byteLength,
      metadataEnd: layout.metadataEnd,
      pages: [layout.data],
    }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-reads")).toBe("1");
  expect(response.headers.get("x-bytes")).toBe(String(layout.metadataEnd - layout.headerBytes));
  const documents = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(await response.json());
  expect(documents.map((document) => document.id)).toEqual(["edge"]);
  expect(documents[0]?.text).toBe("alpha beta");
});

test("sparse document batches preserve input order and retain only requested frames", async () => {
  await using active = await fixture("document-window-slow-fixture.ts");
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        [0, 1, 2].map((index) => ({
          id: String(index),
          revision: 1,
          title: `title${index}`,
          text: `alpha unique${index}`,
          attributes: { group: index },
        })),
      ),
    ),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const original = segment.bytes();
  const headerBytes = 16 + new DataView(original.buffer, original.byteOffset).getUint32(8, true);
  const frames = header.documents.map((document) =>
    original.slice(
      headerBytes + document.data.offset,
      headerBytes + document.data.offset + document.data.length,
    ),
  );
  const first = frames[0];
  const middle = frames[1];
  const last = frames[2];
  if (first === undefined || middle === undefined || last === undefined)
    throw new Error("Missing frames");
  const bytes = new Uint8Array(headerBytes + 65536 + last.length);
  bytes.set(original.subarray(0, headerBytes));
  bytes.set(first, headerBytes);
  bytes.set(middle, headerBytes + 8192);
  bytes[headerBytes + 8196] = (bytes[headerBytes + 8196] ?? 0) ^ 1;
  bytes.set(last, headerBytes + 65536);
  const key = "namespaces/document-windows/segments/1-sparse.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
  for (const sample of [
    {
      pages: [
        { offset: 0, length: first.length },
        { offset: 65536, length: last.length },
      ],
      status: 200,
      reads: 1,
      hits: 0,
      ids: ["0", "2"],
      bytes: bytes.length,
    },
    {
      pages: [
        { offset: 65536, length: last.length },
        { offset: 0, length: first.length },
      ],
      status: 200,
      reads: 0,
      hits: 2,
      ids: ["2", "0"],
      bytes: bytes.length,
    },
    {
      pages: [{ offset: 0, length: first.length }],
      status: 503,
      reads: 0,
      hits: 0,
      ids: [],
      bytes: headerBytes + first.length - 1,
    },
    {
      pages: [
        { offset: 65536, length: last.length },
        { offset: 8192, length: middle.length },
      ],
      status: 503,
      reads: 1,
      hits: 1,
      ids: [],
      bytes: bytes.length,
    },
    {
      pages: [{ offset: 8192, length: middle.length }],
      status: 503,
      reads: 0,
      hits: 1,
      ids: [],
      bytes: bytes.length,
    },
  ]) {
    const pending = fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: sample.bytes,
        metadataEnd: sample.bytes,
        pages: sample.pages,
      }),
    });
    const timely = await Promise.race([
      pending.then(() => true),
      Effect.runPromise(Effect.sleep("650 millis")).then(() => false),
    ]);
    const response = await pending;
    expect(timely).toBe(true);
    expect(response.status).toBe(sample.status);
    expect(response.headers.get("x-reads")).toBe(String(sample.reads));
    expect(response.headers.get("x-cache-hits")).toBe(String(sample.hits));
    expect(Number(response.headers.get("x-charged"))).toBeLessThan(8192);
    if (sample.status === 200) {
      const documents = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(
        await response.json(),
      );
      expect(documents.map((document) => document.id)).toEqual(sample.ids);
      expect(documents.map((document) => document.title)).toEqual(
        sample.ids.map((id) => `title${id}`),
      );
      expect(documents.map((document) => document.text)).toEqual(
        sample.ids.map((id) => `alpha unique${id}`),
      );
      expect(documents.map((document) => document.attributes)).toEqual(
        sample.ids.map((id) => ({ group: Number(id) })),
      );
    }
  }
});

for (const sample of [
  { name: "exact gap budget", extra: 0, copies: 1, reads: 1 },
  { name: "over gap budget", extra: 1, copies: 1, reads: 2 },
  { name: "duplicate pages", extra: 100, copies: 3, reads: 2 },
])
  test(`sparse document ranges enforce ${sample.name}`, async () => {
    await using active = await fixture();
    using segment = new Segment(
      JSON.stringify(
        canonicalFixtureDocuments(
          [0, 1].map((index) => ({
            id: String(index),
            revision: 1,
            title: "",
            text: `alpha unique${index}`,
            attributes: {},
          })),
        ),
      ),
    );
    const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
    const original = segment.bytes();
    const headerBytes = 16 + new DataView(original.buffer, original.byteOffset).getUint32(8, true);
    const frames = header.documents.map((document) =>
      original.slice(
        headerBytes + document.data.offset,
        headerBytes + document.data.offset + document.data.length,
      ),
    );
    const first = frames[0];
    const last = frames[1];
    if (first === undefined || last === undefined) throw new Error("Missing frames");
    const offset = first.length + 64 * 1024 + sample.extra;
    const bytes = new Uint8Array(headerBytes + offset + last.length);
    bytes.set(original.subarray(0, headerBytes));
    bytes.set(first, headerBytes);
    bytes.set(last, headerBytes + offset);
    const key = `namespaces/document-windows/segments/1-${sample.copies}-${sample.extra}.rsix`;
    await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
    const response = await fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: bytes.length,
        metadataEnd: bytes.length,
        pages: [
          ...Array.from({ length: sample.copies }, () => ({ offset: 0, length: first.length })),
          { offset, length: last.length },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-reads")).toBe(String(sample.reads));
    const documents = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(await response.json());
    expect(documents.map((document) => document.id)).toEqual([
      ...Array.from({ length: sample.copies }, () => "0"),
      "1",
    ]);
  });

test("sixteen document pages preserve caller order and a seventeenth fails before reading", async () => {
  await using active = await fixture();
  const documents = Array.from({ length: 17 }, (_, index) => ({
    id: String(index).padStart(2, "0"),
    revision: 1,
    title: "",
    text: `alpha unique${index}`,
    attributes: { group: index },
  }));
  using segment = new Segment(JSON.stringify(canonicalFixtureDocuments(documents)));
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const bytes = segment.bytes();
  const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const key = "namespaces/document-windows/segments/16-page-boundary.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
  for (const count of [17, 16, 16]) {
    const pages = header.documents
      .slice(0, count)
      .toReversed()
      .map((document) => document.data);
    const response = await fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: bytes.byteLength,
        metadataEnd: headerBytes + header.metadata_end,
        pages,
      }),
    });
    if (count === 17) {
      expect(response.status).toBe(503);
      expect(response.headers.get("x-reads")).toBe("0");
      continue;
    }
    expect(response.status).toBe(200);
    const decoded = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(await response.json());
    expect(decoded).toEqual(documents.slice(0, 16).toReversed());
    expect(Number(response.headers.get("x-reads"))).toBeLessThanOrEqual(1);
  }
});

test("metadata boundaries remain enforced on cache hits and vector bytes stay unread", async () => {
  await using active = await fixture();
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments([
        {
          id: "vector",
          revision: 1,
          title: "",
          text: "alpha",
          attributes: {},
          vector: [1, ...Array<number>(767).fill(0)],
        },
      ]),
    ),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const bytes = segment.bytes();
  const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const metadataEnd = headerBytes + header.metadata_end;
  const vector = header.vector_ranges[0];
  if (vector === undefined) throw new Error("Missing vector range");
  const corruptAt = headerBytes + vector.offset + 4;
  bytes[corruptAt] = (bytes[corruptAt] ?? 0) ^ 1;
  const key = "namespaces/document-windows/segments/metadata-boundary.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
  for (const sample of [
    { metadataEnd: headerBytes - 1, status: 503, reads: 0 },
    { metadataEnd: bytes.byteLength + 1, status: 503, reads: 0 },
    { metadataEnd: metadataEnd - 1, status: 503, reads: 0 },
    { metadataEnd, status: 200, reads: 1 },
    { metadataEnd: metadataEnd - 1, status: 503, reads: 0 },
    { metadataEnd, status: 200, reads: 0 },
  ]) {
    const response = await fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: bytes.byteLength,
        metadataEnd: sample.metadataEnd,
        pages: [header.documents[0].data],
      }),
    });
    expect(response.status).toBe(sample.status);
    expect(response.headers.get("x-reads")).toBe(String(sample.reads));
    expect(Number(response.headers.get("x-bytes"))).toBe(sample.reads * header.metadata_end);
    if (sample.status === 200) {
      const documents = Schema.decodeUnknownSync(Schema.Array(StoredDocument))(
        await response.json(),
      );
      expect(documents[0]?.id).toBe("vector");
      expect(documents[0]).not.toHaveProperty("vector");
    }
  }
});

test("large decoded metadata batches preserve the scalar fallback through R2 and cache hits", async () => {
  await using active = await fixture();
  const documents = Array.from({ length: 16 }, (_, index) => ({
    id: String(index).padStart(2, "0"),
    revision: 1,
    title: "",
    text: "x".repeat(70000),
    attributes: { group: index },
  }));
  using segment = new Segment(JSON.stringify(canonicalFixtureDocuments(documents)));
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const bytes = segment.bytes();
  const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const key = "namespaces/document-windows/segments/large-decoded.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
  for (const round of [0, 1]) {
    const response = await fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: bytes.byteLength,
        metadataEnd: headerBytes + header.metadata_end,
        pages: header.documents.toReversed().map((document) => document.data),
      }),
    });
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(Schema.Array(StoredDocument))(await response.json())).toEqual(
      documents.toReversed(),
    );
    if (round === 1) expect(response.headers.get("x-reads")).toBe("0");
  }
});

test("a corrupt sparse metadata batch admits no valid sibling page before whole-batch validation", async () => {
  await using active = await fixture();
  using segment = new Segment(
    JSON.stringify(
      canonicalFixtureDocuments(
        Array.from({ length: 3 }, (_, index) => ({
          id: String(index),
          revision: 1,
          title: "",
          text: `alpha unique${index}`,
          attributes: {},
        })),
      ),
    ),
  );
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const bytes = segment.bytes();
  const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const first = header.documents[0];
  const last = header.documents[2];
  if (first === undefined || last === undefined) throw new Error("Missing corrupt batch fixtures");
  const damaged = headerBytes + last.data.offset + 4;
  bytes[damaged] = (bytes[damaged] ?? 0) ^ 1;
  const key = "namespaces/document-windows/segments/corrupt-batch.rsix";
  await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
  for (const sample of [
    { pages: [first.data, last.data], status: 503, reads: "1" },
    { pages: [first.data], status: 200, reads: "1" },
    { pages: [first.data], status: 200, reads: "0" },
  ]) {
    const response = await fetch(new URL("/document-pages", await active.worker.ready), {
      method: "POST",
      headers: { authorization: "Bearer local-test-token" },
      body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
        source: { key, headerBytes },
        bytes: bytes.byteLength,
        metadataEnd: headerBytes + header.metadata_end,
        pages: sample.pages,
      }),
    });
    expect(response.status).toBe(sample.status);
    expect(response.headers.get("x-reads")).toBe(sample.reads);
    if (sample.status === 200)
      expect(
        Schema.decodeUnknownSync(Schema.Array(StoredDocument))(await response.json()).map(
          (document) => document.id,
        ),
      ).toEqual(["0"]);
  }
});

test("cached metadata batches preserve the exact decoded limit and count each page once on fallback", async () => {
  await using active = await fixture();
  for (const decodedBytes of [65536, 65537]) {
    const emptyDocuments = [0, 1].map((index) => ({
      id: String(index),
      revision: 1,
      title: "title",
      text: "",
      attributes: { flag: true, empty: null, number: 1.25 },
    }));
    using emptySegment = new Segment(JSON.stringify(canonicalFixtureDocuments(emptyDocuments)));
    const emptyBytes = emptySegment.bytes();
    const emptyHeader = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(
      emptySegment.header_json(),
    );
    const emptyView = new DataView(emptyBytes.buffer, emptyBytes.byteOffset);
    const emptyStart = 16 + emptyView.getUint32(8, true);
    const overhead = emptyHeader.documents.reduce(
      (sum, document) => sum + emptyView.getUint32(emptyStart + document.data.offset, true),
      0,
    );
    const first = emptyDocuments[0];
    if (first === undefined) throw new Error("Missing decoded boundary fixture");
    first.text = "x".repeat(decodedBytes - overhead);
    using segment = new Segment(JSON.stringify(canonicalFixtureDocuments(emptyDocuments)));
    const bytes = segment.bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const headerBytes = 16 + view.getUint32(8, true);
    const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
    const pages = header.documents.toReversed().map((document) => document.data);
    expect(
      pages.reduce((sum, page) => sum + view.getUint32(headerBytes + page.offset, true), 0),
    ).toBe(decodedBytes);
    const projected = segment_query_documents(
      bytes,
      new Uint32Array(pages.flatMap((page) => [headerBytes + page.offset, page.length])),
    );
    if (decodedBytes === 65536) expect(projected).toBeDefined();
    else expect(projected).toBeUndefined();
    const key = `namespaces/document-windows/segments/decoded-${decodedBytes}.rsix`;
    await (await active.worker.getR2Bucket("STORAGE")).put(key, bytes);
    for (const round of [0, 1, 2]) {
      const response = await fetch(new URL("/document-pages", await active.worker.ready), {
        method: "POST",
        headers: { authorization: "Bearer local-test-token" },
        body: Schema.encodeSync(Schema.fromJsonString(DocumentPageProbeInput))({
          source: { key, headerBytes },
          bytes: bytes.byteLength,
          metadataEnd: headerBytes + header.metadata_end,
          pages,
        }),
      });
      expect(response.status).toBe(200);
      expect(Schema.decodeUnknownSync(Schema.Array(StoredDocument))(await response.json())).toEqual(
        emptyDocuments.toReversed(),
      );
      if (round > 0) {
        expect(response.headers.get("x-reads")).toBe("0");
        expect(response.headers.get("x-cache-hits")).toBe("2");
      }
    }
  }
});
