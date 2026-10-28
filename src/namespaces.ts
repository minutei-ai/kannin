import { Effect, Schema } from "effect";
import type { Bucket, ObjectListOptions } from "./platform";
import {
  NamespaceListCursor,
  NamespaceName,
  NamespacePrefix,
  type NamespacesInput,
  NamespacesPage,
  Rejected,
} from "./protocol";

export const namespaceCatalogPrefix = "namespace-catalog-v1/";
export const namespaceCatalogReadyKey = "namespace-catalog-v1.ready";
const readyBuckets = new WeakSet<Bucket>();

export const listNamespaces = Effect.fn("kannin.namespaces.list")(function* (
  bucket: Bucket,
  scope: string,
  input: typeof NamespacesInput.Type,
) {
  const prefix = input.prefix ?? "";
  const physicalPrefix = `${namespaceCatalogPrefix}${prefix}`;
  const options: ObjectListOptions = {
    prefix: physicalPrefix,
    limit: input.page_size ?? 100,
  };
  if (input.cursor !== undefined) {
    const cursor = yield* Schema.decodeEffect(NamespaceListCursor)(input.cursor).pipe(
      Effect.mapError(() => new Rejected({ status: 400, message: "Invalid namespace cursor" })),
    );
    if (cursor.bucket !== scope || cursor.prefix !== prefix)
      return yield* new Rejected({ status: 400, message: "Namespace cursor scope mismatch" });
    options.cursor = cursor.cursor;
  }
  if (!readyBuckets.has(bucket)) {
    const ready = yield* Effect.tryPromise(() => bucket.head(namespaceCatalogReadyKey));
    if (ready === null || ready.size !== 0)
      return yield* new Rejected({
        status: 503,
        message: "Namespace listing unavailable during migration",
      });
    readyBuckets.add(bucket);
  }
  if (prefix.length > 0 && !Schema.is(NamespacePrefix)(prefix))
    return yield* Schema.encodeEffect(NamespacesPage)({ namespaces: [] });
  const page = yield* Effect.tryPromise(() => bucket.list(options));
  if (page.truncated && page.objects.length === 0)
    return yield* new Rejected({ status: 503, message: "Namespace listing made no progress" });
  const namespaces = yield* Effect.forEach(page.objects, (object) =>
    Effect.gen(function* () {
      if (!object.key.startsWith(physicalPrefix) || object.size !== 0)
        return yield* new Rejected({ status: 503, message: "Invalid namespace catalog entry" });
      const id = yield* Schema.decodeEffect(NamespaceName)(
        object.key.slice(namespaceCatalogPrefix.length),
      );
      return { id };
    }),
  );
  if (page.truncated)
    return yield* Schema.encodeEffect(NamespacesPage)({
      namespaces,
      next_cursor: yield* Schema.encodeEffect(NamespaceListCursor)({
        version: 1,
        bucket: scope,
        prefix,
        cursor: page.cursor,
      }),
    });
  return yield* Schema.encodeEffect(NamespacesPage)({ namespaces });
});
