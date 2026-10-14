import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { cacheUsage, clearImmutableCache, range } from "../src/storage";
import { RangeProbeInput, RangeProbeResult } from "./range-contract";

export { Segments, SearchNamespace } from "../src/worker";

export default {
  async fetch(request: Request) {
    if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
      return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = Schema.decodeUnknownSync(RangeProbeInput)(await request.json());
    clearImmutableCache(input.key.slice(0, input.key.indexOf("/segments/")));
    const before = cacheUsage();
    const results = await Promise.allSettled(
      Array.from({ length: input.count }, () => range(input.key, input.offset, input.length)),
    );
    const after = cacheUsage();
    const successes = results.filter((result) => result.status === "fulfilled");
    return new Response(
      Schema.encodeSync(Schema.fromJsonString(RangeProbeResult))({
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
