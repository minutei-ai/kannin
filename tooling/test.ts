import { join } from "node:path";

const root = join(import.meta.dir, "..");
const files = Array.from(new Bun.Glob("tests/**/*.test.ts").scanSync({ cwd: root })).toSorted();
for (const file of files) {
  const path = join(root, file);
  const child = Bun.spawn(
    [process.execPath, "test", "--no-orphans", "--bail=1", "--timeout", "30000", path],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
