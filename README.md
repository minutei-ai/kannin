# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · MRS responses · edge reads with acknowledged sequence barrier**

| Concurrency | p50 ms |  p95 ms | Requests/s |
| ----------: | -----: | ------: | ---------: |
|           1 | 195.80 |  237.41 |       3.39 |
|           4 | 246.38 |  714.47 |      12.17 |
|          16 | 248.60 | 1138.99 |      31.48 |

The latest deployed candidate preserved strong baseline rows, scores and sequence in all **384 standard load responses**, with MRS in their `CF-Ray` suffixes. Its maximum request took **5.31 s**. Earlier runs used EWR/MIA and GRU; these region and cache differences prevent attributing the new timing changes to the latest code. Local workerd measurements reduced dense seeded span-selection batch time by **65.7%** on a warmed repeated-length fixture; the warmed high-diversity filtered fixture was **1.6% slower**. Shorter warmup showed a larger regression in that fixture. These are CPU-phase measurements, not native end-to-end gains. Cold acquisition, peak memory and comparable-region performance parity remain open. [Measurements and limits](docs/performance.md#reusing-dense-seed-scores-by-document-length).

Rust now preserves document-length correlation in disposable R2 score summaries. Six fresh strong plans over the unchanged 200-segment corpus ranked **3 segments instead of 200**, preserving complete rows and scores. After alternate-mode warmups, elapsed queries changed **6.17–7.61 seconds→0.29–2.06 seconds**, a **67–96%** reduction in those samples. The first alternate-mode warmup still took **5.10 seconds**. Cache loss recovers through canonical R2; cold catalog acquisition remains a bottleneck. [Measurements and limits](docs/performance.md#correlated-length-bounds-on-immutable-segments).

Catalog acquisition now overlaps four R2 summary reads per window, with a shared body budget. A measured 16-summary strong request changed **2.67→1.51 seconds**, while its edge counterpart regressed **5.62→5.93 seconds** amid slow Cache API access. Snapshot cache lookups have a **250 ms** foreground budget; canonical edge snapshot acquisition has a shared **900 ms** budget before coordinator recovery. Shared text plans and immutable catalog overview batches publish through native `waitUntil`, so these optional cache writes no longer block row delivery. Small immutable ranges can recover from a slow cached binding through R2. Compressed headers up to two MiB can also start bounded R2 recovery after 250 ms while retaining the cache source; nonabortable losing bodies finish through native background work. Aggregate counters expose these extra reads and bytes. [Experiment and cache tails](docs/performance.md#catalog-acquisition-and-snapshot-cache-wait).

An additional sixteen-rare-term edge query reached its 30-second lease limit and returned HTTP 504; an identical retry succeeded. Broad-query cold failures remain unresolved.

Independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10**, with the complete 300-query report unchanged. Native Vectorize checks across three existing 100-vector namespaces preserved all 105 returned rows and scores across twelve vector/hybrid queries before and after deployment. A separate three-vector ingestion became fully visible on the fifteenth observation, approximately 33 seconds after synchronization, and passed unfiltered, equality, numeric and hybrid checks before cleanup. These small controlled fixtures do not establish large-corpus ANN recall.

The fully indexed sequential million-document comparison measured p50 **175–178 ms strong**, **127–130 ms edge** and **45–47 ms Turbopuffer strong**. All 200 measured Turbopuffer responses reported zero unindexed rows. Kannin responses entered through MIA; Turbopuffer used `aws-sa-east-1`. Edge reads have a weaker freshness contract. These results show a performance gap, not parity. [Comparison method and limits](docs/performance.md#fully-indexed-million-document-comparison).

[Native and local methodology](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **207 Worker/tooling tests and 39 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
