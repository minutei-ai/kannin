import { QdrantClient } from "@qdrant/js-client-rest";
import type { Schemas } from "@qdrant/js-client-rest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { VectorStore } from "../src/vector-store";
import {
  VectorStorePoint,
  VectorStoreQuery,
  VectorStoreFailure,
  QdrantStoreConfig,
  QdrantPoint,
  QdrantCollectionExists,
  QdrantQueryResult,
  QdrantMutationResult,
  QdrantCollectionVectorConfig,
} from "../src/protocol";
import { sha256 } from "../src/hash";

const pointId = Effect.fn("kannin.qdrant.pointId")(function* (id: string) {
  const digest = yield* Effect.tryPromise(() => sha256(id));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
});
function exactMatch(key: string, value: string | number): Schemas["Condition"] {
  if (typeof value === "number") return { key, range: { gte: value, lte: value } };
  return { key, match: { value } };
}
function filters(input: typeof VectorStoreQuery.Type): Schemas["Filter"] {
  const must: Schemas["Condition"][] = [{ key: "namespace", match: { value: input.namespace } }];
  for (const [key, predicate] of Object.entries(input.filter ?? {})) {
    const field = `metadata.${key}`;
    if (predicate.$eq !== undefined) must.push(exactMatch(field, predicate.$eq));
    if (predicate.$in !== undefined)
      must.push({ should: predicate.$in.map((value) => exactMatch(field, value)) });
    const range = {
      ...(predicate.$gt !== undefined && { gt: predicate.$gt }),
      ...(predicate.$gte !== undefined && { gte: predicate.$gte }),
      ...(predicate.$lt !== undefined && { lt: predicate.$lt }),
      ...(predicate.$lte !== undefined && { lte: predicate.$lte }),
    };
    if (Object.keys(range).length > 0) must.push({ key: field, range });
  }
  return { must };
}

export const qdrantVectorStore = (config: typeof QdrantStoreConfig.Type) =>
  Layer.effect(
    VectorStore,
    Effect.gen(function* () {
      const checked = yield* Schema.decodeEffect(QdrantStoreConfig)(config);
      const client = new QdrantClient({
        url: checked.endpoint,
        ...(Redacted.value(checked.apiKey).length > 0 && {
          apiKey: Redacted.value(checked.apiKey),
        }),
        timeout: 15000,
        checkCompatibility: false,
      });
      const exists = yield* Effect.tryPromise(() =>
        client.collectionExists(checked.collection),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QdrantCollectionExists)));
      if (!exists.exists)
        yield* Effect.tryPromise(() =>
          client.createCollection(checked.collection, {
            vectors: { size: checked.dimensions, distance: "Cosine" },
          }),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
          Effect.catchIf(
            Schema.is(Schema.Struct({ cause: Schema.Struct({ status: Schema.Literal(409) }) })),
            () => Effect.succeed(false),
          ),
        );
      const info = yield* Effect.tryPromise(() => client.getCollection(checked.collection)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(QdrantCollectionVectorConfig)),
      );
      if (info.config.params.vectors.size !== checked.dimensions)
        return yield* new VectorStoreFailure({
          operation: "initialize",
          cause: new Error("Vector dimensions differ from the configured collection"),
        });
      const vector = Schema.Array(Schema.Finite).check(
        Schema.isBetweenLength(checked.dimensions, checked.dimensions),
      );
      const assertIdentity = Effect.fn("kannin.qdrant.assertIdentity")(function* (
        ids: readonly string[],
      ) {
        const mapped = yield* Effect.forEach(ids, pointId, { concurrency: 8 });
        if (new Set(mapped).size !== new Set(ids).size)
          return yield* new VectorStoreFailure({
            operation: "upsert",
            cause: new Error("Vector identity collision"),
          });
        if (mapped.length === 0) return mapped;
        const existing = yield* Effect.tryPromise(() =>
          client.retrieve(checked.collection, {
            ids: mapped,
            with_payload: true,
            with_vector: false,
            consistency: "all",
          }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(QdrantPoint))));
        const expected = new Map(mapped.map((id, index) => [id, ids[index]]));
        for (const point of existing)
          if (point.payload.vectorId !== expected.get(point.id))
            return yield* new VectorStoreFailure({
              operation: "upsert",
              cause: new Error("Vector identity collision"),
            });
        return mapped;
      });
      return VectorStore.of({
        query: Effect.fn("kannin.qdrant.query")(
          function* (values, options) {
            const input = yield* Schema.decodeEffect(VectorStoreQuery, {
              onExcessProperty: "error",
            })(options);
            const query = yield* Schema.decodeEffect(vector)(values);
            if (Object.values(input.filter ?? {}).some((predicate) => predicate.$in?.length === 0))
              return { matches: [] };
            const result = yield* Effect.tryPromise(() =>
              client.query(checked.collection, {
                query: [...query],
                filter: filters(input),
                limit: input.topK,
                with_payload: true,
                with_vector: false,
                consistency: "all",
              }),
            ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QdrantQueryResult)));
            const matches = [];
            for (const point of result.points) {
              if (
                point.payload.namespace !== input.namespace ||
                point.id !== (yield* pointId(point.payload.vectorId))
              )
                return yield* new VectorStoreFailure({
                  operation: "query",
                  cause: new Error("Vector backend returned an invalid identity"),
                });
              matches.push({
                id: point.payload.vectorId,
                score: point.score,
                metadata: point.payload.metadata,
              });
            }
            return { matches };
          },
          (effect) =>
            effect.pipe(
              Effect.mapError((cause) => new VectorStoreFailure({ operation: "query", cause })),
            ),
        ),
        upsert: Effect.fn("kannin.qdrant.upsert")(
          function* (points) {
            const input = yield* Schema.decodeEffect(Schema.Array(VectorStorePoint), {
              onExcessProperty: "error",
            })(points);
            const ids = yield* assertIdentity(input.map((point) => point.id));
            const rows = yield* Effect.forEach(input, (point, index) =>
              Schema.decodeEffect(vector)(point.values).pipe(
                Effect.map((values) => ({
                  id: ids[index] ?? "",
                  vector: [...values],
                  payload: {
                    vectorId: point.id,
                    namespace: point.namespace,
                    metadata: point.metadata,
                  },
                })),
              ),
            );
            if (rows.length > 0)
              yield* Effect.tryPromise(() =>
                client.upsert(checked.collection, { points: rows, wait: true, ordering: "strong" }),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QdrantMutationResult)));
          },
          (effect) =>
            effect.pipe(
              Effect.mapError((cause) => new VectorStoreFailure({ operation: "upsert", cause })),
            ),
        ),
        deleteByIds: Effect.fn("kannin.qdrant.delete")(
          function* (ids) {
            const input = yield* Schema.decodeEffect(Schema.Array(VectorStorePoint.fields.id))(ids);
            const mapped = yield* assertIdentity(input);
            if (mapped.length > 0)
              yield* Effect.tryPromise(() =>
                client.delete(checked.collection, {
                  points: mapped,
                  wait: true,
                  ordering: "strong",
                }),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QdrantMutationResult)));
          },
          (effect) =>
            effect.pipe(
              Effect.mapError((cause) => new VectorStoreFailure({ operation: "delete", cause })),
            ),
        ),
      });
    }).pipe(Effect.mapError((cause) => new VectorStoreFailure({ operation: "initialize", cause }))),
  );
