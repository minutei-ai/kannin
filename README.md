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

Rust now reuses physical attribute groups within a scoped recovery handle. In the controlled local million-document comparison with derived caches absent, dense first reads changed **4.90 → 4.59 seconds** and sixty-four rare terms **2.93 → 2.71 seconds**. The full 300-query SciFact report remained byte-identical. Native model-source CPU changed **116 → 102 ms** in three first-read observations per version, while native million-document warm HTTP medians increased **203–295 → 239–343 ms** with EWR → IAD placement. These samples do not prove a Cloudflare warm-latency improvement or lower total billing. [Recovery methods and limitations](docs/performance.md#scoped-attribute-group-reuse).

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

The verified suite has **304 Worker/tooling tests and 59 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
