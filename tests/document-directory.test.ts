import { expect, test } from "bun:test";
import { Effect, Match, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Directory, Segment, initSync } from "../dist/wasm/raio_engine";
import {
  LocatedDocument,
  SegmentDocument,
  SegmentHeader,
  StoredDocument,
  TermProjectionRange,
} from "../src/protocol";
import { startWorker } from "./harness";
import {
  DocumentDirectoryArm,
  DocumentDirectoryProbe,
  DocumentDirectoryResult,
  DocumentDirectoryState,
  type DocumentDirectoryProjection,
} from "./document-directory-contract";
initSync({
  module: new WebAssembly.Module(
    await Bun.file(join(import.meta.dir, "../dist/wasm/raio_engine_bg.wasm")).arrayBuffer(),
  ),
});
const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-document-directory-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "document-directory-worker.ts")],
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
  for (const _attempt of Array.from({ length: 200 })) {
    if (await check()) return;
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
  throw new Error("Directory fixture barrier did not settle");
}

test("document-only common reuse preserves projections, misses, active lifetimes and saturation", async () => {
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
    expect((await call("/release-get")).status).toBe(204);
    expect((await call("/release-use")).status).toBe(204);
  });
  const state = async () => {
    const response = await fetch(new URL("/state", origin), { headers });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(DocumentDirectoryState)(await response.json());
  };
  using segment = new Segment(
    Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredDocument)))([
      {
        id: "a",
        revision: 3,
        title: "common rust",
        text: "common rust uniquealpha",
        attributes: { group: 1, flag: true, note: null, ratio: 1.25 },
        vector: [0.5, -1, 0, 2],
      },
      {
        id: "b",
        revision: 7,
        title: "common",
        text: "common rust uniquebeta",
        attributes: { group: 0, flag: false, label: "b" },
      },
      {
        id: "c",
        revision: 11,
        title: "common rust",
        text: "common uniquegamma",
        attributes: { group: 1, safe: 9007199254740991 },
        vector: [1, 2, 3, 4],
      },
      {
        id: "d",
        revision: 13,
        title: "common",
        text: "common rust uniquedelta",
        attributes: { group: 0, label: "d" },
      },
    ]),
  );
  const bytes = segment.bytes();
  const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
  const headerBytes = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using canonical = Directory.canonical(bytes.subarray(0, headerBytes), headerBytes);
  const common = canonical.common_frame(headerBytes, bytes);
  const full = canonical.compressed_frame(headerBytes);
  const ids = ["d", "c", "missing", "a", "b"];
  const dead = [2];
  const rows = [3, 1, 0, 2];
  const idsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))(ids);
  const deadJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(dead);
  const rowsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(rows);
  const golden = {
    partial: false,
    lookup: Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
      canonical.lookup(idsJson, deadJson),
    ),
    rows: Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
      canonical.rows(rowsJson),
    ),
    vectors: Schema.decodeSync(Schema.fromJsonString(Schema.Array(SegmentDocument)))(
      canonical.vectors(deadJson),
    ),
  };
  expect(golden.lookup.map((row) => row.document.id)).toEqual(["d", "a", "b"]);
  expect(golden.vectors.map((row) => row.id)).toEqual(["a"]);
  expect(golden.lookup.find((row) => row.document.id === "a")?.vectorData).not.toBeNull();
  const equalProjection = (actual: typeof DocumentDirectoryProjection.Type) => {
    expect(actual.lookup).toEqual(golden.lookup);
    expect(actual.rows).toEqual(golden.rows);
    expect(actual.vectors).toEqual(golden.vectors);
  };
  const read = async (response: Response) => {
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(DocumentDirectoryResult)(await response.json());
    equalProjection(result.first);
    equalProjection(result.second);
    expect(result.second).toEqual(result.first);
    return result;
  };
  for (const mode of [
    "uncached",
    "cached",
    "pending",
    "pending-missing",
    "pending-failure",
    "pending-corrupt",
    "pinned-eviction",
    "saturated",
  ]) {
    const key = `namespaces/document-reuse/segments/${mode}.rsix`;
    const source = { key, headerBytes };
    const sourceJson = Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))(source);
    await bucket.put(key, bytes);
    await bucket.put(`cache/directory-v5/${key}/${headerBytes}`, full, {
      customMetadata: { source: sourceJson },
    });
    const cache = `cache/directory-common-v3/${key}/${headerBytes}`;
    if (mode === "pending-corrupt") {
      const corrupt = common.slice();
      corrupt[16] = (corrupt[16] ?? 0) ^ 1;
      await bucket.put(cache, corrupt, { customMetadata: { source: sourceJson } });
    } else if (mode !== "pending-missing" && mode !== "uncached")
      await bucket.put(cache, common, { customMetadata: { source: sourceJson } });
    if (mode === "saturated")
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
    const pending = mode.startsWith("pending");
    expect(
      (
        await call(
          "/arm",
          Schema.encodeSync(Schema.fromJsonString(DocumentDirectoryArm))({
            source,
            outcome: Match.value(mode).pipe(
              Match.when("pending-missing", () => "missing" as const),
              Match.when("pending-failure", () => "failure" as const),
              Match.orElse(() => "present" as const),
            ),
            holdGet: pending,
            holdUse: mode === "pinned-eviction",
          }),
        )
      ).status,
    ).toBe(204);
    const input = {
      source,
      ranking: {
        text: "common rust",
        mode: "phrase" as const,
        top_k: 10,
        dead: [],
        filters: [],
        statistics: {
          documents: header.documents.length,
          title_length: header.total_title_length,
          body_length: header.total_body_length,
          frequencies: Object.fromEntries(
            Object.entries(header.terms).map(([term, meta]) => [term, meta.df]),
          ),
        },
      },
      ids,
      dead,
      rows,
      saturate: mode === "saturated",
    };
    const body = Schema.encodeSync(Schema.fromJsonString(DocumentDirectoryProbe))(input);
    if (mode === "uncached") {
      const result = await read(await call("/lookup", body));
      expect(result.first.partial).toBe(false);
      expect((await state()).commonStarted).toBe(0);
      continue;
    }
    if (pending) {
      const warm = call("/warm", body);
      await settle(async () => (await state()).commonStarted === 1);
      const lookup = call("/lookup", body);
      await settle(async () => (await state()).lookupStarted === 1);
      const result = await read(await lookup);
      expect(result.first.partial).toBe(false);
      expect((await state()).commonFinished).toBe(0);
      expect((await call("/release-get")).status).toBe(204);
      await read(await warm);
      expect((await state()).commonStarted).toBe(1);
      continue;
    }
    const warmed = await read(await call("/warm", body));
    expect(warmed.first.partial).toBe(true);
    const before = await state();
    const lookup = call("/lookup", body);
    if (mode === "pinned-eviction") {
      await settle(async () => (await state()).useStarted === 1);
      expect((await call("/clear")).status).toBe(204);
      expect((await call("/release-use")).status).toBe(204);
    }
    const result = await read(await lookup);
    expect(result.first.partial).toBe(true);
    if (mode === "saturated") expect(result.held).toBe(64);
    const after = await state();
    expect(after.commonStarted).toBe(before.commonStarted);
    if (mode !== "saturated") expect(after.fullReads).toBe(before.fullReads);
  }
}, 60000);
