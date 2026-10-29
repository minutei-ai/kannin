import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import { ObjectStore } from "../src/object-store";
import {
  ObjectKey,
  ObjectMetadata,
  ObjectUserMetadataJson,
  ObjectListInput,
  ObjectPage,
  ObjectReadOptions,
  ObjectContentRange,
  ObjectStoreFailure,
  ObjectVersion,
  ObjectWriteCondition,
  S3StoreConfig,
} from "../src/protocol";

function physicalKey(key: string) {
  return key.replaceAll("%", "%25").replaceAll(".", "%2E");
}
function logicalKey(key: string) {
  return key.replaceAll("%2E", ".").replaceAll("%25", "%");
}

const preconditionFailed = Schema.is(
  Schema.Struct({
    $metadata: Schema.Struct({ httpStatusCode: Schema.Literal(412) }),
  }),
);
const missingHead = Schema.is(
  Schema.Struct({ $metadata: Schema.Struct({ httpStatusCode: Schema.Literal(404) }) }),
);
const missingKey = Schema.is(
  Schema.Struct({
    name: Schema.Literal("NoSuchKey"),
    $metadata: Schema.Struct({ httpStatusCode: Schema.Literal(404) }),
  }),
);

const decodeUserMetadata = Effect.fn("kannin.s3.decodeMetadata")(function* (
  headers: Record<string, string> | undefined,
) {
  const encoded = headers?.["kannin-metadata"];
  if (encoded === undefined) return {};
  const json = yield* Schema.decodeEffect(Schema.StringFromBase64)(encoded);
  return yield* Schema.decodeEffect(ObjectUserMetadataJson)(json);
});

