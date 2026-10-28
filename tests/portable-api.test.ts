import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { portableApplication } from "../runtime/application";
import { Metadata, QueryResult, WriteResult } from "../src/protocol";
import { objectStoreFixtureLive } from "./object-store-fixture";

const module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
);
const token = "portable-api-contract-token";
const services = objectStoreFixtureLive;
function request(path: string, body?: unknown) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (body !== undefined)
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return new Request(`http://localhost${path}`, { headers });
}

test("portable API persists native writes and strong queries across application restarts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const app = yield* portableApplication({ token, scope: "portable-contract", module }).pipe(
          Effect.provideContext(context),
        );
        expect(
          (yield* Effect.tryPromise(() =>
            app.fetch(new Request("http://localhost/v1/namespaces/test/metadata")),
          )).status,
        ).toBe(401);
        const write = yield* Effect.tryPromise(() =>
          app.fetch(
            request("/v1/namespaces/test/write", {
              requestId: "first",
              upserts: [{ id: "one", text: "portable search", attributes: { group: "a" } }],
              deletes: [],
            }),
          ),
        );
        expect(write.status).toBe(200);
        const receipt = yield* Effect.tryPromise(() => write.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WriteResult)),
        );
        expect(receipt.sequence).toBe(1);
        yield* Effect.tryPromise(() => app.dispose());
        const restarted = yield* portableApplication({
          token,
          scope: "portable-contract",
          module,
        }).pipe(Effect.provideContext(context));
        const result = yield* Effect.tryPromise(() =>
          restarted.fetch(
            request("/v1/namespaces/test/query", {
              kind: "text",
              text: "portable",
              topK: 10,
              filters: [],
            }),
          ),
        );
        expect(result.status).toBe(200);
        const query = yield* Effect.tryPromise(() => result.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(query.rows.map((hit) => hit.id)).toEqual(["one"]);
        const metadata = yield* Effect.tryPromise(() =>
          restarted.fetch(request("/v1/namespaces/test/metadata")),
        );
        const decoded = yield* Effect.tryPromise(() => metadata.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
        );
        expect(decoded.documents).toBe(1);
        const reply = yield* Effect.tryPromise(() =>
          restarted.binding.execute({ namespace: "test", operation: "metadata" }),
        );
        expect(reply._tag).toBe("Success");
        const catalog = yield* Effect.tryPromise(() => restarted.fetch(request("/v1/namespaces")));
        expect(yield* Effect.tryPromise(() => catalog.json())).toEqual({
          namespaces: [{ id: "test" }],
        });
        yield* Effect.tryPromise(() => restarted.dispose());
      }),
    ),
  );
}, 30000);

test("two portable replicas fence concurrent writes and expose fresh strong reads", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const first = yield* portableApplication({ token, scope: "replicas", module }).pipe(
          Effect.provideContext(context),
        );
        const second = yield* portableApplication({ token, scope: "replicas", module }).pipe(
          Effect.provideContext(context),
        );
        const replies = yield* Effect.tryPromise(() =>
          Promise.all(
            [first, second, first, second].map((app, index) =>
              app.fetch(
                request("/v1/namespaces/shared/write", {
                  requestId: `concurrent-${index}`,
                  upserts: [
                    { id: `row-${index}`, text: "shared canonical object storage", attributes: {} },
                  ],
                  deletes: [],
                }),
              ),
            ),
          ),
        );
        expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
        yield* Effect.tryPromise(() => Promise.all([first.drain(), second.drain()]));
        for (const app of [first, second]) {
          const response = yield* Effect.tryPromise(() =>
            app.fetch(
              request("/v1/namespaces/shared/query", {
                kind: "text",
                text: "canonical",
                topK: 10,
                filters: [],
                consistency: "strong",
                minimumSequence: 4,
              }),
            ),
          );
          expect(response.status).toBe(200);
          const result = yield* Effect.tryPromise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
          );
          expect(result.sequence).toBe(4);
          expect(result.rows.map((row) => row.id).toSorted()).toEqual([
            "row-0",
            "row-1",
            "row-2",
            "row-3",
          ]);
        }
      }),
    ),
  );
}, 30000);

