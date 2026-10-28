import { expect, test } from "bun:test";
import { Cause, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { QueryResult } from "../src/protocol";
import { ObjectStoreFixtureConfig, objectStoreFixtureLive } from "./object-store-fixture";
import { containerCommand } from "./container-command";

const image = `localhost/kannin-portable-contract:${crypto.randomUUID()}`;
const services = objectStoreFixtureLive;

test("complete OCI API image runs without Cloudflare and survives a container restart", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const objects = yield* ObjectStoreFixtureConfig.pipe(Effect.provideContext(context));
        yield* Effect.acquireRelease(
          containerCommand([
            "podman",
            "build",
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
        const reservation = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(),
        });
        const port = reservation.port ?? 3000;
        yield* Effect.promise(() => reservation.stop(true));
        const id = yield* Effect.acquireRelease(
          containerCommand([
            "podman",
            "run",
            "--timeout=180",
            "--detach",
            "--network=host",
            "--memory=512m",
            "--memory-swap=512m",
            "--cpus=1",
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
          ]),
          (owned) =>
            containerCommand(["podman", "rm", "--force", "--time", "15", owned]).pipe(Effect.orDie),
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
          fetch(`${baseURL}/v1/namespaces/container/write`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              requestId: "container-write",
              upserts: [{ id: "one", text: "container durable state", attributes: {}, vector }],
              deletes: [],
            }),
          }),
        );
        expect(written.status).toBe(200);
        yield* Effect.tryPromise(() => written.arrayBuffer());
        yield* containerCommand(["podman", "restart", "--time", "15", id]);
        yield* ready;
        const response = yield* Effect.tryPromise(() =>
          fetch(`${baseURL}/v1/namespaces/container/query`, {
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
          fetch(`${baseURL}/v1/namespaces/container/query`, {
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
    ),
  );
}, 120000);
