import { decodeNativeDocumentFixture } from "./segment-fixture";
import { Option, Schema, Struct } from "effect";
import { crc32, deflateSync } from "node:zlib";
import type { Miniflare } from "miniflare";
import { Directory, initSync, segment_document, segment_header } from "../dist/wasm/raio_engine";
import {
  type DataRange,
  Id,
  LegacyInlineRoot,
  LegacyPackedRoot,
  LegacyRoot,
  LegacyStoredRoot,
  LegacyStoredRootV3,
  LegacyStoredRootV4,
  LegacyStoredRootV5,
  LocatedDocument,
  RootMigrationInput,
  SegmentHeader,
  StoredRoot,
  StoredDocument,
  VectorRebuildSnapshot,
  nativeSchemaFromColumns,
  type Root,
} from "../src/protocol";
import { encodeRoot } from "../src/manifest";

type Bucket = Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
type Version = 1 | 2 | 3 | 4 | 5;

function legacyNativeSchema(root: typeof Root.Type) {
  if (root.schema === undefined) return undefined;
  return nativeSchemaFromColumns(root.schema);
}

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const encodeNativeDocument = Schema.encodeSync(Schema.fromJsonString(StoredDocument));

const LegacyHeader = SegmentHeader.mapFields((fields) => ({
  ...Struct.omit(fields, ["metadata_end", "vector_end", "vector_ranges"]),
  version: Schema.Literal(1),
  documents: Schema.NonEmptyArray(
    fields.documents.value.mapFields((document) => ({ ...document, id: Id })),
  ),
}));

