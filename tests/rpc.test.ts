import { expect, test } from "bun:test";
import { Cause, Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { workerOptions } from "./harness";
import {
  CollectionResult,
  CompactResult,
  Metadata,
  NamespacesPage,
  QueryResult,
  RebuildResult,
  RpcCommand,
  RpcReply,
  Rejected,
  RootMigrationResult,
  VectorRebuildResult,
  VectorSyncResult,
  WriteResult,
} from "../src/protocol";
import * as Kannin from "../src/sdk";

test("Effect SDK performs native binding RPC with Worker and coordinator HTTP disabled", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-rpc-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "rpc-server.ts"), join(import.meta.dir, "rpc-client.ts")],
    outdir: artifacts,
    target: "browser",
    format: "esm",
    minify: true,
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "wasm",
        setup(builder) {
          builder.onResolve({ filter: /^raio:wasm$/ }, () => ({
            path: "./raio_engine_bg.wasm",
            external: true,
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs);
  await Bun.write(join(artifacts, "worker.js"), Bun.file(join(artifacts, "rpc-server.js")));
  await Bun.write(
    join(artifacts, "raio_engine_bg.wasm"),
    Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")),
  );
  const options = await workerOptions(false, artifacts);
  const worker = new Miniflare({
    ...options,
    workers: [
      ...options.workers,
      {
        config: {
          name: "client",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "client.js",
            modules: {
              "client.js": {
                type: "esm",
                contents: await Bun.file(join(artifacts, "rpc-client.js")).text(),
              },
            },
          },
          env: { KANNIN: { type: "worker", worker: "raio", exportName: "KanninRpc" } },
        },
      },
    ],
  });
  cleanup.defer(() => worker.dispose());
  await worker.ready;
  const server = await worker.getWorker("raio");
  expect((await server.fetch("https://disabled.test/")).status).toBe(502);
  const client = await worker.getWorker("client");
  const call = (command: typeof RpcCommand.Type) =>
    client.fetch("https://client.test/", {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(RpcCommand))(command),
    });
  const vector = [1, ...Array.from({ length: 767 }, () => 0)];
  const input = {
    schema: { filterable: ["group"], vectorFilterFields: [] },
    requestId: "first",
    upserts: [
      { id: "a", text: "rust busca", attributes: { group: 1 }, vector },
      { id: "b", text: "rust storage", attributes: { group: 2 } },
    ],
    deletes: [],
  };
  const written = await call({ namespace: "rpc", operation: "write", input });
  expect(written.status, await written.clone().text()).toBe(200);
  expect(Schema.decodeUnknownSync(WriteResult)(await written.json()).sequence).toBe(1);
  expect(
    Schema.decodeUnknownSync(WriteResult)(
      await (await call({ namespace: "rpc", operation: "write", input })).json(),
    ).sequence,
  ).toBe(1);
  const conflict = await call({
    namespace: "rpc",
    operation: "write",
    input: { ...input, deletes: ["c"] },
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    tag: "Rejected",
    error: "requestId already used with a different payload",
  });
  await (await worker.getR2Bucket("STORAGE")).put("namespace-catalog-v1.ready", "");
  const listed = await call({ operation: "namespaces", input: { prefix: "rpc", page_size: 1 } });
  expect(listed.status).toBe(200);
  expect(Schema.decodeUnknownSync(NamespacesPage)(await listed.json())).toEqual({
    namespaces: [{ id: "rpc" }],
  });
  const query = { kind: "text" as const, text: "rust", topK: 10, filters: [], minimumSequence: 1 };
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await call({ namespace: "rpc", operation: "query", input: query })).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(result.sequence).toBe(1);
  const migrated = Schema.decodeUnknownSync(RootMigrationResult)(
    await (await call({ namespace: "rpc", operation: "migrate-root" })).json(),
  );
  expect(migrated).toEqual({
    version: 5,
    sequence: 1,
    rootRewritten: false,
    migratedSnapshots: 0,
    expiredSnapshots: 0,
  });
  const filtered = await call({
    namespace: "rpc",
    operation: "query",
    input: { ...query, filters: [{ field: "group", op: "eq", value: 2 }] },
  });
  expect(filtered.status).toBe(200);
  const undeclared = await call({
    namespace: "rpc",
    operation: "query",
    input: { ...query, filters: [{ field: "other", op: "exists", value: true }] },
  });
  expect(undeclared.status).toBe(400);

  expect(
    Schema.decodeUnknownSync(QueryResult)(await filtered.json()).rows.map((row) => row.id),
  ).toEqual(["b"]);

  const edge = await call({
    namespace: "rpc",
    operation: "query",
    input: { ...query, consistency: "edge-eventual" },
  });
  expect(edge.status, await edge.clone().text()).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await edge.json()).rows).toEqual(result.rows);

  expect(
    (await call({ namespace: "rpc", operation: "query", input: { ...query, minimumSequence: 2 } }))
      .status,
  ).toBe(409);
  expect(
    Schema.decodeUnknownSync(QueryResult)(
      await (
        await call({
          namespace: "other",
          operation: "query",
          input: { ...query, minimumSequence: 0 },
        })
      ).json(),
    ).rows,
  ).toEqual([]);
  expect(
    Schema.decodeUnknownSync(Metadata)(
      await (await call({ namespace: "rpc", operation: "metadata" })).json(),
    ).documents,
  ).toBe(2);
  expect(
    Schema.decodeUnknownSync(CompactResult)(
      await (await call({ namespace: "rpc", operation: "compact" })).json(),
    ).compacted,
  ).toBe(0);
  expect(
    Schema.decodeUnknownSync(RebuildResult)(
      await (await call({ namespace: "rpc", operation: "rebuild" })).json(),
    ).sequence,
  ).toBe(1);
  expect(
    Schema.decodeUnknownSync(VectorSyncResult)(
      await (await call({ namespace: "rpc", operation: "vector-sync" })).json(),
    ).visibility,
  ).toBe("vectorize-eventual");
  const vectorResponse = await call({
    namespace: "rpc",
    operation: "query",
    input: { kind: "vector", vector, topK: 10, filters: [], minimumSequence: 1 },
  });
  expect(vectorResponse.status).toBe(200);
  const vectorResult = Schema.decodeUnknownSync(QueryResult)(await vectorResponse.json());
  expect(vectorResult.consistency).toBe("vectorize-eventual");
  expect(vectorResult.sequence).toBe(1);
  expect(vectorResult.rows.map((row) => row.id)).toEqual(["a"]);
  expect(vectorResult.rows[0]?.attributes).toEqual({ group: 1 });
  expect(vectorResult.rows[0]?.score).toBe(1);
  const hybridResponse = await call({
    namespace: "rpc",
    operation: "query",
    input: { ...query, kind: "hybrid", vector },
  });
  expect(hybridResponse.status).toBe(200);
  const hybridResult = Schema.decodeUnknownSync(QueryResult)(await hybridResponse.json());
  expect(hybridResult.consistency).toBe("vectorize-eventual");
  expect(hybridResult.sequence).toBe(1);
  expect(hybridResult.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(hybridResult.rows[0]?.score).toBeCloseTo(2 / 61, 12);
  expect(hybridResult.rows[1]?.score).toBeCloseTo(1 / 62, 12);
  expect(
    Schema.decodeUnknownSync(VectorRebuildResult)(
      await (await call({ namespace: "rpc", operation: "vector-rebuild", input: {} })).json(),
    ).complete,
  ).toBe(true);
  expect(
    Schema.decodeUnknownSync(CollectionResult)(
      await (await call({ namespace: "rpc", operation: "collect", input: {} })).json(),
    ).cursor,
  ).toBeNull();
  const deleted = await call({
    namespace: "rpc",
    operation: "write",
    input: { requestId: "delete", upserts: [], deletes: ["a"] },
  });
  expect(Schema.decodeUnknownSync(WriteResult)(await deleted.json()).sequence).toBe(2);
  expect(
    Schema.decodeUnknownSync(QueryResult)(
      await (await call({ namespace: "rpc", operation: "query", input: query })).json(),
    ).rows.map((row) => row.id),
  ).toEqual(["b"]);
  const staleVector = await call({
    namespace: "rpc",
    operation: "query",
    input: { kind: "vector", vector, topK: 10, filters: [], minimumSequence: 2 },
  });
  expect(staleVector.status).toBe(200);
  const reconciledVector = Schema.decodeUnknownSync(QueryResult)(await staleVector.json());
  expect(reconciledVector.sequence).toBe(2);
  expect(reconciledVector.rows).toEqual([]);
}, 15000);

