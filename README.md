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
|           1 |  45.55 |  62.79 |      18.36 |
|           4 |  49.86 | 318.35 |      44.82 |
|          16 |  62.19 | 487.09 |      92.77 |

A post-deploy run checked **384 responses** against strong baseline rows, scores and sequence, with 128 requests per concurrency. All entered through GRU without snapshot coordinator fallback. A separate 64-query probe with fresh selectors preserved complete pre-deploy results. These are cache-sensitive workload observations, not sustained-capacity guarantees. Edge freshness is weaker than strong consistency.

Catalog reads refill four concurrent tasks and project resident overviews before consulting the selector Cache API. A controlled local R2-delay experiment reduced complete-query median from 1,724 to 821 ms; this is not a native Cloudflare speedup claim. Optional shared-plan lookups recover through catalog acquisition after a nominal 250 ms cache budget. Rust builds term dictionaries in bulk, reuses posting validation against exact retained headers and avoids software fused arithmetic for the fixed BM25 title weight. Isolated workerd gains and regressions are [documented](docs/performance.md); repeated complete-Worker measurements did not establish consistent end-to-end gains.

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

The verified suite has **239 Worker/tooling tests and 42 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
