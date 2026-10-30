import { Effect } from "effect";
import { CacheFailure } from "../../src/protocol";

export const readCacheBody = Effect.fn("kannin.cache.readBody")(function* (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
) {
  if (body === null) return new Uint8Array();
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        const count = { bytes: 0 };
        while (true) {
          const chunk = yield* Effect.tryPromise(() => reader.read());
          if (chunk.done) break;
          count.bytes += chunk.value.byteLength;
          if (count.bytes > limit)
            return yield* new CacheFailure({
              operation: "put",
              cause: new Error("Cache entry exceeds its byte budget"),
            });
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(count.bytes);
        const offset = { value: 0 };
        for (const chunk of chunks) {
          bytes.set(chunk, offset.value);
          offset.value += chunk.byteLength;
        }
        return bytes;
      }),
    (reader) =>
      Effect.promise(() => reader.cancel()).pipe(
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      ),
  );
});
