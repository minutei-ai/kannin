import Turbopuffer from "@turbopuffer/turbopuffer";
import { afterAll, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRoot } from "../src/manifest";
import {
  ErrorBody,
  NamespaceName,
  NamespacesPage,
  QueryResult,
  RootMigrationResult,
} from "../src/protocol";
import { namespaceCatalogPrefix } from "../src/namespaces";
import { document, request, startWorker, write } from "./harness";

const worker = await startWorker();
afterAll(() => worker.dispose());
const headers = { authorization: "Bearer local-test-token" };

test("namespace catalog waits for migration before exposing existing roots", async () => {
  const isolated = await startWorker();
  await using lifetime = new AsyncDisposableStack();
  lifetime.defer(() => isolated.dispose());
  const bucket = await isolated.getR2Bucket("STORAGE");
  await bucket.put(
    "namespaces/legacy-catalog/root.json",
    encodeRoot({
      version: 1,
      sequence: 0,
      head: null,
      documents: 0,
      titleLength: 0,
      bodyLength: 0,
      vectorEpoch: "legacy-catalog",
      vectorJobs: [],
      lastReceipt: null,
      bloomPacks: [],
      segments: [],
    }),
  );
  const target = new URL("/v1/namespaces", await isolated.ready);
  expect((await fetch(target, { headers })).status).toBe(503);
  expect((await request(isolated, "legacy-catalog", "migrate-root", {})).status).toBe(200);
  expect((await fetch(target, { headers })).status).toBe(503);
  const activate = new URL("/admin/namespaces/catalog", await isolated.ready);
  expect(
    (
      await fetch(activate, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: '{"version":2}',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(activate, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: '{"version":1}',
      })
    ).status,
  ).toBe(200);
  const response = await fetch(target, { headers });
  expect(response.status).toBe(200);
  expect(Schema.decodeUnknownSync(NamespacesPage)(await response.json())).toEqual({
    namespaces: [{ id: "legacy-catalog" }],
  });
  expect((await request(isolated, "unknown-catalog", "metadata")).status).toBe(200);
  for (const operation of ["rebuild", "compact", "vector-sync", "migrate-root"])
    expect((await request(isolated, "unknown-catalog", operation, {})).status).toBe(200);
  expect(await bucket.head("namespaces/unknown-catalog/root.json")).toBeNull();
  expect(await bucket.head(`${namespaceCatalogPrefix}unknown-catalog`)).toBeNull();
});

