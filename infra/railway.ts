import * as Alchemy from "alchemy";
import * as Railway from "@alchemy.run/railway";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Config, Effect, Schema } from "effect";
import { join } from "node:path";
import { S3StoreConfig } from "../src/protocol";
import { portableEnvironment, portableServiceEnvironment } from "./portable-environment";

const root = join(import.meta.dir, "..");
const decodeManagedStorage = Schema.decodeUnknownSync(
  S3StoreConfig.check(
    Schema.makeFilter(
      (storage) => storage.urlStyle !== undefined || "Railway bucket did not provide its URL style",
    ),
  ),
  { onExcessProperty: "error" },
);
export default () =>
  Alchemy.Stack(
    "KanninRailway",
    { providers: Railway.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const project = yield* Railway.Project("PortableProject").pipe(RemovalPolicy.retain());
      const storage = yield* Config.Literals(
        ["external", "managed"],
        "KANNIN_RAILWAY_STORAGE",
      ).pipe(Config.withDefault("external"));
      const environment = yield* Effect.gen(function* () {
        if (storage === "external") return yield* portableEnvironment;
        const bucket = yield* Railway.Bucket("CanonicalStorage", { project }).pipe(
          RemovalPolicy.retain(),
        );
        const serviceEnvironment = yield* portableServiceEnvironment;
        return Output.map(Output.of(bucket), (ready) => {
          const configured = decodeManagedStorage({
            bucket: ready.s3BucketName,
            endpoint: ready.endpoint,
            region: ready.s3Region ?? "auto",
            accessKeyId: ready.accessKeyId,
            secretAccessKey: ready.secretAccessKey,
            urlStyle: ready.urlStyle,
          });
          return Object.assign({}, serviceEnvironment, {
            KANNIN_STORAGE_BUCKET: configured.bucket,
            KANNIN_STORAGE_ENDPOINT: configured.endpoint,
            KANNIN_STORAGE_REGION: configured.region,
            KANNIN_STORAGE_URL_STYLE: configured.urlStyle,
            KANNIN_STORAGE_ACCESS_KEY_ID: configured.accessKeyId,
            KANNIN_STORAGE_SECRET_ACCESS_KEY: configured.secretAccessKey,
          });
        });
      });
      const service = yield* Railway.Service("PortableApi", {
        project,
        context: root,
        port: 3000,
        healthcheckPath: "/health",
        env: environment,
      });
      return { url: service.url };
    }),
  );
