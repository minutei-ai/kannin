import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { state as cloudflareState } from "alchemy/Cloudflare/StateStore";
import { Config, Effect, Layer } from "effect";
import { join } from "node:path";

export const Bucket = Cloudflare.R2.Bucket("Storage");
export const Vectors = Cloudflare.Vectorize.Index("Vectors", { dimensions: 768, metric: "cosine" });
export const VectorJobs = Cloudflare.Queues.Queue("VectorJobs");
export const VectorDeadLetters = Cloudflare.Queues.Queue("VectorDeadLetters");
export const IndexJobs = Cloudflare.Queues.Queue("IndexJobs");
export const IndexDeadLetters = Cloudflare.Queues.Queue("IndexDeadLetters");
export const Worker = Cloudflare.Worker(
  "Search",
  Effect.gen(function* () {
    const token = yield* Config.Redacted("RAIO_API_TOKEN");
    return {
      main: join(import.meta.dir, "dist/worker/worker.js"),
      bundle: false,
      cache: { enabled: true, crossVersionCache: false },
      entrypoints: {
        default: { cache: { enabled: false } },
        Segments: { cache: { enabled: true } },
      },
      compatibility: { date: "2026-10-01" },
      env: {
        API_TOKEN: token,
        STORAGE: yield* Bucket,
        STORAGE_CACHE_SCOPE: (yield* Bucket).bucketName,
        VECTORS: yield* Vectors,
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
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const worker = yield* Worker;
    const jobs = yield* VectorJobs;
    const deadLetters = yield* VectorDeadLetters;
    yield* Cloudflare.Queues.Consumer("VectorConsumer", {
      queueId: jobs.queueId,
      scriptName: worker.workerName,
      deadLetterQueue: deadLetters.queueName,
      settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 5, retryDelay: 60 },
    });
    const indexJobs = yield* IndexJobs;
    const indexDeadLetters = yield* IndexDeadLetters;
    yield* Cloudflare.Queues.Consumer("IndexConsumer", {
      queueId: indexJobs.queueId,
      scriptName: worker.workerName,
      deadLetterQueue: indexDeadLetters.queueName,
      settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 5, retryDelay: 60 },
    });
    return { url: worker.url };
  }),
);
