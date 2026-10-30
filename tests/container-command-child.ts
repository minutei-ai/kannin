import { Effect, Schema } from "effect";

await Effect.runPromise(
  Effect.gen(function* () {
    const [path] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.String]))(
      process.argv.slice(2),
    );
    yield* Effect.tryPromise(() => Bun.write(path, String(process.pid)));
    yield* Effect.sleep("1 minute");
  }),
);
