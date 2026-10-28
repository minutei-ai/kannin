import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Context, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { containerCommand } from "./container-command";
import type { S3StoreConfig } from "../src/protocol";
import { s3ObjectStore } from "../runtime/s3-object-store";

export class ObjectStoreFixtureConfig extends Context.Service<
  ObjectStoreFixtureConfig,
  typeof S3StoreConfig.Type
>()("kannin/test/ObjectStoreConfig") {}

const fixtureName = `kannin-object-store-${crypto.randomUUID()}`;
const fixture = Effect.acquireRelease(
  Effect.gen(function* () {
    const name = fixtureName;
    const id = yield* containerCommand([
      "podman",
      "run",
      "--detach",
      "--rm",
      "--timeout=180",
      "--name",
      name,
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=1",
      "--publish",
      "127.0.0.1::9000",
      "--image-volume=ignore",
      "--tmpfs",
      "/data:rw,size=268435456,mode=1777",
      "--env",
      "RUSTFS_CONSOLE_ENABLE=false",
      "--env",
      "RUSTFS_OBS_LOGGER_LEVEL=error",
      "docker.io/rustfs/rustfs@sha256:e287e99762a4a3e7b706526e01f2ff755f67db165e9be9f6b907adc6fb6d6ee1",
      "/data",
    ]);
    return { id };
  }),
  ({ id }) => containerCommand(["podman", "stop", "--time", "2", id]).pipe(Effect.orDie),
);

export const objectStoreFixtureLive = Layer.unwrap(
  Effect.gen(function* () {
    const { id } = yield* fixture;
    const address = yield* containerCommand(["podman", "port", id, "9000/tcp"]);
    const checked = yield* Schema.decodeEffect(
      Schema.String.check(Schema.isPattern(/^127\.0\.0\.1:\d+$/)),
    )(address);
    const endpoint = `http://${checked}`;
    const bucket = "kannin-object-store-contract";
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new S3Client({
            endpoint,
            region: "us-east-1",
            forcePathStyle: true,
            maxAttempts: 1,
            credentials: { accessKeyId: "rustfsadmin", secretAccessKey: "rustfsadmin" },
          }),
      ),
      (resource) => Effect.sync(() => resource.destroy()),
    );
    yield* Effect.tryPromise(() => client.send(new CreateBucketCommand({ Bucket: bucket }))).pipe(
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    );
    const config = {
      bucket,
      endpoint,
      region: "us-east-1",
      accessKeyId: Redacted.make("rustfsadmin"),
      secretAccessKey: Redacted.make("rustfsadmin"),
    };
    return Layer.merge(s3ObjectStore(config), Layer.succeed(ObjectStoreFixtureConfig, config));
  }),
);
