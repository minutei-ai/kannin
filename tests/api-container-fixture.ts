import { Cause, Effect, Match, Redacted, Schedule, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3StoreConfig } from "../src/protocol";
import { containerCommand } from "./container-command";

export const portableApiToken = "oci-contract-token";
export type ApiContainerEngine = "podman" | "docker";

const imageInspection = Schema.Struct({
  Architecture: Schema.String,
  Os: Schema.String,
  Config: Schema.Record(Schema.String, Schema.Unknown),
  Healthcheck: Schema.optional(Schema.Unknown),
  RootFS: Schema.Struct({
    Type: Schema.Literal("layers"),
    Layers: Schema.Array(Schema.String),
  }),
});
const imageContent = Schema.fromJsonString(Schema.Tuple([imageInspection]));
export type ApiImageInspection = typeof imageInspection.Type;

const apiImageTag = `localhost/kannin-portable-contract:${crypto.randomUUID()}`;

const waitUntilReady = Effect.fn("kannin.portableApi.ready")(function* (endpoint: string) {
  return yield* Effect.tryPromise(() => fetch(`${endpoint}/health`)).pipe(
    Effect.flatMap((response) => {
      if (response.ok) return Effect.tryPromise(() => response.arrayBuffer());
      return new Cause.UnknownError(new Error("Container is not ready"));
    }),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
  );
});

export const portableApiImage = Effect.gen(function* () {
  yield* Effect.acquireRelease(
    containerCommand([
      "podman",
      "build",
      "--format=docker",
      "--memory=512m",
      "--memory-swap=512m",
      "--cpu-period=100000",
      "--cpu-quota=100000",
      "--tag",
      apiImageTag,
      ".",
    ]),
    () => containerCommand(["podman", "image", "rm", apiImageTag]).pipe(Effect.orDie),
  );
  const temporary = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "kannin-oci-transfer-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const archive = join(temporary, "api-image.tar");
  yield* containerCommand([
    "podman",
    "save",
    "--format",
    "docker-archive",
    "--output",
    archive,
    apiImageTag,
  ]);
  yield* Effect.acquireRelease(
    containerCommand(["docker", "--context", "default", "load", "--input", archive]),
    () =>
      containerCommand(["docker", "--context", "default", "image", "rm", apiImageTag]).pipe(
        Effect.orDie,
      ),
  );
  yield* Effect.tryPromise(() => rm(archive));
  const [source] = yield* containerCommand(["podman", "image", "inspect", apiImageTag]).pipe(
    Effect.flatMap(Schema.decodeEffect(imageContent)),
  );
  const [loaded] = yield* containerCommand([
    "docker",
    "--context",
    "default",
    "image",
    "inspect",
    apiImageTag,
  ]).pipe(Effect.flatMap(Schema.decodeEffect(imageContent)));
  return { image: apiImageTag, source, loaded };
});

export const startPortableApiContainer = Effect.fn("kannin.portableApi.container")(function* (
  engine: ApiContainerEngine,
  image: string,
  storage: typeof S3StoreConfig.Type,
) {
  const options = Match.value(engine).pipe(
    Match.when("docker", () => ({
      cli: ["docker", "--context", "default"],
      run: ["--log-driver=local", "--log-opt=max-size=1m", "--log-opt=max-file=2"],
      command: ["timeout", "--kill-after=10s", "180s", "bun", "dist/server/main.js"],
      remove: ["rm", "--force"],
    })),
    Match.orElse(() => ({
      cli: ["podman"],
      run: ["--timeout=180"],
      command: [],
      remove: ["rm", "--force", "--time", "15"],
    })),
  );
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = reservation.port ?? 3000;
  yield* Effect.promise(() => reservation.stop(true));
  const id = yield* Effect.acquireRelease(
    containerCommand([
      ...options.cli,
      "run",
      ...options.run,
      "--detach",
      "--network=host",
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=1",
      "--pids-limit=128",
      "--env",
      "HOST=127.0.0.1",
      "--env",
      `PORT=${port}`,
      "--env",
      `RAIO_API_TOKEN=${portableApiToken}`,
      "--env",
      `KANNIN_STORAGE_ENDPOINT=${storage.endpoint}`,
      "--env",
      `KANNIN_STORAGE_BUCKET=${storage.bucket}`,
      "--env",
      `KANNIN_STORAGE_REGION=${storage.region}`,
      "--env",
      `KANNIN_STORAGE_URL_STYLE=${storage.urlStyle ?? "path"}`,
      "--env",
      `KANNIN_STORAGE_ACCESS_KEY_ID=${Redacted.value(storage.accessKeyId)}`,
      "--env",
      `KANNIN_STORAGE_SECRET_ACCESS_KEY=${Redacted.value(storage.secretAccessKey)}`,
      image,
      ...options.command,
    ]),
    (owned) => containerCommand([...options.cli, ...options.remove, owned]).pipe(Effect.orDie),
  );
  const endpoint = `http://127.0.0.1:${port}`;
  yield* waitUntilReady(endpoint);
  const restart = containerCommand([...options.cli, "restart", "--time", "15", id]).pipe(
    Effect.andThen(waitUntilReady(endpoint)),
  );
  return { endpoint, restart };
});
