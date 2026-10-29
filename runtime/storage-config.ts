import { Config } from "effect";

export const storageConfig = Config.all({
  bucket: Config.String("KANNIN_STORAGE_BUCKET"),
  endpoint: Config.String("KANNIN_STORAGE_ENDPOINT"),
  region: Config.String("KANNIN_STORAGE_REGION").pipe(Config.withDefault("us-east-1")),
  urlStyle: Config.Literals(["path", "virtual"], "KANNIN_STORAGE_URL_STYLE").pipe(
    Config.withDefault("path"),
  ),
  accessKeyId: Config.Redacted("KANNIN_STORAGE_ACCESS_KEY_ID"),
  secretAccessKey: Config.Redacted("KANNIN_STORAGE_SECRET_ACCESS_KEY"),
});
