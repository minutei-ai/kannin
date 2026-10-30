import { join } from "node:path";
import { Effect } from "effect";

const root = join(import.meta.dir, "..");
const files = Array.from(new Bun.Glob("tests/**/*.test.ts").scanSync({ cwd: root })).toSorted();
const results = await Effect.runPromise(
  Effect.forEach(
    files,
    (file) =>
      Effect.acquireUseRelease(
        Effect.try(() =>
          Bun.spawn(
            [process.execPath, "test", "--no-orphans", "--timeout", "30000", join(root, file)],
            { cwd: root, stdout: "inherit", stderr: "inherit" },
          ),
        ),
        (child) =>
          Effect.tryPromise(() => child.exited).pipe(Effect.map((status) => ({ file, status }))),
        (child) =>
          Effect.promise(async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await child.exited;
          }),
      ),
    { concurrency: 1 },
  ),
);
const failures = results.filter((result) => result.status !== 0);
if (failures.length > 0) {
  console.error("Test files failed:", failures.map((result) => result.file).join(", "));
  process.exit(1);
}
