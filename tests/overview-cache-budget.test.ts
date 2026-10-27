import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-overview-deadline-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "overview-cache-budget-worker.ts")],
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

for (const phase of ["open", "headers", "body"]) {
  test(`overview cache ${phase} cannot block canonical catalog progress`, async () => {
    await using active = await fixture();
    const { worker } = active;
    const namespace = `overview-deadline-${phase}`;
    const origin = await worker.ready;
    for (const index of [0, 1, 2])
      expect(
        (
          await request(
            worker,
            namespace,
            "write",
            write([document(String(index), `alpha unique${index}`)]),
          )
        ).status,
      ).toBe(200);
    await fetch(new URL("/fixture/clear", origin), {
      method: "POST",
      body: JSON.stringify(namespace),
    });
    const initial = await request(worker, namespace, "query", textQuery("alpha"));
    expect(initial.status).toBe(200);
    const reference = Schema.decodeUnknownSync(QueryResult)(await initial.json());
    for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
      const state = await fetch(new URL("/fixture/state", origin));
      if (Number(state.headers.get("x-fixture-published")) > 0) break;
      if (attempt === 99) throw new Error("Overview publication did not settle");
      await Effect.runPromise(Effect.sleep("10 millis"));
    }
    expect(
      (
        await fetch(new URL("/fixture/arm", origin), {
          method: "POST",
          body: JSON.stringify({ phase, namespace }),
        })
      ).status,
    ).toBe(204);
    const pending = request(worker, namespace, "query", textQuery("alpha"));
    const progress = await Effect.runPromise(
      Effect.tryPromise(() => pending).pipe(Effect.timeoutOption("1200 millis")),
    );
    const before = await fetch(new URL("/fixture/state", origin));
    const response = await pending;
    expect(Number(before.headers.get("x-fixture-started"))).toBeGreaterThan(0);
    if (phase !== "body") expect(before.headers.get("x-fixture-completed")).toBe("0");
    expect(Option.isSome(progress)).toBe(true);
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("reads=3 hits=3");
    if (phase === "body") {
      const cancelled = await fetch(new URL("/fixture/state", origin));
      expect(Number(cancelled.headers.get("x-fixture-cancelled"))).toBeGreaterThan(0);
    }
    for (const attempt of Array.from({ length: 300 }, (_, index) => index)) {
      const state = await fetch(new URL("/fixture/state", origin));
      if (state.headers.get("x-fixture-completed") === state.headers.get("x-fixture-started"))
        return;
      if (attempt === 299) throw new Error("Late overview acquisition did not settle");
      await Effect.runPromise(Effect.sleep("10 millis"));
    }
  }, 15000);
}
