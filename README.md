# Kannin

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP transport.

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

Configured namespaces now keep only declared filter attributes in new segment headers. On a local 30,000-document corpus with large unselected attributes, headers shrink **50.2 → 3.1 MB**, and complete segment storage **54.9 → 7.8 MB**. Complete document/posting payloads remain identical. A control where every attribute is declared preserves complete segment bytes.

| Rich-attribute workload | State                  | Before median (ms) | Current median (ms) |
| ----------------------- | ---------------------- | -----------------: | ------------------: |
| 64 rare terms + filter  | prepared cold          |             2020.4 |              1189.6 |
| Dense all + filter      | prepared cold          |              944.2 |               541.7 |
| Phrase + filter         | prepared cold          |              855.3 |               557.0 |
| 64 rare terms + filter  | absent-derivative cold |             2932.1 |              1046.3 |
| 64 rare terms + filter  | warm                   |              131.1 |                37.2 |

Two alternating paired cohorts use thirty segments, a fixed logical CPU, a two-GiB cap and no swap. Process/Cache API state is empty for cold reads; backend/filesystem caches may remain warm. All **640 complete responses match across 320 pairs**. Rare recovery workerd RSS high-water falls **226 → 158 MiB**; this includes local emulation and is not Cloudflare isolate heap. [All workloads, methods and tradeoffs](docs/performance.md#namespace-header-projection).

**The general 200 ms cold / 100 ms warm targets remain unmet.** Cold reads still exceed one second in some workloads; phrase warm maximum reaches 177.8 ms. Dense warm results and controls without discarded attributes remain mixed. The earlier million-document fixture already contains only its declared attributes, so this reduction does not establish a gain there. [Million-document results](docs/performance.md#bounded-filter-row-reuse-and-benchmark-coverage).

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

The verified suite has **324 Worker/tooling tests and 64 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Declare `schema.filterable` per namespace and its ordered `schema.vectorFilterFields` subset on a write; undeclared filter attributes are rejected. The schema is persisted in R2 and changing it requires reset/reimport. Configured writes keep only declared filter attributes in segment headers; complete attributes stay in document payloads and returned rows. BM25 currently indexes fixed `title` and `text` fields; arbitrary full-text attribute indexing remains unimplemented. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [search research](docs/search-research.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
