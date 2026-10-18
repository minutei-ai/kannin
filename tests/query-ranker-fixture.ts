import { Effect, Schema, Semaphore } from "effect";
import { Directory, PreparedQuery } from "../dist/wasm/raio_engine";
import { SearchNamespace as Namespace } from "../src/worker";
import { CacheMetrics, RankingInput } from "../src/protocol";
import { cacheUsage, withRanker } from "../src/storage";
import { QueryRankerProbe } from "./query-ranker-contract";

export { default, Segments, Terms, KanninRpc } from "../src/worker";

Object.defineProperty(Directory.prototype, "heap_bytes", {
  value: () => 12 * 1024 * 1024,
});

export class SearchNamespace extends Namespace {
  override fetch(request: Request) {
    const encoded = request.headers.get("x-kannin-ranker-probe");
    if (encoded === null) return super.fetch(request);
    return Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* Schema.decodeEffect(Schema.fromJsonString(QueryRankerProbe))(encoded);
        const query = yield* Schema.encodeEffect(Schema.fromJsonString(RankingInput))(input.query);
        const dead = yield* Schema.encodeEffect(Schema.fromJsonString(RankingInput.fields.dead))(
          input.query.dead,
        );
        const permits = Semaphore.makeUnsafe(4);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new PreparedQuery(query)),
          (prepared) =>
            Effect.forEach(
              Array.from({ length: input.count }, (_, index) => index),
              () =>
                withRanker(
                  input.source.key,
                  input.source.headerBytes,
                  prepared,
                  dead,
                  () => Effect.void,
                  permits,
                ),
            ),
          (prepared) => Effect.sync(() => prepared.free()),
        );
        const response = yield* Schema.encodeEffect(Schema.fromJsonString(CacheMetrics))(
          cacheUsage(),
        );
        return new Response(response);
      }),
    );
  }
}
