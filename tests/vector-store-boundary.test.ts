import { expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import { qdrantVectorStore } from "../runtime/qdrant-vector-store";
import { VectorStore } from "../src/vector-store";

const fixture = Effect.fn("kannin.qdrantBoundaryFixture")(function* (overrides: {
  readonly exists?: unknown;
  readonly query?: unknown;
  readonly mutation?: unknown;
  readonly collectionCreated?: unknown;
  readonly concurrentCreation?: boolean;
}) {
  const results = {
    exists: { exists: true },
    query: { points: [] },
    mutation: { status: "completed", operation_id: 1 },
    collectionCreated: true,
    ...overrides,
  };
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/exists")) return Response.json({ result: results.exists });
          if (path.endsWith("/points/query")) return Response.json({ result: results.query });
          if (path.endsWith("/points") && request.method === "POST")
            return Response.json({ result: [] });
          if (request.method === "GET")
            return Response.json({
              result: { config: { params: { vectors: { size: 3, distance: "Cosine" } } } },
            });
          if (path === "/collections/boundary" && request.method === "PUT") {
            if (results.concurrentCreation === true)
              return Response.json(
                { status: { error: "Collection already exists" } },
                { status: 409 },
              );
            return Response.json({ result: results.collectionCreated });
          }
          return Response.json({ result: results.mutation });
        },
      }),
    ),
    (owned) => Effect.promise(() => owned.stop(true)),
  );
  const context = yield* Layer.build(
    qdrantVectorStore({
      endpoint: server.url.origin,
      collection: "boundary",
      dimensions: 3,
      apiKey: Redacted.make(""),
    }),
  );
  return yield* VectorStore.pipe(Effect.provideContext(context));
});

test("Qdrant decodes collection creation responses", async () => {
  const failure = await Effect.runPromise(
    Effect.scoped(fixture({ exists: { exists: false }, collectionCreated: "not-a-boolean" })).pipe(
      Effect.flip,
    ),
  );
  expect(failure._tag).toBe("VectorStoreFailure");
  expect(failure.operation).toBe("initialize");
  expect(failure.cause).toBeDefined();
});

test("Qdrant accepts an existing valid collection after concurrent creation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* fixture({ exists: { exists: false }, concurrentCreation: true });
        expect(
          (yield* store.query([1, 0, 0], {
            namespace: "a",
            topK: 1,
            returnMetadata: "all",
          })).matches,
        ).toEqual([]);
      }),
    ),
  );
});

test("Qdrant rejects malformed collection existence as a declared initialization failure", async () => {
  const failure = await Effect.runPromise(
    Effect.scoped(fixture({ exists: { exists: "yes" } })).pipe(Effect.flip),
  );
  expect(failure._tag).toBe("VectorStoreFailure");
  expect(failure.operation).toBe("initialize");
  expect(failure.cause).toBeDefined();
});

test("Qdrant rejects a null query envelope as a declared query failure", async () => {
  const failure = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* fixture({ query: null });
        return yield* store.query([1, 0, 0], {
          namespace: "a",
          topK: 1,
          returnMetadata: "all",
        });
      }),
    ).pipe(Effect.flip),
  );
  expect(failure._tag).toBe("VectorStoreFailure");
  expect(failure.operation).toBe("query");
  expect(failure.cause).toBeDefined();
});

for (const status of ["acknowledged", "clock_rejected"]) {
  test(`Qdrant does not treat ${status} as completed vector synchronization`, async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* fixture({ mutation: { status, operation_id: 1 } });
          yield* store.upsert([
            { id: "one", namespace: "a", values: [1, 0, 0], metadata: { revision: 1 } },
          ]);
        }),
      ).pipe(Effect.flip),
    );
    expect(failure._tag).toBe("VectorStoreFailure");
    expect(failure.operation).toBe("upsert");
    expect(failure.cause).toBeDefined();
  });
}

test("Qdrant accepts completed writes and deletes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* fixture({});
        yield* store.upsert([
          { id: "one", namespace: "a", values: [1, 0, 0], metadata: { revision: 1 } },
        ]);
        yield* store.deleteByIds(["one"]);
      }),
    ),
  );
});
