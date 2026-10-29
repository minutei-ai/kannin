import { Effect, Schema } from "effect";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { s3ObjectStore } from "../runtime/s3-object-store";
import { storageConfig } from "../runtime/storage-config";
import { S3StoreConfig } from "../src/protocol";
import { checkObjectStore } from "./object-store-conformance";

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* storageConfig;
      const checked = yield* Schema.decodeEffect(S3StoreConfig)(config);
      const report = yield* checkObjectStore().pipe(Effect.provide(s3ObjectStore(checked)));
      yield* Effect.sync(() => console.log(JSON.stringify({ integrity: "verified", ...report })));
    }),
  ),
);
