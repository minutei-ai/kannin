import { join } from "node:path";
import { homedir } from "node:os";

const root = join(import.meta.dir, "..");
for (const args of [
  ["cargo", "build", "--lib", "--release", "--locked", "--target", "wasm32-unknown-unknown"],
  [
    join(homedir(), ".cargo/bin/wasm-bindgen"),
    "target/wasm32-unknown-unknown/release/raio_engine.wasm",
    "--target",
    "web",
    "--out-dir",
    "dist/wasm",
  ],
]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
const result = await Bun.build({
  entrypoints: [join(root, "src/worker.ts")],
  outdir: join(root, "dist/worker"),
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
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
await Bun.write(
  join(root, "dist/worker/raio_engine_bg.wasm"),
  Bun.file(join(root, "dist/wasm/raio_engine_bg.wasm")),
);
console.log("Built Raio Rust/WASM + Effect Worker");

const portable = await Bun.build({
  entrypoints: [join(root, "runtime/main.ts"), join(root, "runtime/healthcheck.ts")],
  outdir: join(root, "dist/server"),
  target: "bun",
  format: "esm",
  minify: true,
});
if (!portable.success) {
  console.error(portable.logs);
  process.exit(1);
}
console.log("Built Kannin portable API server");

const cache = await Bun.build({
  entrypoints: [join(root, "runtime/cache/main.ts")],
  outdir: join(root, "dist/cache"),
  target: "bun",
  format: "esm",
  minify: true,
});
if (!cache.success) {
  console.error(cache.logs);
  process.exit(1);
}
console.log("Built Kannin immutable CDN cache gateway");
