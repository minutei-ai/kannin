import { expect, test } from "bun:test";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { Effect, Layer, Redacted, Schema } from "effect";
import { QueryResult } from "../src/protocol";
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

test("portable HTTP queries recover through real object storage when the CDN is unavailable", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requests: {
          token: string | null;
          authorization: string | null;
          cookie: string | null;
        }[] = [];
        const unavailable = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                requests.push({
                  token: request.headers.get("x-kannin-cache-token"),
                  authorization: request.headers.get("authorization"),
                  cookie: request.headers.get("cookie"),
                });
                return new Response(null, { status: 503 });
              },
            }),
          ),
          (owned) => Effect.promise(() => owned.stop(true)),
        );
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
        const { server, app } = yield* servePortable({
          token: Redacted.make("http-contract-token"),
          host: "127.0.0.1",
          port,
          wasmPath: "./dist/wasm/raio_engine_bg.wasm",
          objectStore,
          vectorStore,
          cache: {
            endpoint: unavailable.url.origin,
            token: Redacted.make("separate-cdn-token"),
            timeoutMillis: 250,
            maxEntryBytes: 8 * 1024 * 1024,
          },
        });
        const headers = {
          authorization: "Bearer http-contract-token",
          "content-type": "application/json",
          cookie: "private-user-cookie=never-shared",
        };
        const written = yield* Effect.tryPromise(() =>
          fetch(`${server.url.origin}/v1/namespaces/cache-fallback/write`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              requestId: "fallback-write",
              upserts: [{ id: "one", text: "canonical fallback", attributes: {} }],
              deletes: [],
            }),
          }),
        );
        expect(written.status).toBe(200);
        yield* Effect.tryPromise(() => written.arrayBuffer());
        const body = JSON.stringify({
          kind: "text",
          text: "canonical",
          topK: 10,
          filters: [],
          consistency: "strong",
        });
        const response = yield* Effect.tryPromise(() =>
          fetch(`${server.url.origin}/v1/namespaces/cache-fallback/query`, {
            method: "POST",
            headers,
            body,
          }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const result = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(result.rows.map((row) => row.id)).toEqual(["one"]);
        expect(result.sequence).toBe(1);
        expect(result.consistency).toBe("strong");
        yield* Effect.promise(app.drain);
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests)
          expect(request).toEqual({
            token: "separate-cdn-token",
            authorization: null,
            cookie: null,
          });
        const count = requests.length;
        const rejected = yield* Effect.tryPromise(() =>
          fetch(`${server.url.origin}/v1/namespaces/cache-fallback/query`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
        expect(rejected.status).toBe(401);
        yield* Effect.tryPromise(() => rejected.arrayBuffer());
        yield* Effect.promise(app.drain);
        expect(requests.length).toBe(count);
      }),
    ),
  );
}, 30000);
