import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Directory,
  Segment,
  initSync,
  segment_document,
  segment_migrate,
  segment_query_document,
} from "../dist/wasm/raio_engine";
import {
  CanonicalDocument,
  CanonicalId,
  CanonicalQueryDocument,
  LocatedDocument,
} from "../src/protocol";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const uuid = "00112233-4455-6677-8899-aabbccddeeff";
const ids: ReadonlyArray<typeof CanonicalId.Type> = [
  { kind: "uint", value: "10" },
  { kind: "uint", value: "2" },
  { kind: "uint", value: "18446744073709551615" },
  { kind: "uuid", value: uuid },
  "1",
  { kind: "uint", value: "1" },
  uuid,
];
const ordered: ReadonlyArray<typeof CanonicalId.Type> = [
  uuid,
  "1",
  { kind: "uint", value: "1" },
  { kind: "uint", value: "2" },
  { kind: "uint", value: "10" },
  { kind: "uint", value: "18446744073709551615" },
  { kind: "uuid", value: uuid },
];
const encodeDocuments = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CanonicalDocument)));
const decodeDocument = Schema.decodeSync(Schema.fromJsonString(CanonicalDocument), {
  onExcessProperty: "error",
});
const decodeQuery = Schema.decodeSync(Schema.fromJsonString(CanonicalQueryDocument), {
  onExcessProperty: "error",
});
const decodeLocations = Schema.decodeSync(Schema.fromJsonString(Schema.Array(LocatedDocument)), {
  onExcessProperty: "error",
});
const documents = ids.map((id) => ({
  id,
  revision: 1,
  roles: { title: "", text: "shared" },
  attributes: {},
}));

test("typed IDs keep exact domains and numeric order through canonical WASM metadata and rebuild", () => {
  using segment = new Segment(encodeDocuments(documents));
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("RAIOSEG5");
  using directory = new Directory(bytes);
  const locations = decodeLocations(directory.rows(JSON.stringify(ordered.map((_id, row) => row))));
  expect(locations.map((location) => location.document.id)).toEqual([...ordered]);
  const restored = locations.map((location) => {
    const data = location.document.data;
    const frame = bytes.subarray(base + data.offset, base + data.offset + data.length);
    const full = decodeDocument(segment_document(frame, new Uint8Array()));
    const query = decodeQuery(segment_query_document(frame));
    expect(query.id).toEqual(full.id);
    expect(full.id).toEqual(location.document.id);
    return full;
  });
  using rebuilt = new Segment(encodeDocuments(restored));
  expect(rebuilt.bytes()).toEqual(bytes);
  expect(segment_migrate(bytes)).toEqual(bytes);
});

test("typed directory frames and lookup never alias string IDs or ignore tombstones", () => {
  using segment = new Segment(encodeDocuments(documents));
  const bytes = segment.bytes();
  const base = 16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  using original = new Directory(bytes);
  const frame = original.compressed_frame(base);
  expect(new TextDecoder().decode(frame.subarray(0, 8))).toBe("RAIODIR7");
  using directory = Directory.compressed(frame, base, 16 * 1024 * 1024);
  const lookup = (
    requested: ReadonlyArray<typeof CanonicalId.Type>,
    dead: readonly number[] = [],
  ) => decodeLocations(directory.lookup(JSON.stringify(requested), JSON.stringify(dead)));
  const selected = [
    "1",
    { kind: "uint", value: "1" },
    uuid,
    { kind: "uuid", value: uuid },
  ] as const;
  expect(lookup(selected).map((location) => location.document.id)).toEqual([...selected]);
  expect(lookup(selected, [2]).map((location) => location.document.id)).toEqual([
    "1",
    uuid,
    { kind: "uuid", value: uuid },
  ]);
  expect(lookup(["10"])).toEqual([]);
  expect(lookup([{ kind: "uint", value: "0" }])).toEqual([]);
});
