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
|           1 |  48.23 |  81.97 |      15.01 |
|           4 |  53.53 | 156.30 |      23.74 |
|          16 |  70.95 | 905.33 |      65.89 |

Each 128-request phase covers rare, selective, common and filtered text queries. All **384 responses** matched their strong rows/scores and sequence. The preceding implementation's latest run measured p95 **83.28/111.87/784.07 ms**. The current concurrency-four phase included a **4.17-second** outlier whose timings showed slow R2 snapshot acquisition followed by coordinator fallback. These bounded runs do not isolate placement, cache or network variation and do not establish concurrent reliability, peak memory or general Turbopuffer parity.

Strong queries capture an immutable root under the coordinator lock, then run up to four at a time while writes continue. Identical text requests against the same captured root now share active ranking and materialization; the entry ends with the calculation. In four paired native bursts of four identical requests, ranked segment visits fell from **800 to 200 per burst**, preserving all complete rows/scores. Burst completion changed **11.1–12.6 seconds→8.0–9.7 seconds**, a **13–37%** reduction in those samples after warming immutable inputs. [Active-query measurements](docs/performance.md#sharing-active-coordinator-text-evaluations).

Dense first-use search remains multi-second. Two sequential edge selections took **11.76/6.68 seconds**; a subsequent sixteen-request mixed strong/edge burst preserved every reference with p95 **2.12 seconds**. Its producers ranked three segments and three coordinator requests joined active work. Plans also reuse Rust-normalized equivalent selections across case, accents and any/all token order. These optimizations cover repeated or overlapping work; cold acquisition and concurrent tails remain unresolved.

The local million-document workload measured strong common/filtered p50 of **127/126 ms** across 2,000 uncompacted segments. Separate paired 50,000-document tests of deduplicated Rust score envelopes improved medians by **6–10%**. Emulator results exclude native network latency. Independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10** across 300 queries. The latest native Vectorize visibility probe remained empty through its bounded polling window; current provider-backed vector/hybrid validation remains pending.

A sequential million-document comparison measured p50 of **159–173 ms strong**, **40–55 ms edge** and **59–81 ms Turbopuffer strong**. The comparator processed 14,500 unindexed WAL rows; edge has a weaker freshness contract. Fully indexed comparison and general parity remain unverified.

[Native and local measurements, regressions and methodology](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **182 Worker/tooling tests and 36 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
