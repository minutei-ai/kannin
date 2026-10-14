import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Root } from "../src/protocol";
import { snapshotFrame, readSnapshotFrame } from "../src/snapshot";

const manifest = Schema.decodeSync(Root)({
  version: 1,
  sequence: 7,
  head: null,
  documents: 0,
  titleLength: 0,
  bodyLength: 0,
  vectorEpoch: "test",
  vectorJobs: [],
  lastReceipt: null,
  segments: [],
});
const payload = new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(Root))(manifest));

test("snapshot frames retain manifest bytes and the original observation timestamp", async () => {
  const snapshot = { observedAt: 12345, manifest };
  const first = await snapshotFrame(snapshot, payload).arrayBuffer();
  const decoded = Effect.runSync(readSnapshotFrame(first));
  expect(decoded.snapshot).toEqual(snapshot);
  expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  const next = Effect.runSync(
    readSnapshotFrame(
      await snapshotFrame({ ...snapshot, observedAt: 23456 }, decoded.payload).arrayBuffer(),
    ),
  );
  expect(next.snapshot.observedAt).toBe(23456);
  expect(next.snapshot.manifest).toEqual(manifest);
  expect(Array.from(next.payload)).toEqual(Array.from(payload));
});

test("snapshot frames reject truncation, invalid versions, lengths and mismatched sequences", async () => {
  const bytes = await snapshotFrame({ observedAt: 12345, manifest }, payload).arrayBuffer();
  for (const length of Array.from({ length: bytes.byteLength }, (_, index) => index))
    expect(Effect.runSync(Effect.exit(readSnapshotFrame(bytes.slice(0, length))))._tag).toBe(
      "Failure",
    );
  const version = bytes.slice(0);
  new Uint8Array(version)[7] = 51;
  expect(Effect.runSync(Effect.exit(readSnapshotFrame(version)))._tag).toBe("Failure");
  for (const length of [0, 4097, 4294967295]) {
    const frame = bytes.slice(0);
    new DataView(frame).setUint32(8, length, true);
    expect(Effect.runSync(Effect.exit(readSnapshotFrame(frame)))._tag).toBe("Failure");
  }
  const other = new TextEncoder().encode(
    Schema.encodeSync(Schema.fromJsonString(Root))({ ...manifest, sequence: 8 }),
  );
  expect(
    Effect.runSync(
      Effect.exit(
        readSnapshotFrame(
          await snapshotFrame({ observedAt: 12345, manifest }, other).arrayBuffer(),
        ),
      ),
    )._tag,
  ).toBe("Failure");
});
