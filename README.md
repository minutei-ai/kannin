# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · GRU ingress · warmed edge repeat with acknowledged sequence barrier**

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  58.08 | 188.80 |      11.49 |
|           4 |  59.39 | 233.64 |      34.29 |
|          16 |  62.49 | 396.34 |      92.63 |

Both post-deploy runs preserved strong baseline rows, scores and sequence in all **768 responses**, with GRU ingress and no coordinator fallback. The first run had p50 **52.00/53.89/67.76 ms** at concurrency 1/4/16; its maximum request took **854 ms**, versus **1.08 s** in the repeat. Small winning document selections now admit eight readers under a 64 KiB encoded-selection limit. Full-query results remain mixed across concurrency levels and sensitive to cache state; this does not establish a universal latency gain. [Full measurements](docs/performance.md#byte-dependent-document-materialization-concurrency).

Rust now carries document ranges directly through ranking. Six deployed queries returning fifty scattered documents changed from **3.12 to 1.75 seconds median**, about **44% lower**, with complete rows/scores preserved and directory reloads changing **50→0**. Both versions used GRU ingress, process-memory resets and warmed immutable sources. This is a measured workload gain, not general performance parity. [Method and limits](docs/performance.md#carrying-document-ranges-through-the-rust-ranker).

Small winning document selections now use eight readers when their encoded frames total at most 64 KiB; larger selections retain four. A controlled workerd delay model reduced eight-/fifty-document query medians by **40–41%** with exact results. Three native matched pairs changed document-phase median **472→367 ms**, with one pair slightly slower; migration-warmed directories confound the full-query comparison. [Method and limits](docs/performance.md#byte-dependent-document-materialization-concurrency).

A controlled workerd recovery now reads **139,941 compressed R2 bytes instead of 1,724,997 canonical header bytes**, preserving the exact data: **91.9% fewer bytes** in that path. A native 32-document fixture confirmed R2-frame reuse through the origin and direct recovery, then was reset to zero documents. Cache misses and failed publications still recover canonically; the extra lookup and indexing work are tradeoffs. [Measurements and limits](docs/performance.md#reusing-compressed-directory-frames-from-r2).

Rust now preserves document-length correlation in disposable R2 score summaries. Six fresh strong plans over the unchanged 200-segment corpus ranked **3 segments instead of 200**, preserving complete rows and scores. After alternate-mode warmups, elapsed queries changed **6.17–7.61 seconds→0.29–2.06 seconds**, a **67–96%** reduction in those samples. The first alternate-mode warmup still took **5.10 seconds**. Cache loss recovers through canonical R2; cold catalog acquisition remains a bottleneck. [Measurements and limits](docs/performance.md#correlated-length-bounds-on-immutable-segments).

Catalog acquisition now overlaps four R2 summary reads per window, with a shared body budget. A measured 16-summary strong request changed **2.67→1.51 seconds**, while its edge counterpart regressed **5.62→5.93 seconds** amid slow Cache API access. Snapshot cache lookups have a **250 ms** foreground budget; canonical edge snapshot acquisition has a shared **900 ms** budget before coordinator recovery. Shared text plans and immutable catalog overview batches publish through native `waitUntil`, so these optional cache writes no longer block row delivery. Small immutable ranges can recover from a slow cached binding through R2. Compressed headers up to two MiB can also start bounded R2 recovery after 250 ms while retaining the cache source; nonabortable losing bodies finish through native background work. Aggregate counters expose these extra reads and bytes. [Experiment and cache tails](docs/performance.md#catalog-acquisition-and-snapshot-cache-wait).

An additional sixteen-rare-term edge query reached its 30-second lease limit and returned HTTP 504; an identical retry succeeded. Broad-query cold failures remain unresolved.

Independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10**, with the complete 300-query report unchanged. Native Vectorize checks across three existing 100-vector namespaces preserved all 105 returned rows and scores across twelve vector/hybrid queries before and after deployment. A separate three-vector ingestion became fully visible on the fifteenth observation, approximately 33 seconds after synchronization, and passed unfiltered, equality, numeric and hybrid checks before cleanup. These small controlled fixtures do not establish large-corpus ANN recall.

Before the latest cache change, the fully indexed sequential million-document comparison measured p50 **175–178 ms strong**, **127–130 ms edge** and **45–47 ms Turbopuffer strong**. All 200 measured Turbopuffer responses reported zero unindexed rows. Kannin responses entered through MIA; Turbopuffer used `aws-sa-east-1`. Edge reads have a weaker freshness contract. These results show a performance gap, not parity. [Comparison method and limits](docs/performance.md#fully-indexed-million-document-comparison).

[Native and local methodology](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **227 Worker/tooling tests and 39 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
