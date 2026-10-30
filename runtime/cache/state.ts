import type { CacheServerConfig } from "../../src/protocol";

export interface CacheEntry {
  readonly key: string;
  readonly generation: string;
  readonly headers: string;
  readonly checksum: string;
  readonly expiresAt: number;
  readonly length: number;
}
interface CacheSlot {
  entry: CacheEntry | undefined;
  readonly pending: boolean;
  readonly bytes: number;
}
export interface CacheWrite {
  readonly entry: CacheEntry;
  readonly slot: CacheSlot;
  readonly origin: string;
}

export function cacheState(config: typeof CacheServerConfig.Type) {
  const slots = new Map<string, CacheSlot>();
  const staging = new Map<string, { entry: CacheEntry; bytes: Uint8Array<ArrayBuffer> }>();
  const retained = { metadata: 0, staging: 0 };
  function remove(key: string) {
    const previous = slots.get(key);
    if (previous === undefined) return;
    retained.metadata -= previous.bytes;
    slots.delete(key);
  }
  function reserve(key: string, slot: CacheSlot) {
    remove(key);
    if (slot.bytes > config.maxMetadataBytes) return false;
    while (
      slots.size >= config.maxEntries ||
      retained.metadata + slot.bytes > config.maxMetadataBytes
    ) {
      const first = slots.keys().next();
      if (first.done === true) break;
      remove(first.value);
    }
    slots.set(key, slot);
    retained.metadata += slot.bytes;
    return true;
  }
  function read(key: string, now: number) {
    const slot = slots.get(key);
    if (slot === undefined) return undefined;
    const entry = slot.entry;
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      if (slot.pending) slot.entry = undefined;
      else remove(key);
      return undefined;
    }
    slots.delete(key);
    slots.set(key, slot);
    return entry;
  }
  function begin(entry: CacheEntry, bytes: Uint8Array<ArrayBuffer>): CacheWrite | undefined {
    if (
      bytes.byteLength > config.maxEntryBytes ||
      retained.staging + bytes.byteLength > config.maxStagingBytes
    )
      return undefined;
    const previous = slots.get(entry.key)?.entry;
    const charge =
      (entry.key.length +
        Math.max(entry.headers.length, previous?.headers.length ?? 0) +
        entry.checksum.length +
        entry.generation.length) *
        2 +
      512;
    const slot = { entry: previous, pending: true, bytes: charge };
    if (!reserve(entry.key, slot)) return undefined;
    const originKey = `${entry.key}/${entry.generation}`;
    staging.set(originKey, { entry, bytes });
    retained.staging += bytes.byteLength;
    return { entry, slot, origin: originKey };
  }
  function finish(write: CacheWrite, now: number) {
    if (slots.get(write.entry.key) !== write.slot || write.entry.expiresAt <= now) return false;
    const slot = { ...write.slot, entry: write.entry, pending: false };
    slots.set(write.entry.key, slot);
    return true;
  }
  function release(write: CacheWrite) {
    const payload = staging.get(write.origin);
    if (payload !== undefined) retained.staging -= payload.bytes.byteLength;
    staging.delete(write.origin);
    if (slots.get(write.entry.key) === write.slot) {
      if (write.slot.entry === undefined) remove(write.entry.key);
      else slots.set(write.entry.key, { ...write.slot, pending: false });
    }
  }
  function origin(key: string, now: number) {
    const payload = staging.get(key);
    if (payload === undefined || payload.entry.expiresAt <= now) return undefined;
    return payload;
  }
  function removeEntry(key: string, now: number) {
    const existed = read(key, now) !== undefined;
    remove(key);
    return existed;
  }
  return {
    read,
    begin,
    finish,
    release,
    origin,
    remove: removeEntry,
    usage: () => ({ entries: slots.size, ...retained }),
  };
}
