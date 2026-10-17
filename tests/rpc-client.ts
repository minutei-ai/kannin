import { Effect, Match, Schema } from "effect";
import type { Binding } from "../src/rpc";
import { RpcCommand } from "../src/protocol";
import * as Kannin from "../src/sdk";

export default {
  async fetch(request: Request, env: { KANNIN: Binding }) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const text = yield* Effect.tryPromise(() => request.text());
        const command = yield* Schema.decodeEffect(Schema.fromJsonString(RpcCommand))(text);
        const value = yield* Match.value(command).pipe(
          Match.when({ operation: "query" }, (c) => Kannin.query(c.namespace, c.input)),
          Match.when({ operation: "write" }, (c) => Kannin.write(c.namespace, c.input)),
          Match.when({ operation: "metadata" }, (c) => Kannin.metadata(c.namespace)),
          Match.when({ operation: "compact" }, (c) => Kannin.compact(c.namespace)),
          Match.when({ operation: "collect" }, (c) => Kannin.collect(c.namespace, c.input)),
          Match.when({ operation: "rebuild" }, (c) => Kannin.rebuild(c.namespace)),
          Match.when({ operation: "vector-sync" }, (c) => Kannin.synchronizeVectors(c.namespace)),
          Match.when({ operation: "vector-rebuild" }, (c) =>
            Kannin.rebuildVectors(c.namespace, c.input),
          ),
          Match.exhaustive,
        );
        return Response.json(value);
      }).pipe(
        Effect.provideService(Kannin.Kannin, env.KANNIN),
        Effect.catchTag("Rejected", (error) =>
          Effect.succeed(
            Response.json({ error: error.message, tag: error._tag }, { status: error.status }),
          ),
        ),
      ),
    );
  },
};
