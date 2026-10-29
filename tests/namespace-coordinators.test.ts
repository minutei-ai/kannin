import { expect, test } from "bun:test";
import { NamespaceCoordinators } from "../runtime/namespace-coordinators";

test("namespace admission evicts idle coordinators while keeping an active owner", async () => {
  await using cleanup = new AsyncDisposableStack();
  const release = Promise.withResolvers<void>();
  cleanup.defer(() => release.resolve());
  const created = { count: 0 };
  const actors = new NamespaceCoordinators(
    () => {
      created.count += 1;
      return { identity: created.count };
    },
    () => undefined,
    2,
  );
  const pending = actors.run("active", async (actor) => {
    await release.promise;
    return actor.identity;
  });
  expect(await actors.run("idle", async (actor) => actor.identity)).toBe(2);
  expect(await actors.run("replacement", async (actor) => actor.identity)).toBe(3);
  expect(await actors.run("active", async (actor) => actor.identity)).toBe(1);
  release.resolve();
  expect(await pending).toBe(1);
});

test("full active capacity rejects a new owner and releases admission after completion", async () => {
  await using cleanup = new AsyncDisposableStack();
  const release = Promise.withResolvers<void>();
  cleanup.defer(() => release.resolve());
  const created = { count: 0 };
  const actors = new NamespaceCoordinators(
    () => {
      created.count += 1;
      return { identity: created.count };
    },
    () => undefined,
    1,
  );
  const pending = actors.run("active", async () => release.promise);
  expect(
    await actors
      .run("other", async () => true)
      .then(
        () => false,
        () => true,
      ),
  ).toBe(true);
  expect(created.count).toBe(1);
  release.resolve();
  await pending;
  expect(await actors.run("other", async (actor) => actor.identity)).toBe(2);
});

test("background work keeps its coordinator admitted after the foreground request completes", async () => {
  await using cleanup = new AsyncDisposableStack();
  const release = Promise.withResolvers<void>();
  cleanup.defer(() => release.resolve());
  const background: Promise<unknown>[] = [];
  const actors = new NamespaceCoordinators(
    (waitUntil) => ({ waitUntil }),
    (promise) => {
      background.push(promise);
    },
    1,
  );
  await actors.run("warming", async (actor) => {
    actor.waitUntil(release.promise);
  });
  expect(
    await actors
      .run("other", async () => true)
      .then(
        () => false,
        () => true,
      ),
  ).toBe(true);
  release.resolve();
  await Promise.all(background);
  expect(await actors.run("other", async () => true)).toBe(true);
});

test("a synchronous operation failure releases coordinator admission", async () => {
  const actors = new NamespaceCoordinators(
    () => ({}),
    () => undefined,
    1,
  );
  const failure = new Error("operation failed");
  expect(
    await actors
      .run("failed", () => {
        throw failure;
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      ),
  ).toBe(failure);
  expect(await actors.run("other", async () => true)).toBe(true);
});