test("public namespace listing includes acknowledged writes and excludes orphan prefixes", async () => {
  const pending = await fetch(new URL("/v1/namespaces", await worker.ready), { headers });
  expect(pending.status).toBe(503);
  const initialized = await fetch(new URL("/admin/namespaces/catalog", await worker.ready), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: '{"version":1}',
  });
  expect(initialized.status).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  await bucket.put("namespaces/list-basic-orphan/segments/orphan.rsix", "orphan");
  expect((await request(worker, "list-basic-orphan", "migrate-root", {})).status).toBe(200);
  expect(await bucket.head(`${namespaceCatalogPrefix}list-basic-orphan`)).toBeNull();
  const input = write([document("one", "rust")]);
  expect((await request(worker, "list-basic-live", "write", input)).status).toBe(200);
  const registered = await bucket.head(`${namespaceCatalogPrefix}list-basic-live`);
  if (registered === null) throw new Error("Missing namespace registration");
  expect(registered.size).toBe(0);
  expect(registered.version.length).toBeGreaterThan(0);

  expect((await request(worker, "list-basic-live", "write", input)).status).toBe(200);
  expect((await bucket.head(`${namespaceCatalogPrefix}list-basic-live`))?.version).toBe(
    registered.version,
  );
  const response = await fetch(new URL("/v1/namespaces?prefix=list-basic-", await worker.ready), {
    headers,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(Schema.decodeUnknownSync(NamespacesPage)(await response.json())).toEqual({
    namespaces: [{ id: "list-basic-live" }],
  });
});

test("namespace listing preserves complete pagination at the thousand-entry boundary", async () => {
  const bucket = await worker.getR2Bucket("STORAGE");
  const names = Array.from(
    { length: 1001 },
    (_, index) => `list-page-${String(index).padStart(4, "0")}`,
  );
  await Effect.runPromise(
    Effect.forEach(
      names,
      (name) =>
        Effect.tryPromise(async () => {
          await bucket.put(
            `namespaces/${name}/root.json`,
            encodeRoot({
              version: 1,
              sequence: 0,
              head: null,
              documents: 0,
              titleLength: 0,
              bodyLength: 0,
              vectorEpoch: name,
              vectorJobs: [],
              lastReceipt: null,
              bloomPacks: [],
              segments: [],
            }),
          );
          await bucket.put(`${namespaceCatalogPrefix}${name}`, "");
        }),
      { concurrency: 4 },
    ),
  );
  const last = names[1000];
  if (last === undefined) throw new Error("Missing page boundary fixture");
  const firstResponse = await fetch(
    new URL("/v1/namespaces?prefix=list-page-&page_size=1000", await worker.ready),
    { headers },
  );
  expect(firstResponse.status).toBe(200);
  const first = Schema.decodeUnknownSync(NamespacesPage)(await firstResponse.json());
  expect(first.namespaces.map((namespace) => namespace.id)).toEqual(names.slice(0, 1000));
  if (first.next_cursor === undefined) throw new Error("Missing continuation");
  const target = new URL("/v1/namespaces?prefix=list-page-&page_size=1000", await worker.ready);
  target.searchParams.set("cursor", first.next_cursor);
  const secondResponse = await fetch(target, { headers });
  expect(secondResponse.status).toBe(200);
  expect(Schema.decodeUnknownSync(NamespacesPage)(await secondResponse.json())).toEqual({
    namespaces: [{ id: last }],
  });
  const mismatched = new URL(target);
  mismatched.searchParams.set("prefix", "list-basic-");
  expect((await fetch(mismatched, { headers })).status).toBe(400);
});

test("namespace listing validates parameters and never exposes malformed registry data", async () => {
  for (const query of [
    "page_size=0",
    "page_size=1001",
    "page_size=-1",
    "page_size=1.5",
    "page_size=0x10",
    "page_size=x",
    "cursor=invalid",
    "page_size=1&page_size=2",
    "unused=1",
  ]) {
    const response = await fetch(new URL(`/v1/namespaces?${query}`, await worker.ready), {
      headers,
    });
    expect(response.status).toBe(400);
    expect(Schema.decodeUnknownSync(ErrorBody)(await response.json()).status).toBe("error");
  }
  const unauthorized = await fetch(new URL("/v1/namespaces", await worker.ready));
  expect(unauthorized.status).toBe(401);
  const method = await fetch(new URL("/v1/namespaces", await worker.ready), {
    method: "POST",
    headers,
  });
  expect(method.status).toBe(405);
  const missing = await fetch(new URL("/v1/namespaces?prefix=not-present-", await worker.ready), {
    headers,
  });
  expect(Schema.decodeUnknownSync(NamespacesPage)(await missing.json())).toEqual({
    namespaces: [],
  });
  const bucket = await worker.getR2Bucket("STORAGE");
  expect(
    (await request(worker, "list-repair", "write", write([document("one", "stored")]))).status,
  ).toBe(200);
  const root = await bucket.head("namespaces/list-repair/root.json");
  await bucket.put(`${namespaceCatalogPrefix}list-repair`, "corrupt");
  expect(
    (await fetch(new URL("/v1/namespaces?prefix=list-repair", await worker.ready), { headers }))
      .status,
  ).toBe(503);
  const migrated = await request(worker, "list-repair", "migrate-root", {});
  expect(migrated.status).toBe(200);
  expect(Schema.decodeUnknownSync(RootMigrationResult)(await migrated.json()).rootRewritten).toBe(
    false,
  );
  expect((await bucket.head("namespaces/list-repair/root.json"))?.etag).toBe(root?.etag);
  expect(
    (await fetch(new URL("/v1/namespaces?prefix=list-repair", await worker.ready), { headers }))
      .status,
  ).toBe(200);
  await bucket.delete(`${namespaceCatalogPrefix}list-repair`);
  expect((await request(worker, "list-repair", "migrate-root", {})).status).toBe(200);
  expect(
    (await fetch(new URL("/v1/namespaces?prefix=list-repair", await worker.ready), { headers }))
      .status,
  ).toBe(200);
});

test("namespace publication failure preserves committed writes and repairs on same-request retry", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-namespace-publication-"));
  await using lifetime = new AsyncDisposableStack();
  lifetime.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "namespace-publication-worker.ts")],
    outdir: artifacts,
    naming: "worker.js",
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
  await Bun.write(
    join(artifacts, "raio_engine_bg.wasm"),
    Bun.file(join(import.meta.dir, "../dist/worker/raio_engine_bg.wasm")),
  );
  const active = await startWorker(undefined, false, artifacts);
  lifetime.defer(() => active.dispose());
  expect(
    (
      await fetch(new URL("/admin/namespaces/catalog", await active.ready), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: '{"version":1}',
      })
    ).status,
  ).toBe(200);
  const bucket = await active.getR2Bucket("STORAGE");
  for (const mode of ["same", "restart"]) {
    const namespace = `list-publish-${mode}`;
    await bucket.put("fixtures/fail-catalog", "fail");
    const input = write([document("one", "committed once")]);
    const failed = await request(active, namespace, "write", input);
    expect(failed.status).toBe(503);
    const root = await bucket.head(`namespaces/${namespace}/root.json`);
    expect(root).not.toBeNull();
    expect(
      (await bucket.list({ prefix: `namespaces/${namespace}/receipts/` })).objects,
    ).toHaveLength(1);
    expect(await bucket.head(`${namespaceCatalogPrefix}${namespace}`)).toBeNull();
    await bucket.delete("fixtures/fail-catalog");
    if (mode === "restart")
      await active.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
    const repaired = await request(active, namespace, "write", input);
    expect(repaired.status).toBe(200);
    expect((await bucket.head(`namespaces/${namespace}/root.json`))?.etag).toBe(root?.etag);
    expect(
      (await bucket.list({ prefix: `namespaces/${namespace}/receipts/` })).objects,
    ).toHaveLength(1);
    const listed = await fetch(new URL(`/v1/namespaces?prefix=${namespace}`, await active.ready), {
      headers,
    });
    expect(listed.status).toBe(200);
    expect(Schema.decodeUnknownSync(NamespacesPage)(await listed.json())).toEqual({
      namespaces: [{ id: namespace }],
    });
  }
});

