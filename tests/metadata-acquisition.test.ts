import { expect, test } from "bun:test";
import { Effect, Match, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Segment,
  initSync,
  segment_query_document,
  segment_query_documents,
} from "../dist/wasm/raio_engine";
import {
  SegmentHeader,
  StoredDocument,
  QueryDocument,
  Metadata,
  QueryResult,
} from "../src/protocol";
import {
  MetadataAcquisitionHitProbe,
  MetadataAcquisitionPageProbe,
  MetadataAcquisitionHitResult,
  MetadataAcquisitionPageResult,
  MetadataAcquisitionState,
  type MetadataAcquisitionLocations,
  MetadataAcquisitionSource,
} from "./metadata-acquisition-contract";
import { request, startWorker, write } from "./harness";
initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});
const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };

async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-metadata-acquisition-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "metadata-acquisition-worker.ts")],
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

async function settle(check: () => Promise<boolean>) {
  for (const _attempt of Array.from({ length: 400 })) {
    if (await check()) return;
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
  throw new Error("Wide handoff race barrier did not settle");
}

test("wide metadata acquisition preserves native batches, validation, admission and bounded concurrency", async () => {
  await using active = await fixture();
  const { worker } = active;
  await using cleanup = new AsyncDisposableStack();
  const origin = await worker.ready;
  const bucket = await worker.getR2Bucket("STORAGE");
  const call = async (path: string, body?: string) => {
    if (body === undefined) return fetch(new URL(path, origin), { method: "POST", headers });
    return fetch(new URL(path, origin), { method: "POST", headers, body });
  };
  cleanup.defer(async () => {
    expect((await call("/release-wide", "")).status).toBe(204);
  });
  const state = async () => {
    const response = await fetch(new URL("/state", origin), { headers });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(MetadataAcquisitionState)(await response.json());
  };
  const make = async (
    name: string,
    count = 100,
    repeats = 1,
    entropy = false,
    entropyBytes = 6000,
  ) => {
    const documents = Array.from({ length: count }, (_, index) => ({
      id: String(index).padStart(4, "0"),
      revision: index + 1,
      title: `title ${index}`,
      text: Match.value(entropy).pipe(
        Match.when(true, () =>
          btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(entropyBytes)))),
        ),
        Match.orElse(() => `${"alpha beta ".repeat(repeats)}value${index}`),
      ),
      attributes: { group: index % 3, flag: index % 2 === 0 },
    }));
    using segment = new Segment(
      Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))(documents),
    );
    const bytes = segment.bytes();
    const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
    const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
    const source = {
      key: `namespaces/wide-${name}/segments/metadata.rsix`,
      headerBytes,
      bytes: bytes.length,
      metadataEnd: headerBytes + header.metadata_end,
    };
    await bucket.put(source.key, bytes);
    const pages = header.documents.map((doc) => doc.data);
    const scalar = pages.map((page) =>
      Schema.decodeSync(Schema.fromJsonString(QueryDocument))(
        segment_query_document(
          bytes.subarray(headerBytes + page.offset, headerBytes + page.offset + page.length),
        ),
      ),
    );
    return { source, bytes, header, pages, scalar, documents };
  };
  const pageCall = async (
    sample: Awaited<ReturnType<typeof make>>,
    indices: readonly number[],
    clear = false,
  ) =>
    call(
      "/pages",
      Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionPageProbe))({
        source: sample.source,
        pages: indices.map((index) => {
          const page = sample.pages[index];
          if (page === undefined) throw new Error("Missing fixture page");
          return page;
        }),
        payloadOffset: "normal",
        clear,
      }),
    );
  const locations = (sample: Awaited<ReturnType<typeof make>>, indices: readonly number[]) =>
    indices.map((index) => {
      const page = sample.pages[index];
      if (page === undefined) throw new Error("Missing fixture page");
      return [sample.source, page, index + 0.25] as const;
    });
  const hitCall = async (input: typeof MetadataAcquisitionLocations.Type, clear = false) =>
    call(
      "/hits",
      Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionHitProbe))({
        locations: input,
        clear,
      }),
    );
  const readHits = async (
    response: Response,
    input: typeof MetadataAcquisitionLocations.Type,
    samples: ReadonlyArray<Awaited<ReturnType<typeof make>>>,
  ) => {
    expect(response.status).toBe(200);
    const rows = Schema.decodeUnknownSync(MetadataAcquisitionHitResult)(await response.json());
    expect(rows).toHaveLength(input.length);
    for (const [index, location] of input.entries()) {
      const sample = samples.find((candidate) => candidate.source.key === location[0].key);
      if (sample === undefined) throw new Error("Missing source oracle");
      const row = sample.header.documents.findIndex(
        (doc) => doc.data.offset === location[1].offset,
      );
      const expected = sample.scalar[row];
      if (expected === undefined) throw new Error("Missing scalar oracle");
      expect(rows[index]).toEqual({
        id: expected.id,
        title: expected.title ?? "",
        text: expected.text,
        attributes: expected.attributes,
        revision: expected.revision,
        score: location[2],
      });
    }
    return rows;
  };
  const hundred = await make("contiguous");
  const order = Array.from({ length: 100 }, (_, index) => (index * 37) % 100);
  const hundredInput = locations(hundred, order);
  expect(hundred.header.metadata_end).toBeLessThanOrEqual(128 * 1024);
  const first = await hitCall(hundredInput, true);
  await readHits(first, hundredInput, [hundred]);
  expect(first.headers.get("x-reads")).toBe("1");
  const firstState = await state();
  expect(firstState.reads).toBe(1);
  expect(firstState.peak).toBe(1);
  const expectedCharge = hundred.pages.reduce(
    (total, page) =>
      total +
      page.length +
      `raio-test:${hundred.source.key}/${hundred.source.headerBytes + page.offset}/${page.length}`
        .length *
        4 +
      128,
    0,
  );
  expect(Number(first.headers.get("x-charged"))).toBe(expectedCharge);
  const warm = await hitCall(hundredInput);
  await readHits(warm, hundredInput, [hundred]);
  expect(warm.headers.get("x-reads")).toBe("0");
  expect(warm.headers.get("x-charged")).toBe("0");
  const clipped = await make("aligned-clipped", 20, 1, true, 6100);
  const clippedPages = clipped.pages.slice(0, 19);
  const clippedLast = clippedPages.at(-1);
  if (clippedLast === undefined) throw new Error("Missing clipping boundary frame");
  const clippedSpan = clippedLast.offset + clippedLast.length;
  const clippedSelected = clippedPages.reduce((total, page) => total + page.length, 0);
  const unclippedEnd = 128 * 1024;
  expect(clippedSpan).toBe(clippedSelected);
  expect(clippedSpan).toBeGreaterThanOrEqual(unclippedEnd - 16 * 1024);
  expect(clipped.header.metadata_end).toBeGreaterThan(clippedSpan);
  expect(clipped.header.metadata_end).toBeLessThan(unclippedEnd);
  expect(unclippedEnd).toBeLessThanOrEqual(4 * clippedSpan);
  expect(unclippedEnd - clippedSpan).toBeLessThanOrEqual(16 * 1024);
  expect(unclippedEnd - clippedSelected).toBeLessThanOrEqual(64 * 1024);
  const clippedBytes = new Uint8Array(clipped.bytes.length + 8192);
  clippedBytes.set(clipped.bytes);
  clippedBytes.fill(255, clipped.source.metadataEnd);
  clipped.source.bytes = clippedBytes.length;
  await bucket.put(clipped.source.key, clippedBytes);
  const clippedInput = locations(
    clipped,
    Array.from({ length: 19 }, (_, index) => index),
  );
  expect(clipped.source.headerBytes + unclippedEnd).toBeLessThanOrEqual(clippedBytes.length);
  await readHits(await hitCall(clippedInput, true), clippedInput, [clipped]);
  expect((await state()).lengths).toEqual([clipped.header.metadata_end]);
  expect((await state()).bytes).toBe(clipped.source.metadataEnd - clipped.source.headerBytes);
  const point = await make("aligned-point", 100);
  const pointInput = locations(point, [0]);
  await readHits(await hitCall(pointInput, true), pointInput, [point]);
  expect((await state()).lengths).toEqual([Math.min(4096, point.header.metadata_end)]);
  for (const geometry of [
    { name: "alignment-four-times-rejection", entropyBytes: 2000, multiple: 3, extra: 1 },
    { name: "alignment-padding-rejection", entropyBytes: 6000, multiple: 0, extra: 16385 },
  ]) {
    const sample = await make(geometry.name, 2, 1, true, geometry.entropyBytes);
    const selectedBytes = sample.pages.reduce((total, page) => total + page.length, 0);
    const padding = geometry.multiple * selectedBytes + geometry.extra;
    expect(selectedBytes).toBeGreaterThan(4096);
    expect(selectedBytes + padding).toBeLessThanOrEqual(128 * 1024);
    expect(padding).toBeLessThanOrEqual(64 * 1024);
    if (geometry.multiple > 0) {
      expect(selectedBytes + padding).toBeGreaterThan(4 * selectedBytes);
      expect(padding).toBeLessThanOrEqual(16 * 1024);
    } else {
      expect(selectedBytes + padding).toBeLessThanOrEqual(4 * selectedBytes);
      expect(padding).toBeGreaterThan(16 * 1024);
    }
    const expanded = new Uint8Array(sample.bytes.length + padding);
    expanded.set(sample.bytes);
    sample.source.bytes += padding;
    sample.source.metadataEnd += padding;
    await bucket.put(sample.source.key, expanded);
    const input = locations(sample, [0, 1]);
    await readHits(await hitCall(input, true), input, [sample]);
    expect((await state()).lengths).toEqual([selectedBytes]);
  }
  for (const geometry of [
    { name: "alignment-prefix-suffix-overfetch", prefix: 32768, tail: 32769 },
    { name: "alignment-physical-cap", prefix: 120000, tail: 131072 },
  ]) {
    const base = await make(geometry.name, 2, 1, true, 6000);
    const pages = base.pages.map((page) => ({
      offset: page.offset + geometry.prefix,
      length: page.length,
    }));
    const source = Object.assign({}, base.source, {
      bytes: base.source.bytes + geometry.prefix + geometry.tail,
      metadataEnd: base.source.metadataEnd + geometry.prefix + geometry.tail,
    });
    const payload = new Uint8Array(source.bytes);
    payload.set(base.bytes.subarray(0, source.headerBytes));
    for (const [index, page] of pages.entries()) {
      const original = base.pages[index];
      if (original === undefined) throw new Error("Missing alignment frame");
      payload.set(
        base.bytes.subarray(
          source.headerBytes + original.offset,
          source.headerBytes + original.offset + original.length,
        ),
        source.headerBytes + page.offset,
      );
    }
    await bucket.put(source.key, payload);
    const selected = pages.map((page, index) => [source, page, index + 0.25] as const);
    const response = await hitCall(selected, true);
    expect(response.status).toBe(200);
    const rows = Schema.decodeUnknownSync(MetadataAcquisitionHitResult)(await response.json());
    expect(rows.map((row) => row.id)).toEqual(base.scalar.map((row) => row.id));
    expect((await state()).lengths).toEqual([
      pages.reduce((total, page) => total + page.length, 0),
    ]);
  }
  const seventeen = await pageCall(hundred, order.slice(0, 17), true);
  expect(seventeen.status).toBe(503);
  expect(seventeen.headers.get("x-reads")).toBe("0");
  expect((await state()).reads).toBe(0);
  const fallback = await make("fallback", 100, 900);
  const first16 = fallback.pages.slice(0, 16);
  const last16 = first16.at(-1);
  if (last16 === undefined) throw new Error("Missing fallback pages");
  const span = fallback.bytes.subarray(
    fallback.source.headerBytes,
    fallback.source.headerBytes + last16.offset + last16.length,
  );
  expect(
    segment_query_documents(
      span,
      new Uint32Array(first16.flatMap((page) => [page.offset, page.length])),
    ),
  ).toBeUndefined();
  const fallbackInput = locations(fallback, order);
  const fallen = await hitCall(fallbackInput, true);
  await readHits(fallen, fallbackInput, [fallback]);
  expect(fallen.headers.get("x-reads")).toBe("1");
  const corrupt = await make("corrupt");
  const damaged = corrupt.pages[20];
  if (damaged === undefined) throw new Error("Missing corrupt frame");
  const bad = corrupt.bytes.slice();
  const at = corrupt.source.headerBytes + damaged.offset + 4;
  bad[at] = (bad[at] ?? 0) ^ 1;
  await bucket.put(corrupt.source.key, bad);
  const failed = await hitCall(
    locations(
      corrupt,
      Array.from({ length: 100 }, (_, offset) => offset),
    ),
    true,
  );
  expect(failed.status).toBe(503);
  expect(failed.headers.get("x-reads")).toBe("1");
  const admitted = await pageCall(
    corrupt,
    Array.from({ length: 16 }, (_, offset) => offset),
  );
  expect(admitted.status).toBe(200);
  expect(admitted.headers.get("x-reads")).toBe("0");
  expect(Schema.decodeUnknownSync(MetadataAcquisitionPageResult)(await admitted.json())).toEqual(
    corrupt.scalar.slice(0, 16),
  );
  const sibling = await pageCall(corrupt, [17]);
  expect(sibling.status).toBe(200);
  expect(sibling.headers.get("x-reads")).toBe("1");
  expect(Schema.decodeUnknownSync(MetadataAcquisitionPageResult)(await sibling.json())).toEqual(
    corrupt.scalar.slice(17, 18),
  );
  const old = await make("fallback-paths");
  for (const indices of [
    [0, 0, 1, 1, 2],
    [0, 2, 4, 6, 8],
    Array.from({ length: 33 }, (_, index) => index),
  ]) {
    const oldInput = locations(old, indices);
    const response = await hitCall(oldInput, true);
    await readHits(response, oldInput, [old]);
  }
  expect((await pageCall(old, [0], true)).status).toBe(200);
  const partialInput = locations(
    old,
    Array.from({ length: 33 }, (_, offset) => offset),
  );
  await readHits(await hitCall(partialInput), partialInput, [old]);
  const gapSource = await make("bounded-gap-corrupt", 201);
  const skipped = gapSource.pages[1];
  if (skipped === undefined) throw new Error("Missing unselected gap frame");
  const gapBad = gapSource.bytes.slice();
  const gapCrc = gapSource.source.headerBytes + skipped.offset + 4;
  gapBad[gapCrc] = (gapBad[gapCrc] ?? 0) ^ 1;
  await bucket.put(gapSource.source.key, gapBad);
  const gapOrder = Array.from({ length: 33 }, (_, index) => index * 6).toReversed();
  const gapInput = locations(gapSource, gapOrder);
  const gapSpan = gapSource.pages[192];
  if (gapSpan === undefined) throw new Error("Missing final sparse page");
  const selectedBytes = gapInput.reduce((total, location) => total + location[1].length, 0);
  expect(gapSpan.offset + gapSpan.length - selectedBytes).toBeLessThanOrEqual(64 * 1024);
  expect(gapSpan.offset + gapSpan.length).toBeLessThanOrEqual(128 * 1024);
  const bounded = await hitCall(gapInput, true);
  await readHits(bounded, gapInput, [gapSource]);
  expect(bounded.headers.get("x-reads")).toBe("1");
  expect((await state()).reads).toBe(1);
  const sparseCharge = gapInput.reduce(
    (total, location) =>
      total +
      location[1].length +
      `raio-test:${gapSource.source.key}/${gapSource.source.headerBytes + location[1].offset}/${location[1].length}`
        .length *
        4 +
      128,
    0,
  );
  expect(Number(bounded.headers.get("x-charged"))).toBe(sparseCharge);
  const unselected = await pageCall(gapSource, [1]);
  expect(unselected.status).toBe(503);
  expect(unselected.headers.get("x-reads")).toBe("1");
  for (const geometry of [
    { name: "gap-budget-exact", gap: 64 * 1024, expected: 1 },
    { name: "gap-budget-over", gap: 64 * 1024 + 1, expected: 2 },
  ]) {
    const base = await make(geometry.name, 32);
    const pages = base.pages.map((page, index) => {
      if (index < 16) return page;
      return { offset: page.offset + geometry.gap, length: page.length };
    });
    const source = Object.assign({}, base.source, {
      bytes: base.source.bytes + geometry.gap,
      metadataEnd: base.source.metadataEnd + geometry.gap,
    });
    const payload = new Uint8Array(source.bytes);
    payload.set(base.bytes.subarray(0, source.headerBytes));
    for (const [index, page] of pages.entries()) {
      const original = base.pages[index];
      if (original === undefined) throw new Error("Missing relocated original frame");
      payload.set(
        base.bytes.subarray(
          source.headerBytes + original.offset,
          source.headerBytes + original.offset + original.length,
        ),
        source.headerBytes + page.offset,
      );
    }
    await bucket.put(source.key, payload);
    const header = Object.assign({}, base.header, {
      documents: base.header.documents.map((document, index) => {
        const data = pages[index];
        if (data === undefined) throw new Error("Missing relocated page");
        return Object.assign({}, document, { data });
      }),
    });
    const sample = Object.assign({}, base, { source, bytes: payload, pages, header });
    const selectedLocations = locations(
      sample,
      Array.from({ length: 32 }, (_, index) => 31 - index),
    );
    const response = await hitCall(selectedLocations, true);
    await readHits(response, selectedLocations, [sample]);
    expect(response.headers.get("x-reads")).toBe(String(geometry.expected));
    expect((await state()).reads).toBe(geometry.expected);
  }
  const oversized = await make("span-budget-over", 32, 1, true);
  const lastOversized = oversized.pages.at(-1);
  if (lastOversized === undefined) throw new Error("Missing oversized metadata page");
  expect(lastOversized.offset + lastOversized.length).toBeGreaterThan(128 * 1024);
  expect(oversized.pages.reduce((total, page) => total + page.length, 0)).toBe(
    lastOversized.offset + lastOversized.length,
  );
  const oversizedInput = locations(
    oversized,
    Array.from({ length: 32 }, (_, index) => 31 - index),
  );
  const oversizedResponse = await hitCall(oversizedInput, true);
  await readHits(oversizedResponse, oversizedInput, [oversized]);
  expect(oversizedResponse.headers.get("x-reads")).toBe("2");
  expect((await state()).reads).toBe(2);
  const raced = await make("handoff-race", 100, 1, true, 800);
  expect(raced.header.metadata_end).toBeLessThanOrEqual(128 * 1024);
  for (const start of [0, 16, 32, 48, 64, 80]) {
    const firstChunkPage = raced.pages[start];
    const last = raced.pages[start + 15];
    if (firstChunkPage === undefined || last === undefined) throw new Error("Missing race chunk");
    expect(last.offset + last.length - firstChunkPage.offset).toBeGreaterThan(4096);
  }
  expect(
    (
      await call(
        "/arm-wide",
        Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionSource))(raced.source),
      )
    ).status,
  ).toBe(204);
  const raceInput = locations(
    raced,
    Array.from({ length: 100 }, (_, index) => 99 - index),
  );
  const pendingWide = hitCall(raceInput);
  await settle(async () => (await state()).wideStarted === 1);
  const racedPoint = await pageCall(raced, [0]);
  expect(racedPoint.status).toBe(200);
  expect(Schema.decodeUnknownSync(MetadataAcquisitionPageResult)(await racedPoint.json())).toEqual(
    raced.scalar.slice(0, 1),
  );
  const heldWide = await state();
  expect(heldWide.wideFinished).toBe(0);
  expect(heldWide.reads).toBe(2);
  expect((await call("/release-wide", "")).status).toBe(204);
  await readHits(await pendingWide, raceInput, [raced]);
  const racedState = await state();
  expect(racedState.reads).toBe(2);
  expect(racedState.wideStarted).toBe(1);
  expect(racedState.wideFinished).toBe(1);
  expect(racedState.active).toBe(0);
  const mutationBatch = await make("batch-mutation", 16);
  const mutationPayload = mutationBatch.bytes.subarray(
    mutationBatch.source.headerBytes,
    mutationBatch.source.metadataEnd,
  );
  const mutation = await call(
    "/mutate-payload",
    Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionPageProbe))({
      source: mutationBatch.source,
      pages: mutationBatch.pages,
      payload: Array.from(mutationPayload),
      payloadOffset: "normal",
      clear: true,
    }),
  );
  expect(mutation.status).toBe(200);
  expect(Schema.decodeUnknownSync(MetadataAcquisitionPageResult)(await mutation.json())).toEqual(
    mutationBatch.scalar,
  );
  expect(mutation.headers.get("x-reads")).toBe("0");
  expect((await state()).reads).toBe(0);
  const cachedPayload = await make("cached-precedence", 100, 1, true, 800);
  const cachedFirst = cachedPayload.pages[0];
  const payloadSecond = cachedPayload.pages[16];
  if (cachedFirst === undefined || payloadSecond === undefined)
    throw new Error("Missing precedence frames");
  expect(payloadSecond.offset).toBeGreaterThan(4096);
  const warmedFirst = await pageCall(cachedPayload, [0], true);
  expect(warmedFirst.status).toBe(200);
  expect(Schema.decodeUnknownSync(MetadataAcquisitionPageResult)(await warmedFirst.json())).toEqual(
    cachedPayload.scalar.slice(0, 1),
  );
  expect((await state()).reads).toBe(1);
  const handed = cachedPayload.bytes.slice(
    cachedPayload.source.headerBytes,
    cachedPayload.source.headerBytes + payloadSecond.offset + payloadSecond.length,
  );
  handed[cachedFirst.offset + 4] = (handed[cachedFirst.offset + 4] ?? 0) ^ 1;
  const preferred = await call(
    "/mutate-payload",
    Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionPageProbe))({
      source: cachedPayload.source,
      pages: [cachedFirst, payloadSecond],
      payload: Array.from(handed),
      payloadOffset: "normal",
      clear: false,
    }),
  );
  expect(preferred.status).toBe(200);
  expect(Schema.decodeUnknownSync(MetadataAcquisitionPageResult)(await preferred.json())).toEqual(
    cachedPayload.scalar.slice(0, 1).concat(cachedPayload.scalar.slice(16, 17)),
  );
  expect(preferred.headers.get("x-reads")).toBe("0");
  expect((await state()).reads).toBe(1);
  const firstPage = hundred.pages[0];
  if (firstPage === undefined) throw new Error("Missing bound page");
  for (const source of [
    Object.assign({}, hundred.source, { metadataEnd: hundred.source.headerBytes - 1 }),
    Object.assign({}, hundred.source, { metadataEnd: hundred.source.bytes + 1 }),
  ]) {
    const rejected = await call(
      "/hits",
      Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionHitProbe))({
        locations: [[source, firstPage, 1]],
        clear: true,
      }),
    );
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("x-reads")).toBe("0");
    expect((await state()).reads).toBe(0);
  }
  for (const offset of [hundred.source.metadataEnd, 4294967295]) {
    const response = await call(
      "/pages",
      Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionPageProbe))({
        source: hundred.source,
        pages: [{ offset, length: firstPage.length }],
        payloadOffset: "normal",
        clear: true,
      }),
    );
    expect(response.status).toBe(503);
    expect((await state()).reads).toBe(0);
  }
  const firstPayload = Array.from(
    hundred.bytes.subarray(
      hundred.source.headerBytes,
      hundred.source.headerBytes + firstPage.offset + firstPage.length,
    ),
  );
  const provided = await call(
    "/pages",
    Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionPageProbe))({
      source: hundred.source,
      pages: [firstPage],
      payload: firstPayload,
      payloadOffset: "normal",
      clear: true,
    }),
  );
  expect(provided.status).toBe(200);
  expect(Schema.decodeUnknownSync(MetadataAcquisitionPageResult)(await provided.json())).toEqual(
    hundred.scalar.slice(0, 1),
  );
  expect((await state()).reads).toBe(0);
  for (const payloadOffset of ["nan", "fraction", "infinity"] as const) {
    const response = await call(
      "/pages",
      Schema.encodeSync(Schema.fromJsonString(MetadataAcquisitionPageProbe))({
        source: hundred.source,
        pages: [firstPage],
        payload: firstPayload,
        payloadOffset,
        clear: true,
      }),
    );
    expect(response.status).toBe(503);
    expect((await state()).reads).toBe(0);
  }
  for (const geometry of [
    { name: "singletons", sources: 12, pages: 1, repeats: 1, limit: 8 },
    { name: "small", sources: 12, pages: 17, repeats: 1, limit: 8 },
    { name: "large", sources: 12, pages: 100, repeats: 100, limit: 4 },
  ]) {
    const samples = [];
    for (const index of Array.from({ length: geometry.sources }, (_, offset) => offset))
      samples.push(
        await make(`concurrency-${geometry.name}-${index}`, geometry.pages, geometry.repeats),
      );
    const all = samples.flatMap((sample) =>
      locations(
        sample,
        Array.from({ length: geometry.pages }, (_, offset) => offset),
      ),
    );
    const response = await hitCall(all, true);
    await readHits(response, all, samples);
    const pressure = await state();
    expect(pressure.peak).toBeGreaterThan(1);
    expect(pressure.peak).toBeLessThanOrEqual(geometry.limit);
    expect(pressure.active).toBe(0);
    expect(pressure.reads).toBe(geometry.sources);
  }
}, 60000);

