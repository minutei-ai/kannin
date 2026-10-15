import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { cacheUsage, clearImmutableCache, range, addFrequencyPosting } from "../src/storage";
import { Segment, Directory } from "../dist/wasm/raio_engine";
import { SegmentHeader, RankingInput } from "../src/protocol";
import { RangeProbeInput, RangeProbeResult } from "./range-contract";

export { Segments, SearchNamespace } from "../src/worker";

export default {
  async fetch(request: Request) {
    if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
      return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = Schema.decodeUnknownSync(RangeProbeInput)(await request.json());
    clearImmutableCache(input.key.slice(0, input.key.indexOf("/segments/")));
    if (input.preloadFrequency === true) {
      using segment = new Segment('[{"id":"a","text":"alpha","attributes":{}}]');
      const bytes = segment.bytes();
      const header = Schema.decodeSync(Schema.fromJsonString(SegmentHeader))(segment.header_json());
      using directory = new Directory(bytes);
      using ranker = directory.ranker(
        Schema.encodeSync(Schema.fromJsonString(RankingInput))({
          text: "alpha",
          mode: "any",
          top_k: 1,
          dead: [],
          filters: [],
          statistics: { documents: 1, title_length: 0, body_length: 1, frequencies: { alpha: 1 } },
        }),
      );
      const block = header.terms.alpha?.blocks[0];
      if (block === undefined) throw new Error("Missing fixture posting");
      const start = 16 + new DataView(bytes.buffer).getUint32(8, true) + block.data.offset;
      addFrequencyPosting(
        ranker,
        input.key,
        "alpha",
        start,
        bytes.subarray(start, start + block.data.length),
      );
    }
    const before = cacheUsage();
    const results = await Promise.allSettled(
      Array.from({ length: input.count }, () => range(input.key, input.offset, input.length)),
    );
    const after = cacheUsage();
    const successes = results.filter((result) => result.status === "fulfilled");
    return new Response(
      Schema.encodeSync(Schema.fromJsonString(RangeProbeResult))({
        postingBefore: before.postingCacheBytes,
        postingAfter: after.postingCacheBytes,
        rangeAfter: after.rangeCacheBytes,
        reads: after.rangeReads - before.rangeReads,
        bytes: after.rangeBytes - before.rangeBytes,
        successes: successes.length,
        failures: results.length - successes.length,
        distinctBodies: new Set(successes.map((result) => result.value)).size,
        lengths: successes.map((result) => result.value.byteLength),
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
