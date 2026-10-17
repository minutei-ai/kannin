import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NamespaceName } from "../src/protocol";
import { startWorker } from "./harness";

export async function retentionFixture() {
  await using cleanup = new AsyncDisposableStack();
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-retention-"));
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "retention-worker.ts")],
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
  const worker = await startWorker(undefined, false, artifacts);
  cleanup.defer(() => worker.dispose());
  const retained = cleanup.move();
  return { worker, [Symbol.asyncDispose]: () => retained.disposeAsync() };
}

export async function ageRetirementUploads(
  worker: Awaited<ReturnType<typeof startWorker>>,
  namespace: typeof NamespaceName.Type,
) {
  const aged = await fetch(new URL("/__retention_age", await worker.ready), {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: Schema.encodeSync(Schema.fromJsonString(NamespaceName))(namespace),
  });
  if (aged.status !== 204) throw new Error("Retirement upload aging failed");
}