test("aligned metadata survives process-cache rebuild through the native Cache API across topK", async () => {
  await using cleanup = new AsyncDisposableStack();
  const worker = await startWorker();
  cleanup.defer(() => worker.dispose());
  const namespace = "aligned-query-reuse";
  const documents = Array.from({ length: 100 }, (_document, index) => ({
    id: String(index).padStart(4, "0"),
    text: `shared ${index} ${Array.from({ length: 300 }, (_character, at) => String.fromCharCode(97 + ((at * 17 + index * 13) % 26))).join("")}`,
    attributes: { group: index % 3 },
  }));
  expect((await request(worker, namespace, "write", write(documents))).status).toBe(200);
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const query = {
    kind: "text",
    text: "shared",
    match: "any",
    topK: 100,
    filters: [],
    minimumSequence: 1,
  };
  const primeResponse = await request(worker, namespace, "query", query);
  expect(primeResponse.status).toBe(200);
  const prime = Schema.decodeUnknownSync(QueryResult)(await primeResponse.json());
  expect(prime.rows).toHaveLength(100);
  await Effect.runPromise(Effect.sleep("100 millis"));
  const bucket = await worker.getR2Bucket("STORAGE");
  const before = await bucket.get(`namespaces/${namespace}/root.json`);
  if (before === null) throw new Error("Missing query root");
  const rootBytes = await before.text();
  expect((await request(worker, namespace, "rebuild", {})).status).toBe(200);
  const after = await bucket.get(`namespaces/${namespace}/root.json`);
  if (after === null) throw new Error("Missing rebuilt query root");
  expect(after.etag).toBe(before.etag);
  expect(await after.text()).toBe(rootBytes);
  const metadataBeforeResponse = await request(worker, namespace, "metadata");
  const metadataBefore = Schema.decodeUnknownSync(Metadata)(await metadataBeforeResponse.json());
  const targetResponse = await request(
    worker,
    namespace,
    "query",
    Object.assign({}, query, { topK: 50 }),
  );
  expect(targetResponse.status).toBe(200);
  const target = Schema.decodeUnknownSync(QueryResult)(await targetResponse.json());
  expect(target).toEqual(Object.assign({}, prime, { rows: prime.rows.slice(0, 50) }));
  const metadataAfterResponse = await request(worker, namespace, "metadata");
  const metadataAfter = Schema.decodeUnknownSync(Metadata)(await metadataAfterResponse.json());
  expect(metadataAfter.cache.rangeReads - metadataBefore.cache.rangeReads).toBe(1);
  expect(metadataAfter.cache.cacheApiHits - metadataBefore.cache.cacheApiHits).toBe(1);
});
