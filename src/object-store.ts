import { Context } from "effect";
import type { Effect, Option, Stream } from "effect";
import type {
  ObjectMetadata,
  ObjectListInput,
  ObjectPage,
  ObjectReadOptions,
  ObjectStoreFailure,
  ObjectVersion,
  ObjectWriteCondition,
} from "./protocol";

export interface StoredObject {
  readonly metadata: typeof ObjectMetadata.Type;
  readonly body: Stream.Stream<Uint8Array, ObjectStoreFailure>;
}

export class ObjectStore extends Context.Service<
  ObjectStore,
  {
    readonly read: (
      key: string,
      options?: typeof ObjectReadOptions.Type,
    ) => Effect.Effect<Option.Option<StoredObject>, ObjectStoreFailure>;
    readonly head: (
      key: string,
    ) => Effect.Effect<Option.Option<typeof ObjectMetadata.Type>, ObjectStoreFailure>;
    readonly list: (
      input?: typeof ObjectListInput.Type,
    ) => Effect.Effect<typeof ObjectPage.Type, ObjectStoreFailure>;
    readonly remove: (key: string) => Effect.Effect<void, ObjectStoreFailure>;
    readonly write: (
      key: string,
      bytes: Uint8Array,
      condition?: typeof ObjectWriteCondition.Type,
    ) => Effect.Effect<Option.Option<typeof ObjectVersion.Type>, ObjectStoreFailure>;
  }
>()("kannin/ObjectStore") {}
