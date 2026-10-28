import { Cause, Effect } from "effect";

export const containerCommand = Effect.fn("kannin.objectStoreTest.command")(function* (
  args: readonly string[],
  output: "stdout" | "combined" = "stdout",
) {
  const child = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = yield* Effect.tryPromise(() =>
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
  );
  if (status !== 0)
    return yield* new Cause.UnknownError(new Error(`Container command failed: ${stderr}`));
  if (output === "combined") return `${stdout}\n${stderr}`.trim();
  return stdout.trim();
});
