import { afterAll, expect, test } from "bun:test";
import { crc32 } from "node:zlib";
import { Schema, Struct } from "effect";
import { Directory, initSync, segment_query_document } from "../dist/wasm/raio_engine";
import { decodeRoot, encodeRoot } from "../src/manifest";
import { QueryDocument, QueryResult, LocatedDocument } from "../src/protocol";
import { request, startWorker, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const worker = await startWorker();
afterAll(() => worker.dispose());
const vector = (x: number, y = 0) => [x, y, ...Array.from({ length: 766 }, () => 0)];
const hybrid = { kind: "hybrid", text: "lexical", vector: vector(1), topK: 2, filters: [] };

async function source(namespace: string, id: string) {
  const bucket = await worker.getR2Bucket("STORAGE");
  const rootObject = await bucket.get(`namespaces/${namespace}/root.json`);
  if (rootObject === null) throw new Error("Missing fixture root");
  const root = decodeRoot(await rootObject.text());
  expect(root.segments).toHaveLength(1);
  const segment = root.segments[0];
  if (segment === undefined) throw new Error("Missing fixture segment");
  const object = await bucket.get(segment.key);
  if (object === null) throw new Error("Missing fixture segment bytes");
  const bytes = new Uint8Array(await object.arrayBuffer());
  using directory = Directory.canonical(
    bytes.subarray(0, segment.headerBytes),
    segment.headerBytes,
  );
  const located = Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
    directory.lookup(JSON.stringify([id]), "[]"),
  );
  const document = located.find((entry) => entry.document.id === id)?.document;
  if (document === undefined) throw new Error("Missing fixture document");
  return { bucket, root, rootEtag: rootObject.etag, segment, bytes, document };
}

async function seed(namespace: string) {
  expect(
    (
      await request(
        worker,
        namespace,
        "write",
        write([
          { id: "a", text: "lexical lexical", attributes: { source: "both" }, vector: vector(1) },
          { id: "b", text: "lexical", attributes: { source: "text" } },
          {
            id: "z",
            text: "unrelated",
            attributes: { source: "vector" },
            vector: vector(0.8, 0.6),
          },
        ]),
      )
    ).status,
  ).toBe(200);
}

test("hybrid projects RRF overlap and disjoint ID ties with the existing scores", async () => {
  await seed("late-overlap");
  const response = await request(worker, "late-overlap", "query", hybrid);
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(result.rows[0]?.score).toBe(2 / 61);
  expect(result.rows[1]?.score).toBe(1 / 62);
  expect(result.rows[0]?.attributes.source).toBe("both");
  expect(result.rows[1]?.attributes.source).toBe("text");
  expect(response.headers.get("server-timing")).toContain("hybrid_documents");
  expect(response.headers.get("server-timing")).not.toContain("vector_documents");

  expect(
    (
      await request(
        worker,
        "late-disjoint",
        "write",
        write([
          { id: "b", text: "lexical", attributes: { source: "text" } },
          { id: "a", text: "unrelated", attributes: { source: "vector" }, vector: vector(1) },
        ]),
      )
    ).status,
  ).toBe(200);
  const tied = await request(worker, "late-disjoint", "query", { ...hybrid, topK: 1 });
  expect(tied.status).toBe(200);
  const tie = Schema.decodeUnknownSync(QueryResult)(await tied.json());
  expect(tie.rows.map((row) => row.id)).toEqual(["a"]);
  expect(tie.rows[0]?.score).toBe(1 / 61);
  expect(tie.rows[0]?.text).toBe("unrelated");
  expect(tie.rows[0]?.attributes.source).toBe("vector");
});

test("hybrid does not decode a corrupt metadata frame discarded by RRF", async () => {
  const namespace = "late-discarded-corruption";
  await seed(namespace);
  const stored = await source(namespace, "z");
  const start = stored.segment.headerBytes + stored.document.data.offset;
  const checksum = start + 4;
  stored.bytes[checksum] = (stored.bytes[checksum] ?? 0) ^ 1;
  expect(() =>
    segment_query_document(stored.bytes.subarray(start, start + stored.document.data.length)),
  ).toThrow();
  expect(await stored.bucket.put(stored.segment.key, stored.bytes)).not.toBeNull();

  const response = await request(worker, namespace, "query", hybrid);
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(result.rows[0]?.score).toBe(2 / 61);
  expect(result.rows[1]?.score).toBe(1 / 62);
  const selected = await request(worker, namespace, "query", {
    kind: "vector",
    vector: vector(1),
    topK: 2,
    filters: [],
  });
  expect(selected.status).toBe(503);
});

test("hybrid rejects a selected CRC-valid payload ID that differs from its header", async () => {
  const namespace = "late-selected-identity";
  expect(
    (
      await request(
        worker,
        namespace,
        "write",
        write([{ id: "a", text: "lexical", attributes: {} }]),
      )
    ).status,
  ).toBe(200);
  const stored = await source(namespace, "a");
  const header = new TextDecoder().decode(stored.bytes.subarray(16, stored.segment.headerBytes));
  const replacement = header.replace('[["a",', '[["b",');
  expect(replacement).not.toBe(header);
  const encoded = new TextEncoder().encode(replacement);
  expect(encoded.byteLength).toBe(stored.segment.headerBytes - 16);
  stored.bytes.set(encoded, 16);
  new DataView(stored.bytes.buffer, stored.bytes.byteOffset).setUint32(12, crc32(encoded), true);
  using directory = Directory.canonical(
    stored.bytes.subarray(0, stored.segment.headerBytes),
    stored.segment.headerBytes,
  );
  const lookup = Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
    directory.lookup('["b"]', "[]"),
  );
  expect(lookup[0]?.document.id).toBe("b");
  const start = stored.segment.headerBytes + stored.document.data.offset;
  const payload = Schema.decodeSync(Schema.fromJsonString(QueryDocument))(
    segment_query_document(stored.bytes.subarray(start, start + stored.document.data.length)),
  );
  expect(payload.id).toBe("a");
  const key = `namespaces/${namespace}/segments/mismatch-${crypto.randomUUID()}.rsix`;
  expect(await stored.bucket.put(key, stored.bytes)).not.toBeNull();
  const root = {
    ...stored.root,
    segments: [
      {
        ...Struct.omit(stored.segment, ["commonLeaders", "commonProjection"]),
        key,
        minimumId: "b",
      },
    ],
    bloomPacks: stored.root.bloomPacks.map((pack) => ({
      ...pack,
      segmentKeys: pack.segmentKeys.map((entry) => {
        if (entry === stored.segment.key) return key;
        return entry;
      }),
    })),
  };
  expect(
    await stored.bucket.put(`namespaces/${namespace}/root.json`, encodeRoot(root), {
      onlyIf: { etagMatches: stored.rootEtag },
    }),
  ).not.toBeNull();
  await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
  const response = await request(worker, namespace, "query", { ...hybrid, topK: 1 });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("Hybrid document identity differs from its header");
});
