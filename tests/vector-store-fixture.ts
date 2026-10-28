import { Context, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { QdrantStoreConfig } from "../src/protocol";
import { qdrantVectorStore } from "../runtime/qdrant-vector-store";
import { containerCommand } from "./container-command";

export class VectorStoreFixtureConfig extends Context.Service<
  VectorStoreFixtureConfig,
  typeof QdrantStoreConfig.Type
>()("kannin/test/VectorStoreConfig") {}

const fixtureName = `kannin-vector-store-${crypto.randomUUID()}`;
export const vectorStoreFixture = (dimensions = 3) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const id = yield* Effect.acquireRelease(
        containerCommand([
          "podman",
          "run",
          "--detach",
          "--rm",
          "--timeout=180",
          "--name",
          fixtureName,
          "--memory=512m",
          "--memory-swap=512m",
          "--cpus=1",
          "--publish",
          "127.0.0.1::6333",
          "--image-volume=ignore",
          "--tmpfs",
          "/qdrant/storage:rw,size=268435456,mode=1777",
          "--env",
          "QDRANT__TELEMETRY_DISABLED=true",
          "docker.io/qdrant/qdrant@sha256:2d1b0bfd0a961275481ea09400fc98008216ae54e1b52ed7d24520d63050c644",
        ]),
        (owned) => containerCommand(["podman", "stop", "--time", "2", owned]).pipe(Effect.orDie),
      );
      const address = yield* containerCommand(["podman", "port", id, "6333/tcp"]);
      const checked = yield* Schema.decodeEffect(
        Schema.String.check(Schema.isPattern(/^127\.0\.0\.1:\d+$/)),
      )(address);
      const endpoint = `http://${checked}`;
      const client = new QdrantClient({ url: endpoint, checkCompatibility: false });
      yield* Effect.tryPromise(() => client.getCollections()).pipe(
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
      const config = {
        endpoint,
        collection: "kannin_contract",
        dimensions,
        apiKey: Redacted.make(""),
      };
      return Layer.merge(
        qdrantVectorStore(config),
        Layer.succeed(VectorStoreFixtureConfig, config),
      );
    }),
  );

export const vectorStoreFixtureLive = vectorStoreFixture();
