import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Command from "alchemy/Command";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { state as cloudflareState } from "@alchemy.run/cloudflare/StateStore";
import { Config, Effect, Layer } from "effect";
import { join } from "node:path";
import type { Binding } from "../src/rpc";

const root = join(import.meta.dir, "..");
export const Bucket = Cloudflare.R2.Bucket("Storage", {
  lifecycleRules: [
    {
      id: "expire-directory-cache",
      prefix: "cache/directory-",
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 60 * 60 * 24 * 30 } },
    },
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
    const indexes = yield* Effect.forEach(
      [...EqualityIndexes, ...NumericIndexes],
      (resource) => resource,
    );
    const indexesReady = yield* Output.all(...indexes.map((index) => Output.of(index)));
    return {
      main: join(root, "dist/worker/worker.js"),
      bundle: false,
      placement: { mode: "smart" },
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
        VECTORS: Effect.as(indexesReady, yield* Vectors),
        VECTOR_JOBS: yield* VectorJobs,
        INDEX_JOBS: yield* IndexJobs,
        NAMESPACES: Cloudflare.DurableObject<Binding & Rpc.DurableObjectBranded>("SearchNamespace"),
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

export default () =>
  Alchemy.Stack(
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
      yield* Command.Exec("RootFormatMigration", {
        command: "bun tooling/root-migrate.ts",
        cwd: root,
        memo: false,
        env: {
          RAIO_URL: Output.map(Output.of(worker), (ready) => ready.url),
          RAIO_API_TOKEN: yield* Config.Redacted("RAIO_API_TOKEN"),
        },
      });
      yield* Command.Exec("VectorMetadataMigration", {
        command: "bun tooling/vector-migrate.ts",
        cwd: root,
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
