import { Miniflare } from "miniflare";
import { join } from "node:path";
import type { Write, Attributes } from "../src/protocol";

const root = join(import.meta.dir, "..");
export async function startWorker(
  persistence?: string,
  consumeQueues = false,
  artifactRoot = join(root, "dist/worker"),
  versionId = "kannin-local-test-version",
) {
  const bundle = await Bun.build({
    entrypoints: [join(root, "tests/vector-backend.ts")],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs);
  const artifact = bundle.outputs[0];
  if (artifact === undefined) throw new Error("Missing vector fixture artifact");
  const vectorScript = await artifact.text();
  const triggers = [];
  if (consumeQueues)
    triggers.push(
      ...["raio-vector-jobs", "raio-index-jobs"].map((name) => ({
        type: "queue" as const,
        name,
        maxBatchSize: 16,
        maxBatchTimeout: 0,
        maxRetries: 2,
        retryDelay: 1,
      })),
    );
  const options = {
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "raio",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm" as const,
                contents: await Bun.file(join(artifactRoot, "worker.js")).text(),
              },
              "raio_engine_bg.wasm": {
                type: "wasm" as const,
                contents: new Uint8Array(
                  await Bun.file(join(artifactRoot, "raio_engine_bg.wasm")).arrayBuffer(),
                ),
              },
            },
          },
          env: {
            CF_VERSION_METADATA: {
              type: "json" as const,
              value: { id: versionId, tag: "", timestamp: "2026-10-01T00:00:00Z" },
            },
            VECTOR_FILTER_FIELDS: {
              type: "text" as const,
              value: '["group","year","category","__proto__","flag"]',
            },
            API_TOKEN: { type: "text" as const, value: "local-test-token" },
            STORAGE: { type: "r2" as const, name: "raio-test" },
            STORAGE_CACHE_SCOPE: { type: "text" as const, value: "raio-test" },
            NAMESPACES: {
              type: "durable-object" as const,
              worker: "raio",
              exportName: "SearchNamespace",
            },
            VECTOR_JOBS: { type: "queue" as const, name: "raio-vector-jobs" },
            INDEX_JOBS: { type: "queue" as const, name: "raio-index-jobs" },
            VECTORS: { type: "worker" as const, worker: "vectors", exportName: "VectorBackend" },
          },
          exports: {
            SearchNamespace: { type: "durable-object" as const, storage: "legacy-kv" as const },
          },
          triggers,
        },
      },
      {
        config: {
          name: "vectors",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "vectors.js",
            modules: { "vectors.js": { type: "esm" as const, contents: vectorScript } },
          },
        },
      },
    ],
  };
  const worker = new Miniflare({
    ...options,
    resourcePersistencePath: persistence,
    unsafeInspectDurableObjects: true,
  });
  await worker.ready;
  return worker;
}

export async function request(
  worker: Miniflare,
  namespace: string,
  operation: string,
  body?: unknown,
) {
  const url = new URL(`/v1/namespaces/${namespace}/${operation}`, await worker.ready);
  const result: { response: Response | undefined } = { response: undefined };
  if (body !== undefined)
    result.response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  else
    result.response = await fetch(url, { headers: { authorization: "Bearer local-test-token" } });
  const response = result.response;
  const bytes = await response.arrayBuffer();
  return new Response(bytes, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function textQuery(text: string, topK = 10, filters: unknown[] = []) {
  return { kind: "text", text, topK, filters };
}

export function document(id: string, text: string, attributes: typeof Attributes.Type = {}) {
  return { id, text, attributes };
}

export function write(
  upserts: (typeof Write.Type)["upserts"],
  deletes: string[] = [],
  requestId = crypto.randomUUID(),
) {
  return { requestId, upserts, deletes };
}
