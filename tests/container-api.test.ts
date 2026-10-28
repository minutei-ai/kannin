import { expect, test } from "bun:test";
import { Cause, Effect, Layer, Match, Redacted, Schedule, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryResult } from "../src/protocol";
import { ObjectStoreFixtureConfig, objectStoreFixtureLive } from "./object-store-fixture";
import { containerCommand } from "./container-command";

const image = `localhost/kannin-portable-contract:${crypto.randomUUID()}`;
const services = objectStoreFixtureLive;
const imageContent = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Struct({
      Architecture: Schema.String,
      Os: Schema.String,
      Config: Schema.Unknown,
      RootFS: Schema.Struct({
        Type: Schema.Literal("layers"),
        Layers: Schema.Array(Schema.String),
      }),
    }),
  ]),
);

test("same OCI API image runs on Podman and Docker Engine with canonical state across restarts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const objects = yield* ObjectStoreFixtureConfig.pipe(Effect.provideContext(context));
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
            image,
            ".",
          ]),
          () => containerCommand(["podman", "image", "rm", image]).pipe(Effect.orDie),
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
          image,
        ]);
        yield* Effect.acquireRelease(
          containerCommand(["docker", "--context", "default", "load", "--input", archive]),
          () =>
            containerCommand(["docker", "--context", "default", "image", "rm", image]).pipe(
              Effect.orDie,
            ),
        );
        yield* Effect.tryPromise(() => rm(archive));
        const [source] = yield* containerCommand(["podman", "image", "inspect", image]).pipe(
          Effect.flatMap(Schema.decodeEffect(imageContent)),
        );
        const [loaded] = yield* containerCommand([
          "docker",
          "--context",
          "default",
          "image",
          "inspect",
          image,
        ]).pipe(Effect.flatMap(Schema.decodeEffect(imageContent)));
        expect(source.RootFS.Layers.length).toBeGreaterThan(0);
        expect(loaded).toEqual(source);
        for (const engine of ["podman", "docker"] as const) {
          const namespace = `container-${engine}`;
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
          yield* Effect.scoped(
            Effect.gen(function* () {
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
                  "RAIO_API_TOKEN=oci-contract-token",
                  "--env",
                  `KANNIN_STORAGE_ENDPOINT=${objects.endpoint}`,
                  "--env",
                  `KANNIN_STORAGE_BUCKET=${objects.bucket}`,
                  "--env",
                  `KANNIN_STORAGE_ACCESS_KEY_ID=${Redacted.value(objects.accessKeyId)}`,
                  "--env",
                  `KANNIN_STORAGE_SECRET_ACCESS_KEY=${Redacted.value(objects.secretAccessKey)}`,
                  image,
                  ...options.command,
                ]),
                (owned) =>
                  containerCommand([...options.cli, ...options.remove, owned]).pipe(Effect.orDie),
              );
              const baseURL = `http://127.0.0.1:${port}`;
              const ready = Effect.tryPromise(() => fetch(`${baseURL}/health`)).pipe(
                Effect.flatMap((response) => {
                  if (response.ok) return Effect.tryPromise(() => response.arrayBuffer());
                  return new Cause.UnknownError(new Error("Container is not ready"));
                }),
                Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
              );
              yield* ready;
              const headers = {
                authorization: "Bearer oci-contract-token",
                "content-type": "application/json",
              };
              const vector = [1, ...Array.from({ length: 767 }, () => 0)];
              const written = yield* Effect.tryPromise(() =>
                fetch(`${baseURL}/v1/namespaces/${namespace}/write`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    requestId: "container-write",
                    upserts: [
                      { id: "one", text: "container durable state", attributes: {}, vector },
                    ],
                    deletes: [],
                  }),
                }),
              );
              expect(written.status).toBe(200);
              yield* Effect.tryPromise(() => written.arrayBuffer());
              yield* containerCommand([...options.cli, "restart", "--time", "15", id]);
              yield* ready;
              const response = yield* Effect.tryPromise(() =>
                fetch(`${baseURL}/v1/namespaces/${namespace}/query`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    kind: "text",
                    text: "durable",
                    topK: 10,
                    filters: [],
                    consistency: "strong",
                  }),
                }),
              );
              expect(response.status).toBe(200);
              const result = yield* Effect.tryPromise(() => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
              );
              expect(result.rows.map((row) => row.id)).toEqual(["one"]);
              expect(result.sequence).toBe(1);
              const vectorResponse = yield* Effect.tryPromise(() =>
                fetch(`${baseURL}/v1/namespaces/${namespace}/query`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    kind: "vector",
                    vector,
                    topK: 1,
                    filters: [],
                    minimumSequence: 1,
                  }),
                }),
              );
              expect(vectorResponse.status).toBe(200);
              const vectors = yield* Effect.tryPromise(() => vectorResponse.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
              );
              expect(vectors.consistency).toBe("strong");
              expect(vectors.rows.map((row) => row.id)).toEqual(["one"]);
              expect(vectors.rows[0]?.score).toBeCloseTo(1);
            }),
          );
        }
      }),
    ),
  );
}, 120000);