async function physicalLegacyRoot(bucket: Bucket, root: typeof Root.Type) {
  const segments: Array<(typeof LegacyPackedRoot.Type.segments)[number]> = [];
  for (const segment of root.segments) {
    const object = await bucket.get(segment.key);
    if (object === null) throw new Error("Missing native segment fixture");
    const bytes = new Uint8Array(await object.arrayBuffer());
    using directory = new Directory(bytes.subarray(0, segment.headerBytes));
    const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(
      segment_header(bytes.subarray(0, segment.headerBytes)),
    );
    const rows = Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
      directory.rows(JSON.stringify(header.documents.map((_document, row) => row))),
    );
    const frames = rows.map((row) => {
      const data = row.document.data;
      const metadata = bytes.subarray(
        segment.headerBytes + data.offset,
        segment.headerBytes + data.offset + data.length,
      );
      const vector = (() => {
        if (row.vectorData === null) return new Uint8Array();
        return bytes.subarray(
          segment.headerBytes + row.vectorData.offset,
          segment.headerBytes + row.vectorData.offset + row.vectorData.length,
        );
      })();
      const json = new TextEncoder().encode(
        encodeNativeDocument(decodeNativeDocumentFixture(segment_document(metadata, vector))),
      );
      const compressed = deflateSync(json, { level: 3 });
      const frame = new Uint8Array(8 + compressed.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, json.byteLength, true);
      view.setUint32(4, crc32(json), true);
      frame.set(compressed, 8);
      return frame;
    });
    const ranges: (typeof DataRange.Type)[] = [];
    const length = { value: 0 };
    for (const frame of frames) {
      ranges.push({ offset: length.value, length: frame.byteLength });
      length.value += frame.byteLength;
    }
    const documents = header.documents.map((document, row) => {
      const data = ranges[row];
      if (data === undefined) throw new Error("Missing legacy document range");
      return { ...document, data };
    });
    const terms = Object.fromEntries(
      Object.entries(header.terms).map(([term, metadata]) => [
        term,
        {
          ...metadata,
          blocks: metadata.blocks.map((block) => ({
            ...block,
            data: {
              offset: length.value + block.data.offset - header.vector_end,
              length: block.data.length,
            },
          })),
        },
      ]),
    );
    const legacyHeader = Schema.decodeUnknownSync(LegacyHeader)({
      ...header,
      version: 1,
      documents,
      terms,
    });
    const encoded = new TextEncoder().encode(
      Schema.encodeSync(Schema.fromJsonString(LegacyHeader))(legacyHeader),
    );
    const tail = bytes.subarray(segment.headerBytes + header.vector_end);
    const legacy = new Uint8Array(16 + encoded.byteLength + length.value + tail.byteLength);
    legacy.set(new TextEncoder().encode("RAIOSEG1"));
    const framing = new DataView(legacy.buffer);
    framing.setUint32(8, encoded.byteLength, true);
    framing.setUint32(12, crc32(encoded), true);
    legacy.set(encoded, 16);
    for (const [row, frame] of frames.entries()) {
      const data = ranges[row];
      if (data === undefined) throw new Error("Missing legacy document range");
      legacy.set(frame, 16 + encoded.byteLength + data.offset);
    }
    legacy.set(tail, 16 + encoded.byteLength + length.value);
    const digest = new Bun.CryptoHasher("sha256").update(legacy).digest("hex");
    const key = `${segment.key.split("/segments/")[0]}/segments/legacy-${digest}.rsix`;
    const previous = await bucket.get(key);
    if (previous === null) await bucket.put(key, legacy);
    else if (
      previous.size !== legacy.byteLength ||
      new Bun.CryptoHasher("sha256")
        .update(new Uint8Array(await previous.arrayBuffer()))
        .digest("hex") !== digest
    )
      throw new Error("Legacy fixture digest collision");
    const commonLeaders = segment.commonLeaders?.map((leader) => ({
      ...leader,
      documents: leader.documents.map((document) => {
        const data = ranges[document.row];
        if (data === undefined) throw new Error("Missing legacy leader range");
        return { ...document, id: Schema.decodeUnknownSync(Id)(document.id), data };
      }),
    }));
    segments.push(
      Schema.decodeUnknownSync(LegacyPackedRoot.fields.segments.value)({
        ...segment,
        key,
        headerBytes: 16 + encoded.byteLength,
        bytes: legacy.byteLength,
        commonLeaders,
      }),
    );
  }
  const keys = new Map(root.segments.map((segment, row) => [segment.key, segments[row]?.key]));
  const schema = legacyNativeSchema(root);
  const fields = Struct.omit(root, ["schema", "idType"]);
  return Schema.decodeSync(LegacyPackedRoot)({
    ...fields,
    ...Option.match(Option.fromUndefinedOr(schema), {
      onNone: () => ({}),
      onSome: (native) => ({ schema: native }),
    }),
    segments,
    bloomPacks: root.bloomPacks.map((pack) => ({
      ...pack,
      segmentKeys: pack.segmentKeys.map((key) => keys.get(key) ?? key),
    })),
  });
}

async function inlineRoot(bucket: Bucket, root: typeof LegacyPackedRoot.Type) {
  const segments = await Promise.all(
    root.segments.map(async (segment) => {
      const pack = root.bloomPacks[segment.bloom.packIndex];
      if (pack === undefined) throw new Error("Missing Bloom pack");
      const documentStart = pack.document.offset + (pack.document.offsets[segment.bloom.row] ?? -1);
      const documentEnd =
        pack.document.offset + (pack.document.offsets[segment.bloom.row + 1] ?? -1);
      const termStart = pack.term.offset + (pack.term.offsets[segment.bloom.row] ?? -1);
      const termEnd = pack.term.offset + (pack.term.offsets[segment.bloom.row + 1] ?? -1);
      if (
        documentStart < pack.document.offset ||
        documentEnd <= documentStart ||
        termStart < pack.term.offset ||
        termEnd <= termStart
      )
        throw new Error("Invalid Bloom pack row");
      const [documentObject, termObject] = await Promise.all([
        bucket.get(pack.key, {
          range: { offset: documentStart, length: documentEnd - documentStart },
        }),
        bucket.get(pack.key, { range: { offset: termStart, length: termEnd - termStart } }),
      ]);
      if (documentObject === null || termObject === null)
        throw new Error("Missing Bloom pack bytes");
      const documentBytes = new Uint8Array(await documentObject.arrayBuffer());
      const termBytes = new Uint8Array(await termObject.arrayBuffer());
      if (
        documentBytes.byteLength !== documentEnd - documentStart ||
        termBytes.byteLength !== termEnd - termStart
      )
        throw new Error("Truncated Bloom pack range");
      return {
        ...segment,
        documentBloom: documentBytes.toBase64(),
        termBloom: termBytes.toBase64(),
      };
    }),
  );
  return Schema.decodeSync(LegacyInlineRoot)({ ...root, segments });
}

