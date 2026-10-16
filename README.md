# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · GRU ingress · edge queries with an acknowledged sequence barrier**

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  51.70 | 136.69 |      14.26 |
|           4 |  53.89 | 291.66 |      42.04 |
|          16 |  61.75 | 468.78 |      90.26 |

The load run at source `6c03e72` checked **384 responses** against strong baseline rows, scores and sequence, with 128 requests per concurrency. All entered through GRU without snapshot coordinator fallback. Two 16-query probes with fresh selectors preserved complete pre-deploy results. These are cache-sensitive workload observations, not sustained-capacity guarantees. Edge freshness is weaker than strong consistency.

Catalog acquisition now uses eight-source batches: a sixteen-source envelope exceeded both publication limits and could never be cached as a batch. The two smaller frames are persisted in R2. On a one-million-document changing-filter workload, measured individual overview reads fell from sixteen in 11/24 baseline responses to zero in 48/48 post-deploy responses. Native p50/p95 was **649/966 ms before**, **659/912 ms after**, and **615/796 ms on repetition**. These sequential, cache-sensitive cohorts do not establish a uniform median gain or sustained capacity. [Detailed measurements](docs/performance.md) include the local experiments and remaining limits.

Independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10**, with the entire 300-query report unchanged. Twelve native Vectorize/hybrid checks preserved 105 complete rows and scores across three 100-vector fixtures; large-corpus ANN recall remains unmeasured.

Cold broad queries have reached the 30-second edge lease in earlier trials. Peak whole-Worker heap and cold-tail reliability remain open. The earlier fully indexed sequential comparison measured p50 **175–178 ms strong**, **127–130 ms edge** and **45–47 ms Turbopuffer strong**, with Kannin ingress in MIA and Turbopuffer in `aws-sa-east-1`. Different placement and consistency prevent a parity claim.

[Measurements and earlier optimizations](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **253 Worker/tooling tests and 42 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
