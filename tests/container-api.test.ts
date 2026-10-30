import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { Metadata, QueryResult, WriteResult } from "../src/protocol";
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
              const typedIds = ["2", "10", "18446744073709551615"].map((value) => ({
                kind: "uint" as const,
                value,
              }));
              const typedWritten = yield* Effect.tryPromise(() =>
                fetch(`${api.endpoint}/v1/namespaces/${namespace}-typed/write`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    kind: "canonical",
                    idType: "uint",
                    requestId: "typed-container-write",
                    schema: { filterable: [], vectorFilterFields: [], vectorDimensions: 2 },
                    upserts: typedIds.toReversed().map((id) => ({
                      id,
                      roles: { title: "", text: "typed durable identity" },
                      attributes: {},
                      vector: [1, 0],
                    })),
                    deletes: [],
                  }),
                }),
              );
              expect(typedWritten.status).toBe(200);
              yield* Effect.tryPromise(() => typedWritten.arrayBuffer());
              const cellId = { kind: "uint" as const, value: "9007199254740993" };
              const cellAttributes = {
                count: { u64: "18446744073709551615" },
                signed: { i64: "-9223372036854775808" },
                payload: { bytes: "AP8=" },
                tags: ["oci", engine],
              };
              const cellWrite = {
                kind: "typed",
                idType: "uint",
                requestId: "cells-container-write",
                declaration: {
                  vectorDimensions: 2,
                  columns: [
                    { name: "count", type: "u64", filterable: true },
                    { name: "signed", type: "i64" },
                    { name: "payload", type: "bytes" },
                    { name: "tags", type: "[string]", filterable: true },
                  ],
                },
                upserts: [
                  {
                    id: { kind: "uint", value: "9007199254740992" },
                    roles: { title: "cells", text: "cells cells cells" },
                    attributes: { count: { u64: "9007199254740992" } },
                    vector: [1, 0],
                  },
                  {
                    id: cellId,
                    roles: { title: "", text: "cells" },
                    attributes: cellAttributes,
                    vector: [0.8, 0.2],
                  },
                ],
                deletes: [],
              };
              const cellsWritten = yield* Effect.tryPromise(() =>
                fetch(`${api.endpoint}/v1/namespaces/${namespace}-cells/write`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(cellWrite),
                }),
              );
              expect(cellsWritten.status).toBe(200);
              const cellReceipt = yield* Effect.tryPromise(() => cellsWritten.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(WriteResult)),
              );
              yield* api.restart;
              const cellRetry = yield* Effect.tryPromise(() =>
                fetch(`${api.endpoint}/v1/namespaces/${namespace}-cells/write`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(cellWrite),
                }),
              );
              expect(cellRetry.status).toBe(200);
              const retried = yield* Effect.tryPromise(() => cellRetry.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(WriteResult)),
              );
              expect(retried).toEqual(cellReceipt);
              for (const query of [
                { kind: "text", text: "cells" },
                { kind: "vector", vector: [1, 0] },
              ]) {
                const response = yield* Effect.tryPromise(() =>
                  fetch(`${api.endpoint}/v1/namespaces/${namespace}-cells/query`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      ...query,
                      topK: 1,
                      minimumSequence: 1,
                      filters: [{ field: "count", op: "eq", value: cellAttributes.count }],
                    }),
                  }),
                );
                expect(response.status).toBe(200);
                const cells = yield* Effect.tryPromise(() => response.json()).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
                );
                expect(cells.sequence).toBe(1);
                expect(cells.rows.map((row) => row.id)).toEqual([cellId]);
                expect(cells.rows[0]?.attributes).toEqual(cellAttributes);
              }
              const cellMetadata = yield* Effect.tryPromise(() =>
                fetch(`${api.endpoint}/v1/namespaces/${namespace}-cells/metadata`, { headers }),
              );
              expect(cellMetadata.status).toBe(200);
              const cells = yield* Effect.tryPromise(() => cellMetadata.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
              );
              expect(cells).toMatchObject({ sequence: 1, documents: 2, schema: null });
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
              for (const query of [
                { kind: "text", text: "identity" },
                { kind: "vector", vector: [1, 0] },
              ]) {
                const typedResponse = yield* Effect.tryPromise(() =>
                  fetch(`${api.endpoint}/v1/namespaces/${namespace}-typed/query`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ ...query, topK: 3, filters: [], minimumSequence: 1 }),
                  }),
                );
                expect(typedResponse.status).toBe(200);
                const typedRows = yield* Effect.tryPromise(() => typedResponse.json()).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
                );
                expect(typedRows.consistency).toBe("strong");
                expect(typedRows.sequence).toBe(1);
                expect(typedRows.rows.map((row) => row.id)).toEqual(typedIds);
              }
            }),
          );
        }
      }),
    ),
  );
}, 120000);
