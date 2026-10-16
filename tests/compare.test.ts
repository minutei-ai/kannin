import { expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type Turbopuffer from "@turbopuffer/turbopuffer";
import { CacheMetrics, Metadata, Query, QueryResult, StoredDocument } from "../src/protocol";
import { corpus } from "../tooling/corpus";

const ProviderWrite = Schema.Struct({
  upsert_rows: Schema.Array(
    Schema.Struct({
      id: StoredDocument.fields.id,
      text: StoredDocument.fields.text,
      title: StoredDocument.fields.title,
      group: Schema.Int,
      year: Schema.Int,
    }),
  ),
  schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const ProviderQuery = Schema.Struct({
  rank_by: Schema.Tuple([Schema.String, Schema.Literal("BM25"), Schema.String]),
});
const rows = [0, 500]
  .flatMap((offset) => corpus(offset, 1000))
  .filter((document) => document.attributes.group === 42)
  .map((document) => Object.assign({ title: "", revision: 1, score: 1 }, document));

for (const sample of [
  { name: "balanced batches", size: 100001, failWrite: false, failReadiness: false, code: 0 },
  { name: "partial write failure", size: 100001, failWrite: true, failReadiness: false, code: 1 },
  {
    name: "unindexed readiness failure",
    size: 1000,
    failWrite: false,
    failReadiness: true,
    code: 1,
  },
])
  test(`comparator preserves corpus, reuse isolation and cleanup with ${sample.name}`, async () => {
    await using cleanup = new AsyncDisposableStack();
    const batches: number[] = [];
    const bytes: number[] = [];
    const ids = new Set<string>();
    const namespaces = new Set<string>();
    const deleted = new Set<string>();
    const state = { kanninWrites: 0, kanninQueries: 0, turboQueries: 0, metadata: 0 };
    const reuse = "raio-bench-00000000-0000-0000-0000-000000000000";
    const metadata = Schema.decodeUnknownSync(Metadata)({
      sequence: Math.ceil(sample.size / 500),
      documents: sample.size,
      segments: 1,
      manifestEncodedBytes: 1,
      vectorOutbox: 0,
      cache: Object.fromEntries(Object.keys(CacheMetrics.fields).map((key) => [key, 0])),
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/aws-sa-east-1/")) {
          const namespace = url.pathname.split("/")[4];
          if (
            namespace === undefined ||
            !/^raio-bench-[a-f0-9-]{36}$/.test(namespace) ||
            namespace === reuse
          )
            return new Response("Invalid comparator target", { status: 400 });
          if (request.method === "DELETE") {
            deleted.add(namespace);
            return Response.json({ status: "OK" } satisfies Turbopuffer.NamespaceDeleteAllResponse);
          }
          if (url.pathname.endsWith("/metadata")) {
            state.metadata += 1;
            return Response.json({
              approx_row_count: ids.size,
              approx_logical_bytes: 1,
              created_at: "2026-10-15T00:00:00Z",
              updated_at: "2026-10-15T00:00:00Z",
              encryption: { mode: "default" },
              index: { status: "up-to-date" },
              schema: {},
            } satisfies Turbopuffer.NamespaceMetadata);
          }
          if (url.pathname.endsWith("/query")) {
            state.turboQueries += 1;
            if (sample.failReadiness && state.turboQueries > 1)
              return Response.json(
                { error: "Fixture stopped readiness observation" },
                { status: 503 },
              );
            const input = Schema.decodeUnknownSync(ProviderQuery)(await request.json());
            const selected = { rows };
            if (input.rank_by[2] === "unique42") selected.rows = rows.slice(0, 1);
            const performance: Turbopuffer.QueryPerformance = {
              approx_namespace_size: ids.size,
              cache_hit_ratio: 1,
              cache_temperature: "hot",
              exhaustive_search_count: Number(sample.failReadiness),
              query_execution_ms: 1,
              server_total_ms: 1,
            };
            return Response.json({
              rows: selected.rows.map((row) => ({ id: row.id })),
              billing: { billable_logical_bytes_queried: 1, billable_logical_bytes_returned: 1 },
              performance,
            });
          }
          if (request.method === "POST") {
            const body = await request.text();
            const input = Schema.decodeSync(Schema.fromJsonString(ProviderWrite))(body);
            namespaces.add(namespace);
            batches.push(input.upsert_rows.length);
            bytes.push(new TextEncoder().encode(body).byteLength);
            if (sample.failWrite && batches.length === 2)
              return Response.json({ error: "Fixture rejected second write" }, { status: 503 });
            for (const row of input.upsert_rows) ids.add(row.id);
            return Response.json({ rows_affected: input.upsert_rows.length });
          }
        }
        if (url.pathname === `/v1/namespaces/${reuse}/metadata`)
          return Response.json(Schema.encodeSync(Metadata)(metadata));
        if (url.pathname === `/v1/namespaces/${reuse}/write`) {
          state.kanninWrites += 1;
          return new Response("Reuse must not write", { status: 409 });
        }
        if (url.pathname === `/v1/namespaces/${reuse}/query`) {
          state.kanninQueries += 1;
          const input = Schema.decodeUnknownSync(Query)(await request.json());
          if (input.kind !== "text") return new Response(null, { status: 400 });
          const selected = { rows };
          if (input.text === "unique42") selected.rows = rows.slice(0, 1);
          return Response.json(
            Schema.encodeSync(QueryResult)({
              rows: selected.rows,
              sequence: metadata.sequence,
              consistency: input.consistency ?? "strong",
            }),
          );
        }
        return new Response("Unexpected fixture request", { status: 404 });
      },
    });
    cleanup.defer(() => server.stop(true));
    const child = Bun.spawn(
      ["bun", "--no-env-file", join(import.meta.dir, "../tooling/compare.ts")],
      {
        env: {
          PATH: process.env.PATH,
          RAIO_URL: server.url.href,
          RAIO_API_TOKEN: "local-kannin",
          TURBOPUFFER_API_KEY: "local-comparator",
          TURBOPUFFER_BASE_URL: server.url.href + "{region}",
          RAIO_BENCH_DOCUMENTS: String(sample.size),
          RAIO_BENCH_REUSE_NAMESPACE: reuse,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cleanup.defer(async () => {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(sample.code);
    expect(state.kanninWrites).toBe(0);
    expect(namespaces.size).toBe(1);
    expect(deleted).toEqual(namespaces);
    if (sample.code === 0) {
      expect(batches).toEqual([50000, 50001]);
      expect(ids.size).toBe(sample.size);
      expect(ids.has("0")).toBe(true);
      expect(ids.has(String(sample.size - 1))).toBe(true);
      expect(bytes.every((size) => size <= 64 * 1024 * 1024)).toBe(true);
      expect(state.kanninQueries).toBe(448);
      const hash = createHash("sha256");
      for (const offset of Array.from(
        { length: Math.ceil(sample.size / 500) },
        (_, index) => index * 500,
      ))
        hash.update(JSON.stringify(corpus(offset, sample.size)));
      expect(output).toContain(hash.digest("hex"));
      expect(output).toContain('"comparatorDeleted": true');
    } else {
      expect(state.kanninQueries).toBe(0);
      expect(output).not.toContain('"comparatorDeleted": true');
    }
    if (sample.failWrite) {
      expect(batches).toEqual([50000, 50001]);
      expect(ids.size).toBe(50000);
      expect(state.turboQueries).toBe(0);
    }
    if (sample.failReadiness) expect(state.turboQueries).toBe(2);
  }, 30000);
