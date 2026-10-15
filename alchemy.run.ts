import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Command from "alchemy/Command";
import * as Cloudflare from "alchemy/Cloudflare";
import { state as cloudflareState } from "alchemy/Cloudflare/StateStore";
import { Config, Effect, Layer, Schema } from "effect";
import { join } from "node:path";

import { VectorFilterFields } from "./src/protocol";

export const Bucket = Cloudflare.R2.Bucket("Storage", {
  lifecycleRules: [
    {
      id: "expire-correlated-cache",
      prefix: "cache/correlated-",
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 60 * 60 * 24 * 30 } },
    },
  ],
});
export const Vectors = Cloudflare.Vectorize.Index("Vectors", { dimensions: 768, metric: "cosine" });
const EqualityIndexes = Array.from({ length: 5 }, (_, index) =>
  Cloudflare.Vectorize.MetadataIndex(
    `Equality${index}`,
    Effect.gen(function* () {
      return {
        indexName: (yield* Vectors).indexName,
        propertyName: `e${index}`,
        indexType: "string" as const,
      };
    }),
  ),
);
const NumericIndexes = Array.from({ length: 5 }, (_, index) =>
  Cloudflare.Vectorize.MetadataIndex(
    `Numeric${index}`,
    Effect.gen(function* () {
      return {
        indexName: (yield* Vectors).indexName,
        propertyName: `n${index}`,
        indexType: "number" as const,
      };
    }),
  ),
);
export const VectorJobs = Cloudflare.Queues.Queue("VectorJobs");
export const VectorDeadLetters = Cloudflare.Queues.Queue("VectorDeadLetters");
export const IndexJobs = Cloudflare.Queues.Queue("IndexJobs");
export const IndexDeadLetters = Cloudflare.Queues.Queue("IndexDeadLetters");
export const Worker = Cloudflare.Worker(
  "Search",
  Effect.gen(function* () {
    const token = yield* Config.Redacted("RAIO_API_TOKEN");
    const fields = yield* Config.schema(
      Schema.fromJsonString(VectorFilterFields),
      "RAIO_VECTOR_FILTER_FIELDS",
    ).pipe(Config.withDefault([]));
    const indexes = yield* Effect.forEach(
      [...EqualityIndexes.slice(0, fields.length), ...NumericIndexes.slice(0, fields.length)],
      (resource) => resource,
    );
    const encodedFields = yield* Schema.encodeEffect(Schema.fromJsonString(VectorFilterFields))(
      fields,
    ).pipe(Effect.orDie);
    const indexedFields = Output.all(...indexes.map((index) => Output.of(index))).pipe(
      Output.map(() => encodedFields),
    );
    return {
      main: join(import.meta.dir, "dist/worker/worker.js"),
      bundle: false,
      cache: { enabled: true, crossVersionCache: true },
      entrypoints: {
        default: { cache: { enabled: false } },
        Segments: { cache: { enabled: true } },
        Terms: { cache: { enabled: true } },
      },
      compatibility: { date: "2026-10-01" },
      env: {
        CF_VERSION_METADATA: Cloudflare.VersionMetadata(),
        API_TOKEN: token,
        STORAGE: yield* Bucket,
        STORAGE_CACHE_SCOPE: (yield* Bucket).bucketName,
        VECTORS: yield* Vectors,
        VECTOR_FILTER_FIELDS: indexedFields,
        VECTOR_JOBS: yield* VectorJobs,
        INDEX_JOBS: yield* IndexJobs,
        NAMESPACES: Cloudflare.DurableObject("SearchNamespace"),
      },
    };
  }),
);
export type Env = Cloudflare.InferEnv<typeof Worker>;

const state = Layer.unwrap(
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (stage === "dev" || stage.startsWith("dev_")) return Alchemy.localState();
    return cloudflareState();
  }),
);

export default Alchemy.Stack(
  "Raio",
  {
    providers: Layer.merge(
      Cloudflare.providers(),
      Command.ExecProvider().pipe(Layer.provide(Command.CommandExecutorLive())),
    ),
    state,
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    yield* Command.Exec("VectorMetadataMigration", {
      command: "bun tooling/vector-migrate.ts",
      cwd: import.meta.dir,
      memo: false,
      env: {
        RAIO_URL: Output.map(Output.of(worker), (ready) => ready.url),
        RAIO_API_TOKEN: yield* Config.Redacted("RAIO_API_TOKEN"),
      },
    });
    const jobs = yield* VectorJobs;
    const deadLetters = yield* VectorDeadLetters;
    yield* Cloudflare.Queues.Consumer("VectorConsumer", {
      queueId: jobs.queueId,
      scriptName: worker.workerName,
      deadLetterQueue: deadLetters.queueName,
      settings: {
        batchSize: 16,
        maxConcurrency: 4,
        maxWaitTimeMs: 1000,
        maxRetries: 5,
        retryDelay: 60,
      },
    });
    const indexJobs = yield* IndexJobs;
    const indexDeadLetters = yield* IndexDeadLetters;
    yield* Cloudflare.Queues.Consumer("IndexConsumer", {
      queueId: indexJobs.queueId,
      scriptName: worker.workerName,
      deadLetterQueue: indexDeadLetters.queueName,
      settings: {
        batchSize: 8,
        maxConcurrency: 4,
        maxWaitTimeMs: 1000,
        maxRetries: 5,
        retryDelay: 60,
      },
    });
    return { url: worker.url };
  }),
);
