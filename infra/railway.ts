import * as Alchemy from "alchemy";
import * as Railway from "@alchemy.run/railway";
import { Effect } from "effect";
import { join } from "node:path";
import { portableEnvironment } from "./portable-environment";

const root = join(import.meta.dir, "..");
export default () =>
  Alchemy.Stack(
    "KanninRailway",
    { providers: Railway.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const project = yield* Railway.Project("PortableProject");
      const service = yield* Railway.Service("PortableApi", {
        project,
        context: root,
        port: 3000,
        healthcheckPath: "/health",
        env: yield* portableEnvironment,
      });
      return { url: service.url };
    }),
  );
