import { Effect, Schema } from "effect";
import type { Miniflare } from "miniflare";
import { common_directory_compress, initSync } from "../dist/wasm/raio_engine";
import { decodeRoot } from "../src/manifest";
import { TermProjectionRange } from "../src/protocol";
import { request } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

export async function useHeaderOnlyCommonFrames(worker: Miniflare, namespace: string) {
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing manifest for header-only common fixture");
  const root = decodeRoot(await object.text());
  for (const segment of root.segments) {
    if (segment.commonTerms === undefined || Object.keys(segment.commonTerms).length === 0)
      continue;
    const key = `cache/directory-common-v5/${segment.key}/${segment.headerBytes}`;
    for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
      if ((await bucket.head(key)) !== null) break;
      if (attempt === 99) throw new Error("Writer common frame did not settle");
      await Effect.runPromise(Effect.sleep("10 millis"));
    }
    const canonical = await bucket.get(segment.key, {
      range: { offset: 0, length: segment.headerBytes },
    });
    if (canonical === null) throw new Error("Missing canonical segment for common fixture");
    const header = new Uint8Array(await canonical.arrayBuffer());
    if (header.byteLength !== segment.headerBytes)
      throw new Error("Truncated canonical header for common fixture");
    await bucket.put(key, new Uint8Array(common_directory_compress(header)), {
      customMetadata: {
        source: Schema.encodeSync(Schema.fromJsonString(TermProjectionRange))({
          key: segment.key,
          headerBytes: segment.headerBytes,
        }),
      },
    });
  }
  const rebuilt = await request(worker, namespace, "rebuild", {});
  if (rebuilt.status !== 200) throw new Error("Failed to clear decoded common fixture memory");
}
