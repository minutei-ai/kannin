# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · client in Brazil · edge reads with acknowledged sequence barrier**

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  60.09 | 526.21 |       7.93 |
|           4 |  63.13 | 432.11 |      25.82 |
|          16 | 110.42 | 806.83 |      26.62 |

Runtime `f1d5c6f`; latest of two complete post-deploy runs, 32 mixed queries per phase. All 192 edge responses matched strong rows and scores. Reusable overviews now compute exact filter minima from attribute groups; new selector/filter observations improved from **3.70–3.91 s** to **1.57–2.49 s** after warming. Isolate/cache/network state limits attribution. An earlier load failed the snapshot freshness guard; Cache API publication was moved off the read critical path and two subsequent loads passed. General first-use reliability and performance parity remain unverified.

The local million-document workload measured strong common/filtered p50 of **127/126 ms** across 2,000 uncompacted segments. These emulator results exclude native network latency. Independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10** across 300 queries. Eight native vector/hybrid fixture cases also retained exact rows and scores.

A separate operational Turbopuffer comparison measured **59–81 ms p50**, while the comparator still processed 15,000 unindexed documents. Fully indexed comparison and general parity remain unverified.

[Native and local measurements, regressions and methodology](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **116 Worker/tooling tests and 18 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
