import { Effect, Schema } from "effect";
import { Rejected, Root, SnapshotFrameMetadata } from "./protocol";

import type { Snapshot } from "./protocol";

const magic = new TextEncoder().encode("KANSNP02");

export function snapshotFrame(snapshot: typeof Snapshot.Type, payload: Uint8Array<ArrayBuffer>) {
  const metadata = new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(SnapshotFrameMetadata))({
      observedAt: snapshot.observedAt,
      sequence: snapshot.manifest.sequence,
    }),
  );
  const prefix = new Uint8Array(12);
  prefix.set(magic);
  new DataView(prefix.buffer).setUint32(8, metadata.byteLength, true);
  return new Blob([prefix, metadata, payload], { type: "application/octet-stream" });
}

export const readSnapshotFrame = Effect.fn("kannin.readSnapshotFrame")(function* (
  buffer: ArrayBuffer,
) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 12 || !magic.every((value, index) => bytes[index] === value))
    return yield* new Rejected({ status: 503, message: "Invalid snapshot cache frame" });
  const length = new DataView(buffer).getUint32(8, true);
  if (length === 0 || length > 4096 || 12 + length >= bytes.byteLength)
    return yield* new Rejected({ status: 503, message: "Invalid snapshot metadata length" });
  const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotFrameMetadata), {
    onExcessProperty: "error",
  })(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
  const payload = bytes.subarray(12 + length);
  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Root))(
    new TextDecoder().decode(payload),
  );
  if (metadata.sequence !== manifest.sequence)
    return yield* new Rejected({
      status: 503,
      message: "Snapshot sequence does not match its payload",
    });
  return { snapshot: { observedAt: metadata.observedAt, manifest }, payload };
});
