# Static checks

`bun run check` runs formatting, release WASM generation, type-aware Oxlint, native and WASM Clippy, the patched native TypeScript compiler, and the local test suites. `bun run typecheck` runs the compiler separately. Frozen installation invokes the official `effect-tsgo patch --oxlint` preparation hook for both TypeScript and Oxlint; the resolved versions and Alchemy patch stay pinned.

## TypeScript and Effect

Oxlint discovers the entire project, excluding dependencies and generated outputs. The official strict Effect preset and correctness, suspicious and performance categories are fatal. Additional diagnostics reject implicit truthiness, unsafe Effect assertions, untyped error/context channels, and direct global clock, random, timer, console or environment access inside Effect programs. Native asynchronous bindings retain `Effect.tryPromise` at their boundary.

The native compiler loads `@effect/language-service` through the installed Effect tsgo schema and treats strict-preset diagnostics as errors. A compiler-only probe verifies that an unconsumed Effect fails without running Oxlint. Compiler warnings and errors affect its exit code. Strict checking includes unchecked indexing, exact optional properties, unused locals/parameters, implicit returns, unreachable code, labels and side-effect import resolution.

Unsafe values, assertions and unhandled promises are errors. The typed syntax plugin rejects mutable declarations, ternaries, switches, exception plumbing, blanket exports, instance guards and authored comments. It rejects authored JavaScript; generated deployment artifacts stay generator-owned. Native immutable using declarations remain valid. Restricted imports keep provisioning, host APIs and SQL clients out of executable Worker imports while allowing erased native types. No source lint suppressions are used.

Two concurrency/ownership rules remain deliberately curated: `no-await-in-loop` conflicts with serial writes, bounded I/O, dependent builds and comparable sequential measurements; `no-array-sort` conflicts with the scorer's owned candidate buffer. Behavioral tests cover ordering, serialization and exact pruning.

## Rust

Clippy's full `all`, `pedantic` and `nursery` groups are fatal on all native targets/features and separately on the release WASM library. There are no per-file exemptions or source suppressions. Unsafe code, truncating casts, integer-to-float precision-loss casts, unwrap, expect, panic and placeholders have `forbid` levels. Matching lint expectations cannot lower those levels. Additional restrictions reject error erasure, discarded results, leaks, process exit and oversized stack allocations. Compiler lints reject ignored results, unused lifetimes/qualifications, unreachable exports and unmet lint expectations. Release arithmetic retains overflow checks.

Wire lengths, rows, positions, posting frequencies and bloom indices use checked conversions. Full-width statistics convert through explicit 32-bit limbs; numeric regressions cover rounding boundaries and `u64::MAX`. BM25 uses fused multiply-add and `ln_1p`; an independent exhaustive scorer checks exact pruning and ranking. Parser and WASM errors return declared failures. Public fallible Rust exports document their errors through native documentation attributes.

Executable rejection probes verify the installed tools, including valid Effect code, compiler-only Effect diagnostics, strict booleans, type errors, promises, syntax restrictions, Rust safety and forbidden cast suppressions. Ranking quality and local benchmarks have separate evidence in [quality](quality.md) and [performance methodology](turbopuffer-contracts.md). This gate enforces concrete rules; it does not establish every architectural property or eliminate every possible panic, allocation or bounds failure by static analysis alone.
