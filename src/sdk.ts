import { Context, Effect, Schema } from "effect";
import type { Binding } from "./rpc";
import {
  type Collection,
  CollectionResult,
  CompactResult,
  Metadata,
  type NamespacesInput,
  NamespacesPage,
  type Query,
  QueryResult,
  RebuildResult,
  RootMigrationResult,
  RpcCommand,
  RpcReply,
  type VectorRebuild,
  VectorRebuildResult,
  VectorSyncResult,
  type Write,
  WriteResult,
} from "./protocol";

export class Kannin extends Context.Service<Kannin, Binding>()("kannin/Binding") {}

const decodeReply = Schema.decodeEffect(
  RpcReply.mapMembers(
    ([success, failure]) =>
      [success.mapFields((fields) => ({ ...fields, value: Schema.Unknown })), failure] as const,
  ),
);

const invoke = Effect.fn("kannin.invoke")(function* <S extends Schema.ConstraintDecoder<unknown>>(
  command: typeof RpcCommand.Type,
  result: S,
) {
  const binding = yield* Kannin;
  const encoded = yield* Schema.encodeEffect(RpcCommand)(command);
  const received = yield* Effect.tryPromise(() => binding.execute(encoded));
  const reply = yield* decodeReply(received);
  if (reply._tag === "Failure") return yield* reply.error;
  return yield* Schema.decodeEffect(result)(reply.value);
});

export const namespaces = Effect.fn("kannin.namespaces")(function* (
  input: typeof NamespacesInput.Type = {},
) {
  return yield* invoke({ operation: "namespaces", input }, NamespacesPage);
});

export const query = Effect.fn("kannin.query")(function* (
  namespace: string,
  input: typeof Query.Type,
) {
  return yield* invoke({ namespace, operation: "query", input }, QueryResult);
});
export const write = Effect.fn("kannin.write")(function* (
  namespace: string,
  input: typeof Write.Type,
) {
  return yield* invoke({ namespace, operation: "write", input }, WriteResult);
});
export const metadata = Effect.fn("kannin.metadata")(function* (namespace: string) {
  return yield* invoke({ namespace, operation: "metadata" }, Metadata);
});
export const compact = Effect.fn("kannin.compact")(function* (namespace: string) {
  return yield* invoke({ namespace, operation: "compact" }, CompactResult);
});
export const collect = Effect.fn("kannin.collect")(function* (
  namespace: string,
  input: typeof Collection.Type,
) {
  return yield* invoke({ namespace, operation: "collect", input }, CollectionResult);
});
export const rebuild = Effect.fn("kannin.rebuild")(function* (namespace: string) {
  return yield* invoke({ namespace, operation: "rebuild" }, RebuildResult);
});

export const migrateRoot = Effect.fn("kannin.migrateRoot")(function* (namespace: string) {
  return yield* invoke({ namespace, operation: "migrate-root" }, RootMigrationResult);
});
export const synchronizeVectors = Effect.fn("kannin.synchronizeVectors")(function* (
  namespace: string,
) {
  return yield* invoke({ namespace, operation: "vector-sync" }, VectorSyncResult);
});
export const rebuildVectors = Effect.fn("kannin.rebuildVectors")(function* (
  namespace: string,
  input: typeof VectorRebuild.Type,
) {
  return yield* invoke({ namespace, operation: "vector-rebuild", input }, VectorRebuildResult);
});
