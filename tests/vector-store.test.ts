import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { VectorStore } from "../src/vector-store";
import { vectorStoreFixtureLive } from "./vector-store-fixture";

test("native vector search isolates namespaces and filters before top-k", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(vectorStoreFixtureLive);
        const store = yield* VectorStore.pipe(Effect.provideContext(context));
        yield* store.upsert([
          {
            id: "first",
            namespace: "a",
            values: [1, 0, 0],
            metadata: { id: "one", revision: 1, group: "no", n0: 1 },
          },
          {
            id: "second",
            namespace: "a",
            values: [0.8, 0.2, 0],
            metadata: { id: "two", revision: 2, group: "yes", n0: 3 },
          },
          {
            id: "third",
            namespace: "b",
            values: [1, 0, 0],
            metadata: { id: "other", revision: 1, group: "yes", n0: 3 },
          },
        ]);
        const result = yield* store.query([1, 0, 0], {
          namespace: "a",
          topK: 1,
          returnMetadata: "all",
          filter: { group: { $eq: "yes" }, n0: { $gte: 2 } },
        });
        expect(result.matches.map((point) => point.id)).toEqual(["second"]);
        expect(result.matches[0]?.metadata.id).toBe("two");
        yield* store.deleteByIds(["second"]);
        expect(
          (yield* store.query([1, 0, 0], {
            namespace: "a",
            topK: 1,
            returnMetadata: "all",
            filter: { group: { $in: ["yes"] } },
          })).matches,
        ).toEqual([]);
      }),
    ),
  );
}, 30000);
