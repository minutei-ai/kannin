import { expect, test } from "bun:test";
import { Effect, Exit, Fiber, Schedule, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { containerCommand } from "./container-command";

test("container commands preserve successful output and report nonzero exits", async () => {
  expect(await Effect.runPromise(containerCommand([process.execPath, "--version"]))).toBe(
    Bun.version,
  );
  const failed = await Effect.runPromiseExit(
    containerCommand([
      process.execPath,
      new URL("./container-command-child.ts", import.meta.url).pathname,
    ]),
  );
  expect(Exit.isFailure(failed)).toBe(true);
});

test("interrupting a container command waits until its owned subprocess has exited", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* Effect.acquireRelease(
          Effect.tryPromise(() => mkdtemp(join(tmpdir(), "kannin-command-interrupt-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const marker = join(temporary, "child.pid");
        const running = yield* containerCommand([
          process.execPath,
          new URL("./container-command-child.ts", import.meta.url).pathname,
          marker,
        ]).pipe(Effect.forkScoped);
        const pid = yield* Effect.tryPromise(() => Bun.file(marker).text()).pipe(
          Effect.flatMap(
            Schema.decodeEffect(
              Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
            ),
          ),
          Effect.retry({ times: 200, schedule: Schedule.spaced("20 millis") }),
        );
        expect(yield* Effect.try(() => process.kill(pid, 0))).toBe(true);
        yield* Fiber.interrupt(running);
        const stopped = yield* Effect.try(() => process.kill(pid, 0)).pipe(Effect.exit);
        expect(Exit.isFailure(stopped)).toBe(true);
      }),
    ),
  );
}, 10000);
