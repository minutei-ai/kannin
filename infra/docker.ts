import * as Alchemy from "alchemy";
import * as Docker from "@alchemy.run/docker";
import { Effect } from "effect";
import { join } from "node:path";
import { portableEnvironment } from "./portable-environment";

const root = join(import.meta.dir, "..");
export default () =>
  Alchemy.Stack(
    "KanninDocker",
    { providers: Docker.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const image = yield* Docker.Image("PortableImage", {
        build: { context: root, dockerfile: "Dockerfile" },
      });
      const container = yield* Docker.Container("PortableApi", {
        image,
        environment: yield* portableEnvironment,
        ports: [{ external: 3000, internal: 3000 }],
        start: true,
        restart: "unless-stopped",
      });
      return { url: "http://localhost:3000", containerId: container.id };
    }),
  );
