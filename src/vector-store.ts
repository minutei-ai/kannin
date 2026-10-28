import { Context } from "effect";
import type { Effect } from "effect";
import type {
  VectorStorePoint,
  VectorStoreQuery,
  VectorStoreMetadata,
  VectorStoreFailure,
} from "./protocol";

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: typeof VectorStoreMetadata.Type;
}
export class VectorStore extends Context.Service<
  VectorStore,
  {
    readonly query: (
      vector: readonly number[],
      options: typeof VectorStoreQuery.Type,
    ) => Effect.Effect<{ readonly matches: readonly VectorMatch[] }, VectorStoreFailure>;
    readonly upsert: (
      points: readonly (typeof VectorStorePoint.Type)[],
    ) => Effect.Effect<void, VectorStoreFailure>;
    readonly deleteByIds: (ids: readonly string[]) => Effect.Effect<void, VectorStoreFailure>;
  }
>()("kannin/VectorStore") {}
