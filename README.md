# Kannin

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP transport.

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · GRU ingress.**

Binary derived directory caches reduce compressed directory bytes **19.8%**. Over the same local million-document index, median first reads improved **16–20%** for rare terms with prepared caches and **20–25%** with only directory caches preserved. All **96 complete responses** matched; dense queries with total cache loss stayed effectively unchanged. [Methods](docs/performance.md#binary-derived-directory-caches). The deployed version preserved **64 native responses**; placement changed during measurement, so native latency cannot be attributed solely to the codec.

Newly written and recompacted segments use smaller canonical headers. A controlled local comparison over one million documents kept the same 200 segments and payloads while reducing header bytes **352 → 123 MB** and total segment bytes **531 → 302 MB**. With derived caches initially absent, median first-read latency changed **3356 → 2635 ms** for sixty-four rare terms and **5730 → 4454 ms** for a dense filtered query: about **22% lower**. All **88 complete responses** across cold, prepared-cache and previous-reader controls matched. Prepared-cache latency was mixed. These are local measurements, not fully cold Cloudflare storage guarantees. [Methods](docs/performance.md#compact-canonical-header-writer).

The existing native reader accepts both header layouts. Public metadata and posting/document payloads are unchanged; deployment preserves existing immutable objects. Normal writes and compaction emit the compact layout. Canonical recovery retains its **8 MiB** raw-header admission budget and reuses surviving compressed R2 directories.

The deployed Smart Placement version preserved **64 complete responses** on the existing Cloudflare index. A fresh native canary confirmed compact headers **6.96 → 2.36 MB**, unchanged payload size and all 32 returned rows. Native latency did not establish a speedup. [Native validation](docs/performance.md#native-validation-of-compact-canonical-writes).

An earlier deployed Rust change reduced warm Durable Object CPU medians **39.5 → 4 ms** and **102 → 80.5 ms** for sixteen/sixty-four rare terms. [Native measurements](docs/performance.md#cloudflare-validation-of-compact-retained-directories).

An earlier edge load run at source `6c03e72`, using an acknowledged sequence barrier, checked 384 complete responses against a strong baseline:

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  51.70 | 136.69 |      14.26 |
|           4 |  53.89 | 291.66 |      42.04 |
|          16 |  61.75 | 468.78 |      90.26 |

Edge reads have weaker freshness than strong reads. These cache-sensitive observations are not sustained-capacity guarantees. Fully cold Cloudflare storage, cold-tail reliability, previous overload failures, peak whole-Worker heap and large-corpus ANN recall remain open. The experimental native container has not replaced production WASM. Earlier indexed comparisons measured Turbopuffer at 45–47 ms versus Kannin strong at 175–178 ms under different placement; parity is not established.

The entire 300-query SciFact report remains unchanged: **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10**.

[Measurements and experiments](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129. The WASM build enables SIMD, supported by Cloudflare Workers.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **289 Worker/tooling tests and 59 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
