import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const probe = Effect.fn("raio.lintProbe")(function* (
  source: string,
  parent: string = root,
  extension: "ts" | "js" = "ts",
) {
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(parent, ".lint-probe-"))),
    (directory) =>
      Effect.gen(function* () {
        const file = join(directory, `probe.${extension}`);
        yield* Effect.tryPromise(() => writeFile(file, source));
        yield* Effect.tryPromise(() =>
          writeFile(
            join(directory, "tsconfig.json"),
            JSON.stringify({
              extends: relative(directory, join(root, "tsconfig.json")),
              include: [`*.${extension}`],
            }),
          ),
        );
        const child = Bun.spawn(["bunx", "oxlint", "--deny-warnings", "--no-ignore", file], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const result = yield* Effect.tryPromise(() =>
          Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]),
        );
        return { output: result[0] + result[1], exitCode: result[2] };
      }),
    (directory) =>
      Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
  );
});

test("strict lint accepts typed native Effect code", async () => {
  const result = await Effect.runPromise(
    probe('import { Effect } from "effect"; export const program = Effect.succeed(42);'),
  );
  expect(result).toMatchObject({ exitCode: 0 });
  const disposal = await Effect.runPromise(
    probe(
      "await using resource = new AsyncDisposableStack(); export const disposed = resource.disposed;",
    ),
  );
  expect(disposal.exitCode).toBe(0);
});

test("strict lint rejects type errors, unsafe values, floating effects and promises", async () => {
  const result = await Effect.runPromise(
    probe(
      [
        'import { Effect } from "effect";',
        'export const invalid: number = "wrong";',
        "export const unsafe: any = 42;",
        "Effect.succeed(42);",
        "Promise.resolve(42);",
      ].join("\n"),
    ),
  );
  expect(result.exitCode).not.toBe(0);
  for (const rule of ["2322", "no-explicit-any", "floating-effect", "no-floating-promises"])
    expect(result.output).toContain(rule);
});

test("syntax policy rejects mutable declarations, assertions and exception plumbing", async () => {
  const result = await Effect.runPromise(
    probe(
      [
        "export let mutable = 1;",
        "export const conditional = mutable > 0 ? 1 : 0;",
        "export const cast = mutable as unknown as string;",
        "try { mutable += 1; } catch { mutable = 0; }",
      ].join("\n"),
    ),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("raio(syntax)");
  expect(result.output).toContain("consistent-type-assertions");
});

test("Rust policy rejects unsafe, panic, unwrap, placeholders and lint suppression", async () => {
  const result = await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp(join(root, ".lint-probe-"))),
      (directory) =>
        Effect.gen(function* () {
          const manifest = yield* Effect.tryPromise(() =>
            readFile(join(root, "Cargo.toml"), "utf8"),
          );
          const policy = manifest
            .slice(
              manifest.indexOf("[workspace.lints.rust]"),
              manifest.indexOf("[profile.release]"),
            )
            .replaceAll("[workspace.lints.", "[lints.");
          yield* Effect.tryPromise(() => mkdir(join(directory, "src")));
          yield* Effect.tryPromise(() =>
            writeFile(
              join(directory, "Cargo.toml"),
              '[package]\nname = "lint-probe"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n' +
                policy,
            ),
          );
          yield* Effect.tryPromise(() =>
            writeFile(
              join(directory, "src/lib.rs"),
              [
                "#[allow(dead_code)]",
                "pub fn probe(value: Option<u8>) -> u8 { value.unwrap() }",
                'pub fn failure() { panic!("failure"); }',
                "pub fn placeholder() { todo!(); }",
                "pub unsafe fn forbidden() {}",
              ].join("\n"),
            ),
          );
          const child = Bun.spawn(
            ["cargo", "clippy", "--offline", "--all-targets", "--", "-D", "warnings"],
            {
              cwd: directory,
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const output = yield* Effect.tryPromise(() =>
            Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]),
          );
          return { output: output[0] + output[1], exitCode: output[2] };
        }),
      (directory) =>
        Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
    ),
  );
  expect(result.exitCode).not.toBe(0);
  for (const rule of [
    "unsafe-code",
    "unwrap_used",
    "clippy::panic",
    "clippy::todo",
    "allow_attributes",
  ])
    expect(result.output).toContain(rule);
});

test("runtime file selection rejects comparator imports while allowing erased native types", async () => {
  const runtime = await Effect.runPromise(
    probe(
      'import Turbopuffer from "@turbopuffer/turbopuffer"; export const comparator = Turbopuffer;',
      join(root, "src"),
    ),
  );
  expect(runtime.exitCode).not.toBe(0);
  expect(runtime.output).toContain("no-restricted-imports");
  const erased = await Effect.runPromise(
    probe(
      'import type Turbopuffer from "@turbopuffer/turbopuffer"; export type Comparator = Turbopuffer;',
      join(root, "src"),
    ),
  );
  expect(erased.exitCode).toBe(0);
});

test("authored JavaScript is rejected by the native lint file selection", async () => {
  const result = await Effect.runPromise(probe("export const value = 42;", root, "js"));
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("Author TypeScript with Effect");
});
