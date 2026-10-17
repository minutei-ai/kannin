import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { workerOptions } from "./harness";
import {
  CollectionResult,
  CompactResult,
  Metadata,
  QueryResult,
  RebuildResult,
  RpcCommand,
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
  const input = {
    requestId: "first",
    upserts: [
      { id: "a", text: "rust busca", attributes: { group: 1 } },
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
  const query = { kind: "text" as const, text: "rust", topK: 10, filters: [], minimumSequence: 1 };
  const result = Schema.decodeUnknownSync(QueryResult)(
    await (await call({ namespace: "rpc", operation: "query", input: query })).json(),
  );
  expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(result.sequence).toBe(1);
  const filtered = await call({
    namespace: "rpc",
    operation: "query",
    input: { ...query, filters: [{ field: "group", op: "eq", value: 2 }] },
  });
  expect(filtered.status).toBe(200);
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
