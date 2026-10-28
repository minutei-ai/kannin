import { Config, Option, Redacted } from "effect";

const cacheEnvironment = Config.option(Config.String("KANNIN_CACHE_ENDPOINT")).pipe(
  Config.flatMap((endpoint) => {
    if (Option.isNone(endpoint))
      return Config.succeed<Record<string, string | Redacted.Redacted>>({});
    return Config.all({
      KANNIN_CACHE_ENDPOINT: Config.succeed(endpoint.value),
      KANNIN_CACHE_TOKEN: Config.Redacted("KANNIN_CACHE_TOKEN"),
      KANNIN_CACHE_TIMEOUT_MS: Config.String("KANNIN_CACHE_TIMEOUT_MS").pipe(
        Config.withDefault("250"),
      ),
    });
  }),
);

export const portableEnvironment = Config.all({
  RAIO_API_TOKEN: Config.Redacted("RAIO_API_TOKEN"),
  KANNIN_STORAGE_BUCKET: Config.String("KANNIN_STORAGE_BUCKET"),
  KANNIN_STORAGE_ENDPOINT: Config.String("KANNIN_STORAGE_ENDPOINT"),
  KANNIN_STORAGE_REGION: Config.String("KANNIN_STORAGE_REGION").pipe(
    Config.withDefault("us-east-1"),
  ),
  KANNIN_STORAGE_ACCESS_KEY_ID: Config.Redacted("KANNIN_STORAGE_ACCESS_KEY_ID"),
  KANNIN_STORAGE_SECRET_ACCESS_KEY: Config.Redacted("KANNIN_STORAGE_SECRET_ACCESS_KEY"),
  KANNIN_VECTOR_ENDPOINT: Config.String("KANNIN_VECTOR_ENDPOINT"),
  KANNIN_VECTOR_COLLECTION: Config.String("KANNIN_VECTOR_COLLECTION").pipe(
    Config.withDefault("kannin_vectors"),
  ),
  KANNIN_VECTOR_API_KEY: Config.Redacted("KANNIN_VECTOR_API_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
}).pipe(
  Config.flatMap((base) =>
    cacheEnvironment.pipe(Config.map((cache) => Object.assign({}, base, cache))),
  ),
);
