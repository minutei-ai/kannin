import { expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { Query, QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

async function fixture() {
  const artifacts = await mkdtemp(join(tmpdir(), "kannin-plan-budget-"));
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => rm(artifacts, { recursive: true, force: true }));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "plan-budget-worker.ts")],
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

async function seed(worker: Miniflare, namespace: string) {
  for (const index of Array.from({ length: 6 }, (_, ordinal) => ordinal))
    expect(
      (await request(worker, namespace, "write", write([document(String(index), "alpha beta")])))
        .status,
    ).toBe(200);
  const input = Schema.decodeUnknownSync(Query)({
    ...textQuery("alpha"),
    consistency: "edge-eventual",
    minimumSequence: 6,
  });
  const initial = await request(worker, namespace, "query", input);
  expect(initial.status).toBe(200);
  const reference = Schema.decodeUnknownSync(QueryResult)(await initial.json());
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const state = await fetch(new URL("/fixture/state", await worker.ready));
    if (state.headers.get("x-fixture-published") === "1") return { input, reference };
    if (attempt === 99) throw new Error("Plan cache publication did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  throw new Error("Missing plan cache fixture");
}

async function settled(worker: Miniflare) {
  for (const attempt of Array.from({ length: 300 }, (_, index) => index)) {
    const state = await fetch(new URL("/fixture/state", await worker.ready));
    if (state.headers.get("x-fixture-completed") === state.headers.get("x-fixture-started"))
      return state;
    if (attempt === 299) throw new Error("Background plan acquisition did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  throw new Error("Missing plan acquisition state");
}

for (const phase of ["open", "headers", "body"]) {
  test(`shared text plan ${phase} cannot block canonical query progress`, async () => {
    await using active = await fixture();
    const worker = active.worker;
    const origin = await worker.ready;
    const namespace = `plan-budget-${phase}`;
    const { input, reference } = await seed(worker, namespace);
    expect(
      (
        await fetch(new URL("/fixture/arm", origin), {
          method: "POST",
          body: JSON.stringify({ phase, namespace }),
        })
      ).status,
    ).toBe(204);
    const pending = request(worker, namespace, "query", input);
    const progress = await Effect.runPromise(
      Effect.tryPromise(() => pending).pipe(Effect.timeoutOption("1200 millis")),
    );
    const beforeRelease = await fetch(new URL("/fixture/state", origin));
    expect((await fetch(new URL("/fixture/release", origin))).status).toBe(204);
    const response = await pending;
    expect(Number(beforeRelease.headers.get("x-fixture-started"))).toBeGreaterThan(0);
    expect(beforeRelease.headers.get("x-fixture-completed")).toBe("0");
    expect(Option.isSome(progress)).toBe(true);
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("text_plan_cache_timeout");
    await settled(worker);
  }, 15000);
}

test("same-key shared plan readers retain one deadline after foreground timeout", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const namespace = "plan-budget-shared";
  const { input, reference } = await seed(worker, namespace);
  await fetch(new URL("/fixture/arm", origin), {
    method: "POST",
    body: JSON.stringify({ phase: "headers", namespace }),
  });
  const responses = await Promise.all(
    Array.from({ length: 16 }, () => request(worker, namespace, "query", input)),
  );
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("text_plan_cache_timeout");
  }
  const shared = await fetch(new URL("/fixture/state", origin));
  expect(shared.headers.get("x-fixture-lookups")).toBe("1");
  expect(shared.headers.get("x-fixture-completed")).toBe("0");
  expect(
    responses.filter((response) =>
      response.headers.get("server-timing")?.includes("text_plan_cache_shared"),
    ),
  ).toHaveLength(15);
  await fetch(new URL("/fixture/clear", origin), {
    method: "POST",
    body: JSON.stringify(namespace),
  });
  const pending = request(worker, namespace, "query", input);
  const progress = await Effect.runPromise(
    Effect.tryPromise(() => pending).pipe(Effect.timeoutOption("200 millis")),
  );
  const response = await pending;
  expect(Option.isSome(progress)).toBe(true);
  expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
  expect(response.headers.get("server-timing")).toContain("text_plan_cache_shared");
  const late = await fetch(new URL("/fixture/state", origin));
  expect(late.headers.get("x-fixture-lookups")).toBe("1");
  await fetch(new URL("/fixture/release", origin));
  await settled(worker);
}, 15000);

test("pending shared plan admission remains bounded until native reads settle", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const namespace = "plan-budget-admission";
  const { input, reference } = await seed(worker, namespace);
  await fetch(new URL("/fixture/arm", origin), {
    method: "POST",
    body: JSON.stringify({ phase: "headers", namespace }),
  });
  const pending = Array.from({ length: 16 }, (_, index) =>
    request(worker, namespace, "query", {
      ...input,
      filters: [{ field: "missing", op: "ne", value: index }],
    }),
  );
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const state = await fetch(new URL("/fixture/state", origin));
    if (state.headers.get("x-fixture-lookups") === "16") break;
    if (attempt === 99) throw new Error("Shared plan readers did not enter");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  const overflow = await request(worker, namespace, "query", {
    ...input,
    filters: [{ field: "missing", op: "ne", value: 16 }],
  });
  expect(overflow.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await overflow.json())).toEqual(reference);
  expect(overflow.headers.get("server-timing")).toContain("text_plan_cache_admission");
  const state = await fetch(new URL("/fixture/state", origin));
  expect(state.headers.get("x-fixture-lookups")).toBe("16");
  expect(state.headers.get("x-fixture-completed")).toBe("0");
  for (const response of await Promise.all(pending)) {
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
  }
  await fetch(new URL("/fixture/release", origin));
  await settled(worker);
  const recovered = await request(worker, namespace, "query", {
    ...input,
    filters: [{ field: "missing", op: "ne", value: 17 }],
  });
  expect(recovered.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await recovered.json())).toEqual(reference);
  expect(recovered.headers.get("server-timing")).not.toContain("text_plan_cache_admission");
  const healthy = await fetch(new URL("/fixture/state", origin));
  expect(healthy.headers.get("x-fixture-lookups")).toBe("17");
}, 15000);

