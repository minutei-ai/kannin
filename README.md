# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · GRU ingress.**

The latest Rust change keeps immutable directories compact within the existing 20 MiB decoded cache. In a strong-query probe with namespace memory cleared before every query, sixty-four rare terms measured HTTP median **711 → 614 ms** and paired Durable Object CPU **365 → 281 ms**. Sixteen terms stayed at **487 ms HTTP**, while CPU fell **182.5 → 154 ms**. Dense group 72 improved; group 43 regressed in HTTP latency. Each HTTP cell has six observations; CPU has five or six matched pairs. Other Cloudflare caches and R2 could remain warm. [Methods, controls and tradeoffs](docs/performance.md#cloudflare-validation-of-compact-retained-directories).

With repeated fixed strong selectors, native Durable Object CPU medians changed **39.5 → 4 ms** for sixteen rare terms and **102 → 80.5 ms** for sixty-four, with twelve measured observations per cell. All **224 complete responses** across warm and cold-memory cohorts matched. Local WASM linear-memory high-water increased **27.3 → 31.6 MB**; these CPU gains do not establish lower whole-Worker memory or total billing.

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

The verified suite has **276 Worker/tooling tests and 53 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
