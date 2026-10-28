import { Config, Redacted } from "effect";

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
});
