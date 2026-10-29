import { Effect, Schema } from "effect";
import { s3ObjectStore } from "../runtime/s3-object-store";
import { storageConfig } from "../runtime/storage-config";
import { S3StoreConfig } from "../src/protocol";
import { checkObjectStore } from "./object-store-conformance";

const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* storageConfig;
      const checked = yield* Schema.decodeEffect(S3StoreConfig)(config);
      return yield* checkObjectStore().pipe(Effect.provide(s3ObjectStore(checked)));
    }),
  ),
);
console.log(JSON.stringify({ integrity: "verified", ...report }));
