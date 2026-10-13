# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**100,000 documents · local workerd · warm queries · milliseconds (p50 / p95)**

| Query     |        Strong | Edge eventual |
| --------- | ------------: | ------------: |
| Rare      |   3.46 / 4.45 |   2.99 / 6.02 |
| Selective | 23.87 / 30.14 | 23.12 / 30.51 |
| Common    | 25.80 / 32.46 | 28.33 / 52.58 |
| Filtered  | 26.60 / 33.69 | 26.69 / 32.74 |

Local ingestion: **100,000 documents in 22.18 seconds**, approximately **4,509 documents/s**, in batches of 500. Intel Xeon E5-2680 v4, Bun 1.4.3. Each case/mode has five warmups and 50 measured requests, including HTTP and response decoding. Both modes share one process; no query-result cache. Local timings exclude Cloudflare regional network latency.

Conjunctive segment pruning reduced local warm p50 from **14.11 to 6.83 ms** for `all` and **13.91 to 5.88 ms** for phrase queries in a separate 15,000-document, 30-segment workload. Impossible Bloom intersections avoid directory reads; exact live term frequencies avoid unnecessary postings. [Methodology and limits](docs/performance.md#conjunctive-query-pruning).

**100,000 documents · deployed Cloudflare · client in Brazil · milliseconds (p50 / p95)**

| Query     |        Strong | Edge eventual |
| --------- | ------------: | ------------: |
| Rare      | 165.3 / 194.8 |   53.4 / 77.2 |
| Selective | 172.0 / 187.2 |   63.8 / 87.1 |
| Common    | 181.6 / 196.7 |   68.7 / 95.7 |
| Filtered  | 177.4 / 189.7 |  68.2 / 102.1 |

These deployed measurements are from `faa310e`, before the latest warm-snapshot optimization, with the same five-warmup/50-sample methodology. Strong reads paid the coordinator hop outside Brazil. A separate mixed-query load run reached **45.4 requests/s at concurrency 16**, with **p95 1,090.5 ms**; all 384 responses matched strong baselines. Cold requests reached **3.4 seconds**. These results establish bounded measurements, not general Turbopuffer parity or million-document scale.

The latest conjunctive runtime passed 12 native before/after result comparisons. A first common edge query still took **4.8 seconds**; cold directory acquisition remains unresolved.

[Full deployed evidence](docs/performance.md) · [local methodology and contract comparison](docs/turbopuffer-contracts.md) · [SciFact ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **92 Worker/tooling tests and 17 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
