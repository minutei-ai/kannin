import * as Alchemy from "alchemy";
import * as Docker from "@alchemy.run/docker";
import * as Command from "alchemy/Command";
import { Config, Effect, Layer } from "effect";
import { join } from "node:path";
import { portableEnvironment } from "./portable-environment";

const root = join(import.meta.dir, "..");
export default () =>
  Alchemy.Stack(
    "KanninDocker",
    {
      providers: Layer.merge(
        Docker.providers(),
        Command.ExecProvider().pipe(Layer.provide(Command.CommandExecutorLive())),
      ),
      state: Alchemy.localState(),
    },
    Effect.gen(function* () {
      const network = yield* Docker.Network("PortableNetwork", {});
      const cacheToken = yield* Config.Redacted("KANNIN_CACHE_TOKEN");
      const cacheImage = yield* Docker.Image("CacheImage", {
        build: { context: root, dockerfile: "Dockerfile.cache" },
      });
      const cache = yield* Docker.Container("ImmutableCache", {
        image: cacheImage,
        environment: { KANNIN_CACHE_TOKEN: cacheToken },
        networks: [{ name: network.name, aliases: ["kannin-cache"] }],
        start: false,
        restart: "unless-stopped",
      });
      yield* Command.Exec("StartBoundedCache", {
        command: "bun tooling/start-container.ts",
        cwd: root,
        memo: false,
        timeout: "2 minutes",
        env: { KANNIN_OWNED_CONTAINER_ID: cache.id },
      });
      const image = yield* Docker.Image("PortableImage", {
        build: { context: root, dockerfile: "Dockerfile" },
      });
      const container = yield* Docker.Container("PortableApi", {
        image,
        environment: {
          ...(yield* portableEnvironment),
          KANNIN_CACHE_ENDPOINT: "http://kannin-cache:3000",
          KANNIN_CACHE_TOKEN: cacheToken,
        },
        networks: [{ name: network.name }],
        ports: [{ external: 3000, internal: 3000 }],
        start: false,
        restart: "unless-stopped",
      });
      yield* Command.Exec("StartBoundedApi", {
        command: "bun tooling/start-container.ts",
        cwd: root,
        memo: false,
        timeout: "2 minutes",
        env: { KANNIN_OWNED_CONTAINER_ID: container.id },
      });
      return {
        url: "http://localhost:3000",
        containerId: container.id,
        cacheContainerId: cache.id,
      };
    }),
  );
