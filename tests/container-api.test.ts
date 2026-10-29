import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { QueryResult } from "../src/protocol";
import {
  type ApiImageInspection,
  portableApiImage,
  portableApiToken,
  startPortableApiContainer,
} from "./api-container-fixture";
import { ObjectStoreFixtureConfig, objectStoreFixtureLive } from "./object-store-fixture";

const services = objectStoreFixtureLive;
function imageIdentity(inspection: ApiImageInspection) {
  const { Healthcheck: imageHealthcheck, Config, ...content } = inspection;
  const { Healthcheck: configHealthcheck, ...config } = Config;
  return { ...content, Config: config, Healthcheck: imageHealthcheck ?? configHealthcheck };
}

test("same OCI API image runs on Podman and Docker Engine with canonical state across restarts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const objects = yield* ObjectStoreFixtureConfig.pipe(Effect.provideContext(context));
        const { image, source, loaded } = yield* portableApiImage;
        expect(source.RootFS.Layers.length).toBeGreaterThan(0);
        const identity = imageIdentity(source);
        expect(identity.Healthcheck).toMatchObject({
          Test: ["CMD", "bun", "dist/server/healthcheck.js"],
          Interval: 30_000_000_000,
          Timeout: 5_000_000_000,
          StartPeriod: 30_000_000_000,
        });
        expect(imageIdentity(loaded)).toEqual(identity);
        for (const engine of ["podman", "docker"] as const) {
          const namespace = `container-${engine}`;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const api = yield* startPortableApiContainer(engine, image, objects);
              const headers = {
                authorization: `Bearer ${portableApiToken}`,
                "content-type": "application/json",
              };
              const vector = [1, ...Array.from({ length: 767 }, () => 0)];
              const written = yield* Effect.tryPromise(() =>
                fetch(`${api.endpoint}/v1/namespaces/${namespace}/write`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    requestId: "container-write",
                    schema: { filterable: ["tags"], vectorFilterFields: [] },
                    upserts: [
                      {
                        id: "one",
                        text: "container durable state",
                        attributes: { tags: ["oci", engine] },
                        vector,
                      },
                    ],
                    deletes: [],
                  }),
                }),
              );
              expect(written.status).toBe(200);
              yield* Effect.tryPromise(() => written.arrayBuffer());
              yield* api.restart;
              const response = yield* Effect.tryPromise(() =>
                fetch(`${api.endpoint}/v1/namespaces/${namespace}/query`, {
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
              expect(result.rows[0]?.attributes.tags).toEqual(["oci", engine]);
              const vectorResponse = yield* Effect.tryPromise(() =>
                fetch(`${api.endpoint}/v1/namespaces/${namespace}/query`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    kind: "vector",
                    vector,
                    topK: 1,
                    filters: [{ field: "tags", op: "containsAny", value: [engine] }],
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