test("SDK input validation fails before invoking the binding", async () => {
  const calls = { count: 0 };
  const result = await Effect.runPromiseExit(
    Kannin.metadata("../invalid").pipe(
      Effect.provideService(Kannin.Kannin, {
        execute() {
          calls.count += 1;
          return Promise.reject(new Error("Unexpected binding call"));
        },
      }),
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(calls.count).toBe(0);
});

test("SDK validates operation results and framing while preserving declared and native failures", async () => {
  const input = { kind: "text" as const, text: "rust", topK: 10, filters: [] };
  const value = Schema.decodeSync(QueryResult)({
    rows: [
      {
        id: "a",
        title: "title",
        text: "body",
        attributes: { flag: true },
        revision: 1,
        score: 0.5,
      },
    ],
    sequence: 1,
    consistency: "strong",
  });
  const valid = Schema.encodeSync(RpcReply)({ _tag: "Success", value });
  expect(
    await Effect.runPromise(
      Kannin.query("reply-validation", input).pipe(
        Effect.provideService(Kannin.Kannin, { execute: () => Promise.resolve(valid) }),
      ),
    ),
  ).toEqual(value);
  const wrong = Schema.encodeSync(RpcReply)({
    _tag: "Success",
    value: { sequence: 1, requestId: "wrong-operation", vectorSync: "queued" },
  });
  const badScore: typeof RpcReply.Encoded = {
    _tag: "Success",
    value: { ...value, rows: value.rows.map((row) => ({ ...row, score: NaN })) },
  };
  const badId: typeof RpcReply.Encoded = {
    _tag: "Success",
    value: { ...value, rows: value.rows.map((row) => ({ ...row, id: "" })) },
  };
  const badTag = Schema.encodeSync(RpcReply)({ _tag: "Success", value });
  expect(Reflect.set(badTag, "_tag", "unknown")).toBe(true);
  const missingTag = Schema.encodeSync(RpcReply)({ _tag: "Success", value });
  expect(Reflect.deleteProperty(missingTag, "_tag")).toBe(true);
  const missingValue = Schema.encodeSync(RpcReply)({ _tag: "Success", value });
  expect(Reflect.deleteProperty(missingValue, "value")).toBe(true);
  const rejected = new Rejected({
    status: 503,
    message: "native failure",
    upstreamStatus: 429,
    upstreamRay: "local-ray",
  });
  const missingError = Schema.encodeSync(RpcReply)({ _tag: "Failure", error: rejected });
  expect(Reflect.deleteProperty(missingError, "error")).toBe(true);
  const badError = Schema.encodeSync(RpcReply)({ _tag: "Failure", error: rejected });
  if (badError._tag !== "Failure") throw new Error("Wrong fixture variant");
  expect(Reflect.set(badError.error, "status", NaN)).toBe(true);
  for (const reply of [
    wrong,
    badScore,
    badId,
    badTag,
    missingTag,
    missingValue,
    missingError,
    badError,
  ]) {
    const error = await Effect.runPromise(
      Kannin.query("reply-validation", input).pipe(
        Effect.provideService(Kannin.Kannin, { execute: () => Promise.resolve(reply) }),
        Effect.flip,
      ),
    );
    expect(Schema.isSchemaError(error)).toBe(true);
  }
  const failure = Schema.encodeSync(RpcReply)({ _tag: "Failure", error: rejected });
  const declared = await Effect.runPromise(
    Kannin.query("reply-validation", input).pipe(
      Effect.provideService(Kannin.Kannin, { execute: () => Promise.resolve(failure) }),
      Effect.flip,
    ),
  );
  expect(Schema.is(Rejected)(declared)).toBe(true);
  if (Schema.is(Rejected)(declared))
    expect(Schema.encodeSync(Rejected)(declared)).toEqual(Schema.encodeSync(Rejected)(rejected));
  const source = new Error("native binding failure");
  const native = await Effect.runPromise(
    Kannin.query("reply-validation", input).pipe(
      Effect.provideService(Kannin.Kannin, { execute: () => Promise.reject(source) }),
      Effect.flip,
    ),
  );
  expect(Cause.isUnknownError(native)).toBe(true);
  if (Cause.isUnknownError(native)) expect(native.cause).toBe(source);
});

test("SDK resolves a valid success payload by the requested operation", async () => {
  const value = Schema.decodeSync(QueryResult)({
    rows: [],
    sequence: 1,
    consistency: "strong",
  });
  const reply: typeof RpcReply.Encoded = {
    _tag: "Success",
    value: {
      ...value,
      version: 5,
      rootRewritten: false,
      migratedSnapshots: 0,
      expiredSnapshots: 0,
    },
  };
  const result = await Effect.runPromise(
    Kannin.query("reply-operation", {
      kind: "text",
      text: "rust",
      topK: 10,
      filters: [],
    }).pipe(Effect.provideService(Kannin.Kannin, { execute: () => Promise.resolve(reply) })),
  );
  expect(result).toEqual(value);
});
