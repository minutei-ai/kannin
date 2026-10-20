# Kannin

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP transport.

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

The latest paired local comparison uses one million documents across 200 segments, one CPU and a two-GiB memory cap with swap disabled. Warm samples change filter values on every request. Cold samples start a fresh workerd with empty process/Cache API state; filesystem and emulated R2 backend caches may remain warm.

| Workload                                 | State                      | Before median (ms) | Current median (ms) | Current observed maximum (ms) |
| ---------------------------------------- | -------------------------- | -----------------: | ------------------: | ----------------------------: |
| Filtered dense                           | warm                       |               56.9 |                57.8 |                          80.3 |
| 64 rare terms + filter                   | warm                       |              129.0 |                38.9 |                          51.5 |
| 64 rare terms, alternating filter fields | warm                       |              138.9 |                53.8 |                          68.8 |
| Filtered dense                           | cold, prepared derivatives |             1937.6 |              2050.9 |                        2287.1 |
| 64 rare terms + filter                   | cold, prepared derivatives |             1721.2 |              1913.4 |                        1966.4 |
| Filtered dense                           | cold, absent derivatives   |             6758.8 |              6043.6 |                        6114.6 |
| 64 rare terms + filter                   | cold, absent derivatives   |             3798.0 |              3712.2 |                        3723.1 |

**The general 200 ms cold / 100 ms warm targets remain unmet.** Warm rare-term median latency fell about 70%, and alternating-field workerd RSS high-water fell **245.5 → 234.8 MiB**. Dense warm latency is essentially unchanged; prepared cold latency regressed. All **288 complete responses matched across 144 pairs**. Linux process RSS includes emulator overhead and is not Cloudflare isolate heap. [Methods, budgets and tradeoffs](docs/performance.md#bounded-filter-row-reuse-and-benchmark-coverage).

Earlier unfiltered synthetic controls observed common-query medians **139–146 ms** and maxima **161–184 ms** across eight fresh candidate processes with two CPUs. Those workloads and capacity differ from the table above; this is not a general bound or a Cloudflare result. [Capacity control](docs/performance.md#exact-minimum-length-document-indexes).

Complete public BEIR test splits cover **2,029 queries**: SciFact **0.6731**, NFCorpus **0.3068**, ArguAna **0.4064 nDCG@10**. SciFact preserves all 300 result lists and per-query metrics. NIST trec_eval independently reproduced the graded NFCorpus and ArguAna aggregates. Local Vectorize fixtures do not prove provider recall.

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

The verified suite has **323 Worker/tooling tests and 63 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Declare `schema.filterable` per namespace and its ordered `schema.vectorFilterFields` subset on a write; undeclared filter attributes are rejected. The schema is persisted in R2 and changing it requires reset/reimport. BM25 currently indexes fixed `title` and `text` fields; arbitrary full-text attribute indexing remains unimplemented. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [search research](docs/search-research.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
