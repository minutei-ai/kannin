# Kannin

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP transport.

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

Current local results use one million documents across 200 segments, four paired fresh-workerd cohorts, one CPU and empty process/Cache API state. R2 derivatives are either prepared or redirected to absent keys. Filesystem/backend caches may remain warm. RSS is Linux workerd high-water, not Cloudflare isolate heap.

| Query           | R2 derivatives | Cold median (ms) | Observed maximum (ms) | RSS median (MiB) |
| --------------- | -------------- | ---------------: | --------------------: | ---------------: |
| cloudflare rust | prepared       |            224.8 |                 254.4 |            158.7 |
| cloudflare rust | absent         |            225.0 |                 232.7 |            156.9 |
| rust            | prepared       |            189.8 |                 238.7 |            156.6 |
| rust            | absent         |            191.5 |                 228.6 |            157.6 |
| Filtered dense  | prepared       |           2069.2 |                2095.2 |            221.0 |
| Filtered dense  | absent         |           5087.8 |                5146.5 |            301.3 |
| 64 rare terms   | prepared       |           1410.8 |                1649.4 |            221.9 |
| 64 rare terms   | absent         |           3142.7 |                3254.3 |            273.0 |

**The 200 ms maximum cold-read target is not met.** Bounded canonical summaries and minimum-length indexes reduced common missing-cache medians **734 → 225 ms** and RSS **178 → 157 MiB**. All 256 complete comparison responses matched. Results elsewhere remain mixed: rare recovery peak RSS increased about 17 MiB. [Methods, before/after data and limits](docs/performance.md#exact-minimum-length-document-indexes).

With the same code/data and absent derivatives, a separate **two-CPU, two-GiB** control observed common-query medians **139–146 ms** and maxima **161–184 ms** across eight fresh candidate processes. All 64 paired-control responses matched. This meets 200 ms only for those sampled unfiltered workloads under that capacity limit; rare/filtered queries and Cloudflare remain outside that result. [Capacity control](docs/performance.md#exact-minimum-length-document-indexes).

The 300-query SciFact report remains byte-identical: **0.6731 nDCG@10**, **0.7957 recall@10**, **0.6418 MRR@10**. Local Vectorize fixtures do not prove provider recall.

This change has not been deployed to Cloudflare. An earlier native experiment with GRU ingress reduced first strong reads after derived-cache loss **2,786.88 → 1,911.42 ms** on 4,000 documents/eight segments, with EWR query placement. These conditions differ from the local table. [Native measurements](docs/performance.md#small-header-recovery-overlap).

Native cold-tail reliability, whole-Worker heap, large-corpus ANN recall and sustained capacity remain open. Edge reads have weaker freshness than strong reads. Earlier indexed comparisons measured Turbopuffer at 45–47 ms versus Kannin strong at 175–178 ms under different placement; parity is not established.

[Measurement history](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129. The WASM build enables SIMD, supported by Cloudflare Workers.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **315 Worker/tooling tests and 63 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [search research](docs/search-research.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
