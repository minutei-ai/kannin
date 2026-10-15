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
|           1 |  52.09 |  89.35 |      13.92 |
|           4 |  52.88 | 148.09 |      39.57 |
|          16 |  61.13 | 715.18 |      74.17 |

Each 128-request phase covers rare, selective, common and filtered text queries. All **384 responses** in this revision matched strong rows/scores and sequence. The preceding process-plan revision measured concurrency-one p95 of 175.86 ms and concurrency-sixteen p95 of 591.15 ms: the former improved here, while the latter regressed to 715.18 ms. Earlier compressed-directory runs also verified 768 responses. An earlier revision timed out on a common query at concurrency sixteen. These successful runs do not establish concurrent reliability. Page pruning reduced native common-query acquisition from **178 to 22 blocks** and filtered acquisition from **188 to 41 blocks**, including cache hits. Native placement, cache state and network conditions vary; uniform latency gains, peak memory and general Turbopuffer parity remain unverified.

Dense eight-term/phrase selections first measured **6.25/5.25 seconds strong** and **10.48/8.55 seconds edge**. Five further sequential repetitions measured strong medians of **203/202 ms** and edge medians of **139/122 ms**; all ranked three segments, with an edge maximum of **1.46 s**. Two edge requests recovered shared plans with zero learned bounds in process memory and still pruned 200 segments to three. Separate dense loads at concurrency one/four/sixteen retained all 48 exact responses, including thirteen further shared-plan recoveries. The sixteen-request burst had p50 **1.10 s**, so concurrent latency remains open. These bounded samples do not establish uniformly fast first selections or long-term concurrent reliability. [Detailed measurements and limits](docs/performance.md#sharing-versioned-conservative-plans-through-cache-api).

The local million-document workload measured strong common/filtered p50 of **127/126 ms** across 2,000 uncompacted segments. These emulator results exclude native network latency. The repeated independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10** across 300 queries. The latest native Vectorize visibility probe remained empty through its bounded polling window; current provider-backed vector/hybrid validation remains pending.

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

The verified suite has **170 Worker/tooling tests and 36 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