test("portable vector, hybrid, schema filters and maintenance share the canonical API", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const app = yield* portableApplication({ token, scope: "portable-vectors", module }).pipe(
          Effect.provideContext(context),
        );
        const vector = [1, ...Array.from({ length: 767 }, () => 0)];
        const schema = { filterable: ["group"], vectorFilterFields: ["group"] };
        const initial = {
          requestId: "vector-first",
          schema,
          upserts: [{ id: "one", text: "lexical portable", attributes: { group: "a" }, vector }],
          deletes: [],
        };
        expect(
          (yield* Effect.tryPromise(() =>
            app.fetch(request("/v1/namespaces/vectors/write", initial)),
          )).status,
        ).toBe(200);
        yield* Effect.tryPromise(app.drain);
        for (const kind of ["vector", "hybrid"]) {
          const input = {
            kind,
            vector,
            topK: 10,
            filters: [{ field: "group", op: "eq", value: "a" }],
            ...(kind === "hybrid" && { text: "lexical" }),
          };
          const response = yield* Effect.tryPromise(() =>
            app.fetch(request("/v1/namespaces/vectors/query", input)),
          );
          expect(response.status).toBe(200);
          const result = yield* Effect.tryPromise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
          );
          expect(result.rows.map((row) => row.id)).toEqual(["one"]);
        }
        expect(
          (yield* Effect.tryPromise(() =>
            app.fetch(request("/v1/namespaces/vectors/write", { ...initial, upserts: [] })),
          )).status,
        ).toBe(409);
        for (const operation of [
          "vector-sync",
          "vector-rebuild",
          "rebuild",
          "compact",
          "collect",
          "migrate-root",
        ]) {
          const response = yield* Effect.tryPromise(() =>
            app.fetch(request(`/v1/namespaces/vectors/${operation}`, {})),
          );
          expect(response.status).toBe(200);
        }
        const deleted = { requestId: "vector-delete", upserts: [], deletes: ["one"] };
        expect(
          (yield* Effect.tryPromise(() =>
            app.fetch(request("/v1/namespaces/vectors/write", deleted)),
          )).status,
        ).toBe(200);
        const response = yield* Effect.tryPromise(() =>
          app.fetch(
            request("/v1/namespaces/vectors/query", {
              kind: "vector",
              vector,
              topK: 10,
              filters: [],
            }),
          ),
        );
        const result = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(result.rows).toEqual([]);
      }),
    ),
  );
}, 30000);

test("competing replicas retry the same request without aliasing immutable vector logs", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const first = yield* portableApplication({ token, scope: "same-request", module }).pipe(
          Effect.provideContext(context),
        );
        const second = yield* portableApplication({ token, scope: "same-request", module }).pipe(
          Effect.provideContext(context),
        );
        const vector = [1, ...Array.from({ length: 767 }, () => 0)];
        const payload = {
          requestId: "same-request",
          upserts: [{ id: "one", text: "retry recovery", attributes: {}, vector }],
          deletes: [],
        };
        const responses = yield* Effect.tryPromise(() =>
          Promise.all(
            [first, second].map((app) =>
              app.fetch(request("/v1/namespaces/retried/write", payload)),
            ),
          ),
        );
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        yield* Effect.tryPromise(() => Promise.all([first.drain(), second.drain()]));
        const response = yield* Effect.tryPromise(() =>
          first.fetch(
            request("/v1/namespaces/retried/query", {
              kind: "vector",
              vector,
              topK: 10,
              filters: [],
            }),
          ),
        );
        const result = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(result.sequence).toBe(1);
        expect(result.rows.map((row) => row.id)).toEqual(["one"]);
      }),
    ),
  );
}, 30000);

test("portable reset, idempotent retry and collection preserve sequence barriers", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(services);
        const first = yield* portableApplication({ token, scope: "1".repeat(64), module }).pipe(
          Effect.provideContext(context),
        );
        const second = yield* portableApplication({ token, scope: "1".repeat(64), module }).pipe(
          Effect.provideContext(context),
        );
        const schema = { filterable: ["group"], vectorFilterFields: [] };
        const original = {
          requestId: "original",
          schema,
          upserts: [{ id: "old", text: "retired entry", attributes: { group: "old" } }],
          deletes: [],
        };
        expect(
          (yield* Effect.tryPromise(() =>
            first.fetch(request("/v1/namespaces/reset/write", original)),
          )).status,
        ).toBe(200);
        const reset = {
          requestId: "reset",
          reset: true,
          schema,
          upserts: [{ id: "new", text: "canonical entry", attributes: { group: "new" } }],
          deletes: [],
        };
        const committed = yield* Effect.tryPromise(() =>
          second.fetch(request("/v1/namespaces/reset/write", reset)),
        );
        expect(committed.status).toBe(200);
        const acknowledged = yield* Effect.tryPromise(() => committed.json());
        const retried = yield* Effect.tryPromise(() =>
          first.fetch(request("/v1/namespaces/reset/write", reset)),
        );
        expect(yield* Effect.tryPromise(() => retried.json())).toEqual(acknowledged);
        expect(
          (yield* Effect.tryPromise(() => first.fetch(request("/v1/namespaces/reset/collect", {}))))
            .status,
        ).toBe(200);
        const response = yield* Effect.tryPromise(() =>
          second.fetch(
            request("/v1/namespaces/reset/query", {
              kind: "text",
              text: "entry",
              topK: 10,
              filters: [{ field: "group", op: "eq", value: "new" }],
              consistency: "strong",
              minimumSequence: 2,
            }),
          ),
        );
        const result = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
        );
        expect(result.sequence).toBe(2);
        expect(result.rows.map((row) => row.id)).toEqual(["new"]);
        expect(
          (yield* Effect.tryPromise(() =>
            second.fetch(
              request("/v1/namespaces/reset/query", {
                kind: "text",
                text: "entry",
                topK: 10,
                filters: [],
                consistency: "strong",
                minimumSequence: 3,
              }),
            ),
          )).status,
        ).toBe(409);
      }),
    ),
  );
}, 30000);
