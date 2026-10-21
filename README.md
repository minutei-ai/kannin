# Kannin

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP transport.

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

Segments now record a bounded proof of attributes shared by every document. Filters that match that proof can use existing exact common-term leaders without loading the full filter catalog. On a local 30,000-document, thirty-segment corpus:

| Rich-attribute workload        | State         | Before median (ms) | Current median (ms) |
| ------------------------------ | ------------- | -----------------: | ------------------: |
| Dense any + uniform filter     | prepared cold |              486.8 |               178.7 |
| Dense all + uniform filter     | prepared cold |              473.8 |               177.6 |
| Phrase + uniform filter        | prepared cold |              499.1 |               350.1 |
| 64 rare terms + uniform filter | prepared cold |             1103.9 |              1030.9 |
| Dense any + uniform filter     | warm          |               31.7 |                17.4 |

Two alternating paired cohorts use a fixed logical CPU, a two-GiB cap and no swap. Cold reads start with empty process/Cache API state; backend/filesystem caches may remain warm. All **832 complete responses match across 416 pairs**, including unfiltered and selective controls. Dense-any prepared cold workerd high-water falls **134.5 → 127.3 MiB**; rare-query high-water rises **153.0 → 156.9 MiB**. These local emulation measurements do not establish Cloudflare isolate heap. [Methods, all workloads and write costs](docs/performance.md#uniform-segment-filter-proofs).

**The general 200 ms cold / 100 ms warm targets remain unmet.** Rich dense cold reads with missing derivatives still reach 248.6 ms, phrases reach 537.9 ms, and rare reads exceed one second. A million-document query returning all 64 rare matches still takes about 281 ms warm. Selective filters retain the ordinary catalog path. The earlier million-document fixture has variable attributes; this experiment does not establish a gain there. [Million-document results](docs/performance.md#bounded-filter-row-reuse-and-benchmark-coverage).

The preceding header projection reduced headers **50.2 → 3.1 MB** and total segment storage **54.9 → 7.8 MB** when large attributes were not selected for filtering. Full document/posting payloads remain intact. [Projection measurements](docs/performance.md#namespace-header-projection).

Earlier unfiltered synthetic controls observed common-query medians **139–146 ms** and maxima **161–184 ms** across eight fresh candidate processes with two CPUs. Those workloads and capacity differ from the table above; this is not a general bound or a Cloudflare result. [Capacity control](docs/performance.md#exact-minimum-length-document-indexes).

An ASCII normalization path makes the isolated Rust/WASM tokenizer **2.2–3.8× faster** in paired controls while retaining Unicode word segmentation. End-to-end cold results remain mixed; this does not establish a general search latency gain. [Tokenizer and ingestion controls](docs/performance.md#native-ascii-normalization).

Parallel ranking now tries validated R2 directory frames before the internal cache service, preserving compressed-cache admission and native recovery. On a separate lean 30,000-document control, rare prepared cold medians fall **1,054 → 820 ms**, warm **54.4 → 52.0 ms**, and workerd HWM **165.2 → 160.8 MiB**. Restart results after derivative loss remain mixed. [Full paired controls](docs/performance.md#r2-first-parallel-directory-acquisition).

[Uniform attribute proofs now also cover ordinary postings and phrases](docs/performance.md#uniform-facts-in-posting-rankers). A paired 5,000-document WASM control reduces cold directory-plus-ranker preparation CPU about 38%; complete-query latency and RSS remain mixed. No cache quota increases.

[Reusable overview attributes](docs/performance.md#reusable-overview-attributes) reduce isolated filtered projection CPU about 8% on four fixed frames. A separate million-document workerd matrix preserves all 144 responses across 72 exact pairs; complete-query latency and RSS remain mixed.

[Physical phrase-frequency bounds](docs/performance.md#physical-phrase-frequency-bounds) now reject impossible repeated phrases directly from the canonical manifest. On a local million-document empty-phrase control, cold median changes **14,050.8 → 147.8 ms**, warm **10.1 → 5.9 ms**, and warm workerd RSS **364.4 → 150.9 MiB**. This is a specific empty-result shortcut; positive and selective controls still exceed the general targets. Existing [zero-score certificates](docs/performance.md#zero-score-certificates) also skip segments proved empty by earlier scoring.

Rust `zlib-rs` handles directory and page inflation without changing persisted bytes or cache limits; immutable frames also [reuse successful header validation](docs/performance.md#immutable-header-validation-reuse). [Directory controls](docs/performance.md#native-zlib-directory-inflation) record mean warm workerd CPU **268.8 → 257.5 ms**. The newer [page control](docs/performance.md#fixed-size-page-inflation) reduces isolated projection CPU about **14%** and retained WASM linear-memory capacity **1.75 → 1.56 MiB**. Neither isolated measurements nor earlier mixed cold/RSS results establish a general latency bound.

[Native document ID ordering](docs/performance.md#native-document-id-ordering) preserves UTF-16 order while reducing isolated WASM directory-lookup CPU **26–33%** for three ASCII ID distributions. Two Unicode controls cost **4–5% more**; isolated WASM capacity stays unchanged. The SDK binding matrix preserves **144 responses across 72 exact pairs**; complete-query latency and RSS remain mixed.

Five complete public BEIR test splits cover **3,677 queries**: SciFact **0.6731**, NFCorpus **0.3068**, ArguAna **0.4064**, SCIDOCS **0.1583** and FiQA **0.2378 nDCG@10**. NIST trec_eval independently confirmed NFCorpus, ArguAna, SCIDOCS and FiQA aggregates. [Collection metrics and reproduction](docs/quality.md). Local Vectorize fixtures do not prove provider recall.

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

The suite contains **336 Worker/tooling tests and 66 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Declare `schema.filterable` per namespace and its ordered `schema.vectorFilterFields` subset on a write; undeclared filter attributes are rejected. The schema is persisted in R2 and changing it requires reset/reimport. Configured writes keep only declared filter attributes in segment headers; complete attributes stay in document payloads and returned rows. BM25 currently indexes fixed `title` and `text` fields; arbitrary full-text attribute indexing remains unimplemented. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [search research](docs/search-research.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
