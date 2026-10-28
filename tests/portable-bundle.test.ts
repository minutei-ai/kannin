import { expect, test } from "bun:test";

for (const { target, name } of [
  { target: "railway", name: "KanninRailway" },
  { target: "docker", name: "KanninDocker" },
]) {
  test(`${target} loads its stack without importing the Cloudflare provider`, async () => {
    const child = Bun.spawn(
      [process.execPath, new URL("./portable-stack-loader.ts", import.meta.url).pathname],
      {
        env: { ...process.env, KANNIN_TARGET: target },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(name);
  });
}

test("the portable API bundles without Cloudflare, provisioning or external vector dependencies", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../runtime/main.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "reject-platform-dependencies",
        setup(builder) {
          builder.onResolve(
            { filter: /^(?:cloudflare:|@cloudflare\/|@alchemy\.run\/|alchemy(?:\/|$)|@qdrant\/)/ },
            ({ path }) => {
              throw new Error(`Portable API imported a platform dependency: ${path}`);
            },
          );
        },
      },
    ],
  });
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
});