test("shared plan body permits survive timeout and cancel expired queued bodies", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const namespace = "plan-budget-bodies";
  const { input, reference } = await seed(worker, namespace);
  const inputs = Array.from({ length: 6 }, (_, index) => ({
    ...input,
    filters: [{ field: "missing", op: "ne", value: index }],
  }));
  for (const query of inputs) {
    const response = await request(worker, namespace, "query", query);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
  }
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const state = await fetch(new URL("/fixture/state", origin));
    if (state.headers.get("x-fixture-published") === "7") break;
    if (attempt === 99) throw new Error("Shared plan bodies were not published");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  await fetch(new URL("/fixture/arm", origin), {
    method: "POST",
    body: JSON.stringify({ phase: "body", namespace, expanded: true }),
  });
  const responses = await Promise.all(
    inputs.map((query) => request(worker, namespace, "query", query)),
  );
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("text_plan_cache_timeout");
  }
  const waiting = await fetch(new URL("/fixture/state", origin));
  expect(waiting.headers.get("x-fixture-active")).toBe("4");
  expect(waiting.headers.get("x-fixture-peak")).toBe("4");
  expect(waiting.headers.get("x-fixture-completed")).toBe("0");
  await fetch(new URL("/fixture/release", origin));
  const completed = await settled(worker);
  expect(completed.headers.get("x-fixture-cancelled")).toBe("2");
}, 15000);

test("failed shared plan bodies release all permits and allow healthy reacquisition", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const namespace = "plan-budget-failure";
  const { input, reference } = await seed(worker, namespace);
  const inputs = Array.from({ length: 4 }, (_, index) => ({
    ...input,
    filters: [{ field: "missing", op: "ne", value: index }],
  }));
  for (const query of inputs) {
    const response = await request(worker, namespace, "query", query);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
  }
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const state = await fetch(new URL("/fixture/state", origin));
    if (state.headers.get("x-fixture-published") === "5") break;
    if (attempt === 99) throw new Error("Failure plans were not published");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  await fetch(new URL("/fixture/arm", origin), {
    method: "POST",
    body: JSON.stringify({ phase: "body-failure", namespace, expanded: true }),
  });
  for (const response of await Promise.all(
    inputs.map((query) => request(worker, namespace, "query", query)),
  )) {
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("text_plan_cache_unavailable");
  }
  const failed = await settled(worker);
  expect(failed.headers.get("x-fixture-peak")).toBe("4");
  expect(failed.headers.get("x-fixture-active")).toBe("0");
  await fetch(new URL("/fixture/arm", origin), {
    method: "POST",
    body: JSON.stringify({ phase: "body", namespace, expanded: true }),
  });
  for (const response of await Promise.all(
    inputs.map((query) => request(worker, namespace, "query", query)),
  )) {
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("text_plan_cache_timeout");
  }
  const waiting = await fetch(new URL("/fixture/state", origin));
  expect(waiting.headers.get("x-fixture-peak")).toBe("4");
  expect(waiting.headers.get("x-fixture-active")).toBe("4");
  await fetch(new URL("/fixture/release", origin));
  await settled(worker);
}, 15000);