async function legacyRootValue(bucket: Bucket, root: typeof Root.Type, version: Version) {
  if (root.idType !== undefined && root.idType !== "string")
    throw new Error("Legacy fixtures require native string IDs");
  const stored = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(encodeRoot(root));
  const schema = legacyNativeSchema(root);
  const storedFields = Struct.omit(stored, ["schema", "idType"]);
  const legacyStored = {
    ...storedFields,
    ...Option.match(Option.fromUndefinedOr(schema), {
      onNone: () => ({}),
      onSome: (native) => ({ schema: native }),
    }),
  };
  if (version === 5)
    return Schema.decodeUnknownSync(LegacyStoredRootV5)({ ...legacyStored, version: 5 });
  const physical = await physicalLegacyRoot(bucket, root);
  if (version === 4)
    return Schema.decodeUnknownSync(LegacyStoredRootV4)({
      ...legacyStored,
      version: 4,
      bloomPacks: physical.bloomPacks,
      segments: stored.segments.map((segment, row) => {
        const source = physical.segments[row];
        if (source === undefined) throw new Error("Missing physical legacy descriptor");
        return Object.assign({}, segment, source);
      }),
    });
  const inline = await inlineRoot(bucket, physical);
  if (version === 1) return Schema.decodeSync(LegacyRoot)(inline);
  const pooled = Schema.decodeUnknownSync(LegacyStoredRootV3)({
    ...legacyStored,
    version: 3,
    segments: stored.segments.map((segment, row) => {
      const source = inline.segments[row];
      if (source === undefined) throw new Error("Missing inline legacy descriptor");
      return Object.assign({}, segment, source);
    }),
  });
  if (version === 2) return Schema.decodeSync(LegacyStoredRoot)({ ...pooled, version: 2 });
  return pooled;
}

export async function legacyRootText(bucket: Bucket, root: typeof Root.Type, version: Version) {
  return Schema.encodeSync(Schema.fromJsonString(RootMigrationInput))(
    await legacyRootValue(bucket, root, version),
  );
}

export async function legacySnapshotText(
  bucket: Bucket,
  snapshot: typeof VectorRebuildSnapshot.Type,
  version: Version,
) {
  return Schema.encodeSync(
    Schema.fromJsonString(
      VectorRebuildSnapshot.mapFields((fields) => ({ ...fields, root: RootMigrationInput })),
    ),
  )({
    root: await legacyRootValue(bucket, snapshot.root, version),
    fields: snapshot.fields,
  });
}

export function migrationRootFacts(root: typeof Root.Type) {
  const { bloomPacks: _bloomPacks, segments, ...fields } = root;
  return {
    ...fields,
    idType: root.idType ?? "string",
    segments: segments.map(
      ({
        key: _key,
        headerBytes: _headerBytes,
        bytes: _bytes,
        metadataEnd: _metadataEnd,
        bloom: _bloom,
        commonLeaders,
        ...segment
      }) =>
        Object.assign({}, segment, {
          commonLeaders: commonLeaders?.map((leader) =>
            Object.assign({}, leader, {
              documents: leader.documents.map(({ data: _data, ...document }) => document),
            }),
          ),
        }),
    ),
  };
}