test("dotted and 128-character namespace identities survive writes, SDK pagination and warming", async () => {
  const names = ["identity.a-b_c", `identity.${"x".repeat(119)}`, ".identity"];
  const client = new Turbopuffer({
    apiKey: "local-test-token",
    baseURL: (await worker.ready).origin,
    maxRetries: 0,
  });
  for (const namespace of names) {
    expect(
      (await request(worker, namespace, "write", write([document("one", namespace)]))).status,
    ).toBe(200);
    const hinted = await client.namespace(namespace).hintCacheWarm().withResponse();
    expect(hinted.response.status).toBe(202);
    const response = await request(worker, namespace, "query", {
      kind: "text",
      text: "identity",
      topK: 1,
      filters: [],
    });
    expect(response.status).toBe(200);
    const found = Schema.decodeUnknownSync(QueryResult)(await response.json());
    expect(found.rows.map((row) => row.text)).toEqual([namespace]);
  }
  for (const prefix of ["identity.", "."]) {
    const listed: string[] = [];
    for await (const namespace of client.namespaces({ prefix, page_size: 1 }))
      listed.push(namespace.id);
    expect(listed.toSorted()).toEqual(names.filter((name) => name.startsWith(prefix)).toSorted());
    expect(new Set(listed).size).toBe(listed.length);
  }
  const bucket = await worker.getR2Bucket("STORAGE");
  for (const namespace of names)
    expect(await bucket.head(`namespaces/${namespace}/root.json`)).not.toBeNull();
  for (const invalid of [
    "x".repeat(129),
    ".",
    "..",
    "has/slash",
    "has%2Eescape",
    "has space",
    "á",
  ]) {
    expect(Schema.is(NamespaceName)(invalid)).toBe(false);
  }
});
