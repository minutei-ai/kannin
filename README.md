# Kannin

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP transport.

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

Separate native Cloudflare experiments, with GRU ingress:

| Workload                                                             |                       Corpus |         Before → after |
| -------------------------------------------------------------------- | ---------------------------: | ---------------------: |
| First strong query after derived-cache loss                          | 4,000 documents / 8 segments | 2,786.88 → 1,911.42 ms |
| Document materialization after a neighboring read, warm coordinator  |              4,000 documents |            302 → <1 ms |
| Document materialization after a neighboring read, coordinator reset |              4,000 documents |             290 → 4 ms |
| Ordinary bulk deletion                                               |              1,000 documents |  100.57 → 2.01 seconds |

Small-header recovery overlaps two acquisitions only up to 64 KiB. In the earlier table's three fresh namespaces per version, metadata acquisition fell **1,887 → 874 ms**, with all six first requests placed in EWR and all result rows, scores, attributes, revisions and sequences preserved. Larger headers retain serial recovery. [Native small-header measurements](docs/performance.md#small-header-recovery-overlap).

Local filter-evaluation reuse reduced million-document warm medians from **52 → 40 ms** for sixteen rare terms, **177 → 132 ms** for sixty-four rare terms, and **61–63 → 54–55 ms** for dense queries. All 640 paired responses matched. Cold results were mixed and recovery still takes seconds; a large-attribute control had a 3.3% preparation regression. This change has not been deployed to Cloudflare. [Local methods and limits](docs/performance.md#repeated-attribute-filter-evaluation).

Contiguous Rust term storage reduced the retained charge of seventeen directories by **9.85%**. In a separate million-document comparison, sixty-four rare-term warm queries changed **132 → 116 ms**, with all 640 paired responses identical. Dense medians were similar, and some first reads regressed. This local change has not been deployed. [Term-storage measurements](docs/performance.md#contiguous-term-text-in-rustwasm).

Directory compression now streams into its frame buffer using the existing codec. A 16 MiB repeated-byte compressor control removed an **8 MiB temporary allocation**, with identical compressed bytes. Complete-query timings remained mixed. [Compression measurements](docs/performance.md#directory-compression-without-a-scratch-buffer).

Rust now reuses physical attribute groups within a scoped recovery handle. In the controlled local million-document comparison with derived caches absent, dense first reads changed **4.90 → 4.59 seconds** and sixty-four rare terms **2.93 → 2.71 seconds**. The full 300-query SciFact report remained byte-identical. Native model-source CPU changed **116 → 102 ms** in three first-read observations per version, while native million-document warm HTTP medians increased **203–295 → 239–343 ms** with EWR → IAD placement. These samples do not prove a Cloudflare warm-latency improvement or lower total billing. [Recovery methods and limitations](docs/performance.md#scoped-attribute-group-reuse).

Immutable Rust directory frames reuse a successful CRC proof without skipping structural or memory-budget validation. In a local 30,000-document control with large unique attributes, warm medians changed **137 → 111 ms**; million-document and first-read results were mixed. All 896 complete comparison responses matched, and the SciFact report stayed identical. This change has not been deployed. [Frame-cache measurements](docs/performance.md#reusing-immutable-directory-frame-validation).

Native Base64 conversion for immutable summaries reduced local SciFact cold peak RSS **222 → 188 MiB** and cold latency **1,605 → 1,473 ms**. Results remain mixed: dense recovery peak RSS increased **325 → 338 MiB**, unique-attribute cold reads slowed about 61 ms, and the natural-language warm control slowed about 4 ms. The **200 ms cold-read target remains unmet**. [Subsequent Rust measurements](docs/performance.md#borrowed-canonical-json-term-keys) retain that limit and document further tradeoffs. [Cold-read and RSS measurements](docs/performance.md#native-base64-for-immutable-overview-sources).

Bounded frequent-term summaries in canonical R2 manifests reduced the local million-document unfiltered `cloudflare rust` cold median **1,644 → 395 ms** with prepared derivatives, and **4,601 → 711 ms** with derivatives absent. Cold RSS medians changed **197 → 165 MiB** and **272 → 177 MiB**. All 256 complete comparison responses matched. Filtered and rare-term results remained mixed; the **200 ms cold target is still unmet**. [Prefix measurements and limits](docs/performance.md#bounded-common-term-prefixes-in-canonical-manifests).

Document windows trade bounded read-ahead for reuse: local bulk mutations used **1,001 → 8 acquisitions** but **100 → 305 kB**. The deletion row has one native observation per version and different prior cache state/placement. Fully cold large-catalog recovery still takes seconds locally. [Read-ahead measurements](docs/performance.md#bounded-document-byte-windows).

An earlier edge load run at source `6c03e72`, using an acknowledged sequence barrier, checked 384 complete responses against a strong baseline:

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  51.70 | 136.69 |      14.26 |
|           4 |  53.89 | 291.66 |      42.04 |
|          16 |  61.75 | 468.78 |      90.26 |

Edge reads have weaker freshness than strong reads. These cache-sensitive observations are not sustained-capacity guarantees. Fully cold Cloudflare storage, cold-tail reliability, previous overload failures, peak whole-Worker heap and large-corpus ANN recall remain open. The experimental native container has not replaced production WASM. Earlier indexed comparisons measured Turbopuffer at 45–47 ms versus Kannin strong at 175–178 ms under different placement; parity is not established.

The entire 300-query SciFact report remains unchanged: **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10**.

[Measurements and experiments](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129. The WASM build enables SIMD, supported by Cloudflare Workers.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **313 Worker/tooling tests and 63 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [search research](docs/search-research.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
