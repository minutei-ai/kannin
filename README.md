# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · client in Brazil · edge reads with acknowledged sequence barrier**

| Concurrency | p50 ms |  p95 ms | Requests/s |
| ----------: | -----: | ------: | ---------: |
|           1 |  62.51 |  111.80 |      11.26 |
|           4 |  63.97 |  864.83 |      25.18 |
|          16 |  91.00 | 1170.34 |      36.88 |

The latest deployed candidate preserved strong baseline rows, scores and sequence in all **384 standard load responses**, with GRU in their `CF-Ray` suffixes. Its maximum request took **2.16 s**. The Rust directory decoder reduced local median decoding time by **11.9–12.8%** by reusing a validated CRC; DF-proven sparse batching reduced a paired injected-delay workerd median by **19.9%** versus the preceding scheduler. Native sparse probes retained twelve posting ranges, with three later edge responses improving and the first regressing; this load run does not establish a uniform end-to-end native speedup. Earlier sixteen-rare-term probes preserved complete strong/edge equality but included a **7.04 s** edge query, with **5.22 s** preparing rankers and acquiring their directories. These phases reuse caches and do not establish independent concurrency scaling, peak memory or general Turbopuffer parity.

Rust now preserves document-length correlation in disposable R2 score summaries. Six fresh strong plans over the unchanged 200-segment corpus ranked **3 segments instead of 200**, preserving complete rows and scores. After alternate-mode warmups, elapsed queries changed **6.17–7.61 seconds→0.29–2.06 seconds**, a **67–96%** reduction in those samples. The first alternate-mode warmup still took **5.10 seconds**. Cache loss recovers through canonical R2; cold catalog acquisition remains a bottleneck. [Measurements and limits](docs/performance.md#correlated-length-bounds-on-immutable-segments).

Catalog acquisition now overlaps four R2 summary reads per window, with a shared body budget. A measured 16-summary strong request changed **2.67→1.51 seconds**, while its edge counterpart regressed **5.62→5.93 seconds** amid slow Cache API access. Snapshot cache lookups have a **250 ms** foreground budget; canonical edge snapshot acquisition has a shared **900 ms** budget before coordinator recovery. Shared text plans publish through native `waitUntil`, so optional cache writes no longer block row delivery. Small immutable ranges can recover from a slow cached binding through R2, with bounded concurrency and explicit fallback counters. [Experiment and cache tails](docs/performance.md#catalog-acquisition-and-snapshot-cache-wait).

An additional sixteen-rare-term edge query reached its 30-second lease limit and returned HTTP 504; an identical retry succeeded. Broad-query cold failures remain unresolved.

Independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10**, with the complete 300-query report unchanged. Native Vectorize checks across three existing 100-vector namespaces preserved all 105 returned rows and scores across twelve vector/hybrid queries before and after deployment. A separate three-vector ingestion became fully visible on the fifteenth observation, approximately 33 seconds after synchronization, and passed unfiltered, equality, numeric and hybrid checks before cleanup. These small controlled fixtures do not establish large-corpus ANN recall.

An earlier sequential million-document comparison measured p50 **159–173 ms strong**, **40–55 ms edge** and **59–81 ms Turbopuffer strong**. The comparator processed 14,500 unindexed WAL rows; edge has a weaker freshness contract. A fully indexed comparison remains unverified.

[Native and local methodology](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **199 Worker/tooling tests and 38 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
