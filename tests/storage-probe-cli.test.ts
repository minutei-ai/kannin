import { expect, test } from "bun:test";
import { Effect } from "effect";

async function interruptedProbe(failDelete: boolean) {
  const pending = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  const observed: { key: string | undefined; metadata: string | undefined; deletes: string[] } = {
    key: undefined,
    metadata: undefined,
    deletes: [],
  };
  await using cleanup = new AsyncDisposableStack();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        await request.arrayBuffer();
        observed.key = key;
        observed.metadata = request.headers.get("x-amz-meta-kannin-metadata") ?? undefined;
        entered.resolve();
        return pending.promise;
      }
      if (request.method === "HEAD" && key === observed.key && observed.metadata !== undefined)
        return new Response(null, {
          headers: {
            etag: '"probe"',
            "content-length": "7",
            "last-modified": "Thu, 29 Oct 2026 00:00:00 GMT",
            "x-amz-meta-kannin-metadata": observed.metadata,
          },
        });
      if (request.method === "DELETE") {
        observed.deletes.push(key);
        if (failDelete)
          return new Response(
            "<Error><Code>ProbeDeleteFailure</Code><Message>owned cleanup rejected</Message></Error>",
            {
              status: 500,
              headers: { "content-type": "application/xml" },
            },
          );
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  cleanup.defer(() => {
    pending.resolve(new Response(null, { status: 503 }));
    return server.stop(true);
  });
  const child = Bun.spawn([process.execPath, "tooling/check-storage.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      KANNIN_STORAGE_BUCKET: "probe-cli-contract",
      KANNIN_STORAGE_ENDPOINT: `http://127.0.0.1:${server.port}`,
      KANNIN_STORAGE_REGION: "us-east-1",
      KANNIN_STORAGE_URL_STYLE: "path",
      KANNIN_STORAGE_ACCESS_KEY_ID: "probe-cli-fixture-access",
      KANNIN_STORAGE_SECRET_ACCESS_KEY: "probe-cli-fixture-secret",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.defer(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  });
  await Effect.runPromise(
    Effect.tryPromise(() => entered.promise).pipe(Effect.timeout("5 seconds")),
  );
  child.kill("SIGTERM");
  const code = await Effect.runPromise(
    Effect.tryPromise(() => child.exited).pipe(Effect.timeout("10 seconds")),
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(observed.metadata).toBeDefined();
  const key = observed.key;
  if (key === undefined) throw new Error("Probe did not establish its fixture key");
  expect(observed.deletes).toEqual([key]);
  expect(code).not.toBe(0);
  expect(stdout).not.toContain('"integrity":"verified"');
  if (failDelete) expect(stderr).toContain("ProbeDeleteFailure");
}

test("the storage CLI waits for owned cleanup after SIGTERM during its initial write", async () => {
  await interruptedProbe(false);
}, 20000);

test("the interrupted storage CLI retains native cleanup failures and never reports success", async () => {
  await interruptedProbe(true);
}, 20000);