export const s3ObjectStore = (config: typeof S3StoreConfig.Type) =>
  Layer.effect(
    ObjectStore,
    Effect.gen(function* () {
      const checked = yield* Schema.decodeEffect(S3StoreConfig)(config);
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new S3Client({
              region: checked.region,
              endpoint: checked.endpoint,
              forcePathStyle: checked.urlStyle !== "virtual",
              maxAttempts: 1,
              credentials: {
                accessKeyId: Redacted.value(checked.accessKeyId),
                secretAccessKey: Redacted.value(checked.secretAccessKey),
              },
            }),
        ),
        (resource) => Effect.sync(() => resource.destroy()),
      );
      const head = Effect.fn("kannin.s3.head")(
        function* (key: string) {
          yield* Schema.decodeEffect(ObjectKey)(key);
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              client.send(
                new HeadObjectCommand({
                  Bucket: checked.bucket,
                  Key: physicalKey(key),
                  ChecksumMode: "ENABLED",
                }),
                { abortSignal: signal },
              ),
            catch: (cause) => new ObjectStoreFailure({ operation: "head", key, cause }),
          }).pipe(
            Effect.asSome,
            Effect.catchIf(
              (error) => missingHead(error.cause),
              () =>
                Effect.tryPromise({
                  try: (signal) =>
                    client.send(new HeadBucketCommand({ Bucket: checked.bucket }), {
                      abortSignal: signal,
                    }),
                  catch: (cause) => new ObjectStoreFailure({ operation: "head", key, cause }),
                }).pipe(Effect.andThen(Effect.succeedNone)),
            ),
          );
          if (Option.isNone(result)) return Option.none();
          const object = result.value;
          const checksum = yield* Option.match(Option.fromUndefinedOr(object.ChecksumSHA256), {
            onNone: () => Effect.succeedNone,
            onSome: (value) =>
              Schema.decodeEffect(Schema.Uint8ArrayFromBase64)(value).pipe(Effect.asSome),
          });
          const metadata = yield* Schema.decodeUnknownEffect(ObjectMetadata)({
            key,
            etag: object.ETag,
            size: object.ContentLength,
            uploaded: object.LastModified,
            customMetadata: yield* decodeUserMetadata(object.Metadata),
            sha256: Option.getOrUndefined(checksum),
          });
          return Option.some(metadata);
        },
        (effect, key) =>
          effect.pipe(
            Effect.mapError((cause) => new ObjectStoreFailure({ operation: "head", key, cause })),
          ),
      );
      return ObjectStore.of({
        head,
        list: Effect.fn("kannin.s3.list")(
          function* (options: typeof ObjectListInput.Type = {}) {
            const input = yield* Schema.decodeEffect(ObjectListInput, {
              onExcessProperty: "error",
            })(options);
            const page = yield* Effect.tryPromise({
              try: (signal) =>
                client.send(
                  new ListObjectsV2Command({
                    Bucket: checked.bucket,
                    ...(input.prefix !== undefined && { Prefix: physicalKey(input.prefix) }),
                    ...(input.limit !== undefined && { MaxKeys: input.limit }),
                    ...(input.delimiter !== undefined && {
                      Delimiter: physicalKey(input.delimiter),
                    }),
                    ...(input.cursor !== undefined && { ContinuationToken: input.cursor }),
                  }),
                  { abortSignal: signal },
                ),
              catch: (cause) =>
                new ObjectStoreFailure({ operation: "list", key: input.prefix ?? "", cause }),
            });
            const objects = yield* Effect.forEach(
              page.Contents ?? [],
              Effect.fn(function* (object) {
                if (input.includeMetadata === true) {
                  const key = logicalKey(yield* Schema.decodeUnknownEffect(ObjectKey)(object.Key));
                  const metadata = yield* head(key);
                  if (Option.isNone(metadata))
                    return yield* new ObjectStoreFailure({
                      operation: "list",
                      key,
                      cause: new Error("Listed object became unavailable"),
                    });
                  return metadata.value;
                }
                return {
                  key: logicalKey(yield* Schema.decodeUnknownEffect(ObjectKey)(object.Key)),
                  etag: object.ETag,
                  size: object.Size,
                  uploaded: object.LastModified,
                };
              }),
              { concurrency: 4 },
            );
            return yield* Schema.decodeUnknownEffect(ObjectPage)({
              objects,
              delimitedPrefixes: yield* Effect.forEach(page.CommonPrefixes ?? [], (entry) =>
                Schema.decodeUnknownEffect(ObjectKey)(entry.Prefix).pipe(Effect.map(logicalKey)),
              ),
              truncated: page.IsTruncated,
              ...(page.IsTruncated === true && { cursor: page.NextContinuationToken }),
            });
          },
          (effect) =>
            effect.pipe(
              Effect.mapError(
                (cause) => new ObjectStoreFailure({ operation: "list", key: "", cause }),
              ),
            ),
        ),
        remove: Effect.fn("kannin.s3.remove")(
          function* (key: string) {
            yield* Schema.decodeEffect(ObjectKey)(key);
            yield* Effect.tryPromise({
              try: (signal) =>
                client.send(
                  new DeleteObjectCommand({ Bucket: checked.bucket, Key: physicalKey(key) }),
                  {
                    abortSignal: signal,
                  },
                ),
              catch: (cause) => new ObjectStoreFailure({ operation: "remove", key, cause }),
            });
          },
          (effect, key) =>
            effect.pipe(
              Effect.mapError(
                (cause) => new ObjectStoreFailure({ operation: "remove", key, cause }),
              ),
            ),
        ),
        read: Effect.fn("kannin.s3.read")(
          function* (key: string, options: typeof ObjectReadOptions.Type = {}) {
            yield* Schema.decodeEffect(ObjectKey)(key);
            const input = yield* Schema.decodeEffect(ObjectReadOptions, {
              onExcessProperty: "error",
            })(options);
            const result = yield* Effect.tryPromise({
              try: (signal) =>
                client.send(
                  new GetObjectCommand({
                    Bucket: checked.bucket,
                    Key: physicalKey(key),
                    ...(input.range !== undefined && {
                      Range: `bytes=${input.range.offset}-${input.range.offset + input.range.length - 1}`,
                    }),
                  }),
                  {
                    abortSignal: signal,
                  },
                ),
              catch: (cause) => new ObjectStoreFailure({ operation: "read", key, cause }),
            }).pipe(
              Effect.asSome,
              Effect.catchIf(
                (error) => missingKey(error.cause),
                () => Effect.succeedNone,
              ),
            );
            if (Option.isNone(result)) return Option.none();
            const object = result.value;
            const size = { value: object.ContentLength };
            if (input.range !== undefined) {
              const header = yield* Schema.decodeUnknownEffect(ObjectContentRange)(
                object.ContentRange,
              );
              const values = header.match(/\d+/g) ?? [];
              if (
                Number(values[0]) !== input.range.offset ||
                Number(values[1]) - Number(values[0]) + 1 !== object.ContentLength
              )
                return yield* new ObjectStoreFailure({
                  operation: "read",
                  key,
                  cause: new Error("Object storage returned an invalid range"),
                });
              size.value = Number(values[2]);
            }
            const metadata = yield* Schema.decodeUnknownEffect(ObjectMetadata)({
              key,
              etag: object.ETag,
              size: size.value,
              uploaded: object.LastModified,
              customMetadata: yield* decodeUserMetadata(object.Metadata),
            });
            const body = object.Body;
            if (body === undefined)
              return yield* new ObjectStoreFailure({
                operation: "read",
                key,
                cause: new Error("Object storage returned no body"),
              });
            return Option.some({
              metadata,
              body: Stream.fromReadableStream({
                evaluate: () => body.transformToWebStream(),
                onError: (cause) => new ObjectStoreFailure({ operation: "read", key, cause }),
              }),
            });
          },
          (effect, key) =>
            effect.pipe(
              Effect.mapError((cause) => new ObjectStoreFailure({ operation: "read", key, cause })),
            ),
        ),
        write: Effect.fn("kannin.s3.write")(
          function* (
            key: string,
            bytes: Uint8Array,
            condition: typeof ObjectWriteCondition.Type = {},
          ) {
            yield* Schema.decodeEffect(ObjectKey)(key);
            const onlyIf = yield* Schema.decodeEffect(ObjectWriteCondition)(condition);
            const metadata: Record<string, string> = {};
            if (onlyIf.customMetadata !== undefined) {
              const json = yield* Schema.encodeEffect(ObjectUserMetadataJson)(
                onlyIf.customMetadata,
              );
              metadata["kannin-metadata"] = new TextEncoder().encode(json).toBase64();
            }
            const request = new PutObjectCommand({
              Bucket: checked.bucket,
              Key: physicalKey(key),
              Body: bytes,
              ...(onlyIf.ifMatch !== undefined && { IfMatch: onlyIf.ifMatch }),
              Metadata: metadata,
              ...(onlyIf.contentType !== undefined && { ContentType: onlyIf.contentType }),
              ...(onlyIf.sha256 !== undefined && { ChecksumSHA256: onlyIf.sha256.toBase64() }),
              ...(onlyIf.ifNoneMatch !== undefined && { IfNoneMatch: onlyIf.ifNoneMatch }),
            });
            return yield* Effect.tryPromise({
              try: (signal) => client.send(request, { abortSignal: signal }),
              catch: (cause) => new ObjectStoreFailure({ operation: "write", key, cause }),
            }).pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(ObjectVersion)({ etag: result.ETag }),
              ),
              Effect.asSome,
              Effect.catchIf(
                (error) => Schema.is(ObjectStoreFailure)(error) && preconditionFailed(error.cause),
                () => Effect.succeedNone,
              ),
            );
          },
          (effect, key) =>
            effect.pipe(
              Effect.mapError(
                (cause) => new ObjectStoreFailure({ operation: "write", key, cause }),
              ),
            ),
        ),
      });
    }),
  );