test("strong coordinator queries retain background shared plan lifetime", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const namespace = "plan-budget-coordinator";
  const { input } = await seed(worker, namespace);
  const strong = { ...input, consistency: "strong" };
  const initial = await request(worker, namespace, "query", strong);
  expect(initial.status).toBe(200);
  const reference = Schema.decodeUnknownSync(QueryResult)(await initial.json());
  await fetch(new URL(`/fixture/arm?target=coordinator&namespace=${namespace}`, origin), {
    method: "POST",
    body: JSON.stringify({ phase: "headers", namespace }),
  });
  const pending = request(worker, namespace, "query", strong);
  const progress = await Effect.runPromise(
    Effect.tryPromise(() => pending).pipe(Effect.timeoutOption("1200 millis")),
  );
  const response = await pending;
  const state = await fetch(
    new URL(`/fixture/state?target=coordinator&namespace=${namespace}`, origin),
  );
  expect(Option.isSome(progress)).toBe(true);
  expect(response.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
  expect(response.headers.get("server-timing")).toContain("text_plan_cache_timeout");
  expect(state.headers.get("x-fixture-started")).toBe("1");
  expect(state.headers.get("x-fixture-completed")).toBe("0");
  await fetch(new URL(`/fixture/release?target=coordinator&namespace=${namespace}`, origin));
  for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
    const completed = await fetch(
      new URL(`/fixture/state?target=coordinator&namespace=${namespace}`, origin),
    );
    if (completed.headers.get("x-fixture-completed") === "1") return;
    if (attempt === 199) throw new Error("Coordinator background plan read did not settle");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
}, 15000);

test("small shared plan bodies remain parallel within the charged byte budget", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const namespace = "plan-budget-small";
  const { input, reference } = await seed(worker, namespace);
  const inputs = Array.from({ length: 16 }, (_, index) => ({
    ...input,
    filters: [{ field: "missing", op: "ne", value: index }],
  }));
  for (const query of inputs) {
    const response = await request(worker, namespace, "query", query);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
  }
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const state = await fetch(new URL("/fixture/state", origin));
    if (state.headers.get("x-fixture-published") === "17") break;
    if (attempt === 99) throw new Error("Small plans were not published");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  await fetch(new URL("/fixture/arm", origin), {
    method: "POST",
    body: JSON.stringify({ phase: "body", namespace }),
  });
  for (const response of await Promise.all(
    inputs.map((query) => request(worker, namespace, "query", query)),
  )) {
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
    expect(response.headers.get("server-timing")).toContain("text_plan_cache_timeout");
  }
  const waiting = await fetch(new URL("/fixture/state", origin));
  expect(waiting.headers.get("x-fixture-active")).toBe("16");
  expect(waiting.headers.get("x-fixture-peak")).toBe("16");
  expect(waiting.headers.get("x-fixture-completed")).toBe("0");
  await fetch(new URL("/fixture/release", origin));
  await settled(worker);
}, 15000);

test("shared plan expansion metadata must match the framed byte count", async () => {
  await using active = await fixture();
  const worker = active.worker;
  const origin = await worker.ready;
  const namespace = "plan-budget-undercharged";
  const { input, reference } = await seed(worker, namespace);
  await fetch(new URL("/fixture/arm", origin), {
    method: "POST",
    body: JSON.stringify({ phase: "undercharged", namespace }),
  });
  const response = await request(worker, namespace, "query", input);
  expect(response.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await response.json())).toEqual(reference);
  expect(response.headers.get("server-timing")).toContain('text_plan;desc="miss"');
  await fetch(new URL("/fixture/release", origin));
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const state = await fetch(new URL("/fixture/state", origin));
    if (state.headers.get("x-fixture-published") === "2") break;
    if (attempt === 99) throw new Error("The plan frame was not repaired");
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  await fetch(new URL("/fixture/clear", origin), {
    method: "POST",
    body: JSON.stringify(namespace),
  });
  const recovered = await request(worker, namespace, "query", input);
  expect(recovered.status).toBe(200);
  expect(Schema.decodeUnknownSync(QueryResult)(await recovered.json())).toEqual(reference);
  expect(recovered.headers.get("server-timing")).toContain('text_plan;desc="shared"');
}, 15000);
