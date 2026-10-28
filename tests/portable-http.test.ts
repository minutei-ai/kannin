import { expect, test } from "bun:test";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { Effect, Layer, Redacted } from "effect";
import { servePortable } from "../runtime/server";
import { ObjectStoreFixtureConfig, objectStoreFixtureLive } from "./object-store-fixture";
import { VectorStoreFixtureConfig, vectorStoreFixture } from "./vector-store-fixture";

const services = Layer.merge(objectStoreFixtureLive, vectorStoreFixture(768));

test("portable HTTP server serves native endpoints and official SDK namespace listing", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const objectStore = yield* ObjectStoreFixtureConfig.pipe(Effect.provideContext(context));
        const vectorStore = yield* VectorStoreFixtureConfig.pipe(Effect.provideContext(context));
        const reservation = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(),
        });
        const port = reservation.port ?? 3000;
        yield* Effect.promise(() => reservation.stop(true));
        const { server } = yield* servePortable({
          token: Redacted.make("http-contract-token"),
          host: "127.0.0.1",
          port,
          wasmPath: "./dist/wasm/raio_engine_bg.wasm",
          objectStore,
          vectorStore,
        });
        const baseURL = server.url.origin;
        const response = yield* Effect.tryPromise(() =>
          fetch(`${baseURL}/v1/namespaces/http/write`, {
            method: "POST",
            headers: {
              authorization: "Bearer http-contract-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              requestId: "http-write",
              upserts: [{ id: "one", text: "real HTTP", attributes: {} }],
              deletes: [],
            }),
          }),
        );
        expect(response.status).toBe(200);
        const client = new Turbopuffer({ apiKey: "http-contract-token", baseURL });
        const page = yield* Effect.tryPromise(() => client.namespaces({ page_size: 1 }));
        expect(page.namespaces).toEqual([{ id: "http" }]);
        const unauthorized = yield* Effect.tryPromise(() =>
          fetch(`${baseURL}/v1/namespaces/http/metadata`),
        );
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers.get("cache-control")).toBe("private, no-store");
      }),
    ),
  );
}, 30000);
