import { Effect, Schema } from "effect";
import { Segments as CachedSegments } from "../src/worker";
import { range, cacheUsage } from "../src/storage";
import { RangeProbeInput } from "./range-contract";
export { SearchNamespace } from "../src/worker";

export class Segments extends CachedSegments {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.searchParams.get("key")?.endsWith("/body.rsix") === true) {
      const response = await super.fetch(request);
      const body = response.body;
      if (body === null) return response;
      return new Response(
        body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            async transform(chunk, controller) {
              await Effect.runPromise(Effect.sleep("800 millis"));
              controller.enqueue(chunk);
            },
          }),
        ),
        response,
      );
    }
    await Effect.runPromise(Effect.sleep("800 millis"));
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request) {
    const input = Schema.decodeUnknownSync(RangeProbeInput)(await request.json());
    const before = cacheUsage();
    return Effect.runPromise(
      Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: input.count }, () => range(input.key, input.offset, input.length)),
        ),
      ).pipe(
        Effect.map((bodies) => {
          const first = bodies[0];
          if (first === undefined) return new Response(null, { status: 500 });
          const after = cacheUsage();
          return new Response(new Uint8Array(first), {
            headers: {
              "x-fixture-timeouts": String(after.rangeCacheTimeouts - before.rangeCacheTimeouts),
              "x-fixture-fallbacks": String(
                after.rangeR2FallbackReads - before.rangeR2FallbackReads,
              ),
              "x-fixture-fallback-bytes": String(
                after.rangeR2FallbackBytes - before.rangeR2FallbackBytes,
              ),
              "x-fixture-reads": String(after.rangeReads - before.rangeReads),
              "x-fixture-bodies": String(new Set(bodies).size),
            },
          });
        }),
        Effect.orElseSucceed(() => new Response(null, { status: 503 })),
      ),
    );
  },
};
