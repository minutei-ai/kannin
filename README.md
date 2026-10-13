# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**100,000 documents · local workerd · warm queries · milliseconds (p50 / p95)**

| Query     |         Strong | Edge eventual |
| --------- | -------------: | ------------: |
| Rare      |    4.39 / 5.35 |   3.19 / 5.50 |
| Selective |  35.72 / 48.34 | 36.72 / 54.38 |
| Common    |  37.68 / 50.09 | 39.38 / 54.62 |
| Filtered  | 46.35 / 120.67 | 43.55 / 58.72 |

Local ingestion: **100,000 documents in 25.35 seconds**, approximately **3,945 documents/s**, in batches of 500. Intel Xeon E5-2680 v4, Bun 1.4.3. Each case/mode has five warmups and 50 measured requests, including HTTP and response decoding. Both modes share one process; no query-result cache. Local timings exclude Cloudflare regional network latency.

**100,000 documents · deployed Cloudflare · client in Brazil · milliseconds (p50 / p95)**

| Query     |        Strong | Edge eventual |
| --------- | ------------: | ------------: |
| Rare      | 165.3 / 194.8 |   53.4 / 77.2 |
| Selective | 172.0 / 187.2 |   63.8 / 87.1 |
| Common    | 181.6 / 196.7 |   68.7 / 95.7 |
| Filtered  | 177.4 / 189.7 |  68.2 / 102.1 |

These deployed measurements are from `faa310e`, before the latest warm-snapshot optimization, with the same five-warmup/50-sample methodology. Strong reads paid the coordinator hop outside Brazil. A separate mixed-query load run reached **45.4 requests/s at concurrency 16**, with **p95 1,090.5 ms**; all 384 responses matched strong baselines. Cold requests reached **3.4 seconds**. These results establish bounded measurements, not general Turbopuffer parity or million-document scale.

[Full deployed evidence](docs/performance.md) · [local methodology and contract comparison](docs/turbopuffer-contracts.md) · [SciFact ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **80 Worker/tooling tests and 15 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, native and WASM Clippy, typechecking and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
