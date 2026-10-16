# Kannin

BM25, vector and hybrid search on Cloudflare Workers. R2 owns documents and indexes; Rust/WASM handles lexical ranking; TypeScript + Effect owns contracts and operations; Vectorize handles vectors. Alchemy deploys the stack with Smart Placement. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Performance

**1,000,000 documents · deployed Cloudflare · GRU ingress · edge queries with an acknowledged sequence barrier**

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  51.70 | 136.69 |      14.26 |
|           4 |  53.89 | 291.66 |      42.04 |
|          16 |  61.75 | 468.78 |      90.26 |

The load run at source `6c03e72` checked **384 responses** against strong baseline rows, scores and sequence, with 128 requests per concurrency. All entered through GRU without snapshot coordinator fallback. Two 16-query probes with fresh selectors preserved complete pre-deploy results. These are cache-sensitive workload observations, not sustained-capacity guarantees. Edge freshness is weaker than strong consistency.

Current strong-query probes use one million documents, GRU ingress and Smart Placement observed as `remote-MIA`. A fresh missing-field selector forces metadata acquisition; the eight-term control reuses that round's field model. Physical overview caches can stay warm.

| Strong sequential query            | Before p50/p95 ms | Latest repeat p50/p95 ms |
| ---------------------------------- | ----------------: | -----------------------: |
| Fresh metadata selector, two terms |  787.38 / 1053.99 |         732.19 / 1017.82 |
| Warm metadata, eight terms         |   331.85 / 454.66 |          339.67 / 476.96 |

Source `d3caa42` removes a duplicate exact catalog cache and retains native Workers Cache. Its first post-deploy cohort was slower (796.96/1158.96 ms and 362.45/513.92 ms); the table shows its repeat. Each cohort measured twelve responses per selector after two warmup rounds, with identical complete results. A separate 100-pair workerd comparison after memory eviction reduced p50 from **121.55 to 87.61 ms**. These results do not establish fully cold R2 latency or a universal native gain. [Detailed measurements](docs/performance.md#removing-the-duplicate-exact-catalog-cache).

The SIMD checksum backend reduced native Durable Object CPU p50 from **250 to 224 ms** for sixteen rare terms and **437 to 385 ms** for sixty-four terms, with identical results. HTTP p50 did not improve in that comparison. [CPU and latency evidence](docs/performance.md#simd-checksum-backend-on-the-existing-compressed-formats).

An isolated Worker/DO/Container prototype measured **174–175 ms warm HTTP p50** on two fixed-snapshot selectors, preserving IDs and scores. Full API integration, cold latency and cost remain delivery gates. [Experimental Container evidence](docs/performance.md#native-container-feasibility-isolated-probe).

The experimental native range reader transfers about **34% fewer source bytes** than complete segments in a million-document test and validates headers directly in Rust. It has not replaced the production WASM path. [Cold-read evidence and limits](docs/performance.md#native-cold-read-through-canonical-header-and-posting-ranges) · [native process](crates/native/README.md).

Independent SciFact evaluation retained **0.6731 nDCG@10**, **0.7957 recall@10** and **0.6418 MRR@10**, with the entire 300-query report unchanged. Twelve native Vectorize/hybrid checks preserved 105 complete rows and scores across three 100-vector fixtures; large-corpus ANN recall remains unmeasured.

A subsequent rare/dense native sweep encountered five strong-query 503s with the Durable Object overload flag; later queries recovered without deployment, and the cause remains unresolved. Cold broad queries have reached the 30-second edge lease in earlier trials. Peak whole-Worker heap and cold-tail reliability remain open. The earlier fully indexed sequential comparison measured p50 **175–178 ms strong**, **127–130 ms edge** and **45–47 ms Turbopuffer strong**, with Kannin ingress in MIA and Turbopuffer in `aws-sa-east-1`. Different placement and consistency prevent a parity claim.

[Measurements and earlier optimizations](docs/performance.md) · [contract comparison](docs/turbopuffer-contracts.md) · [ranking quality](docs/quality.md)

## Run

Requires Bun, Rust 1.96 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129. The WASM build enables SIMD, supported by Cloudflare Workers.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The verified suite has **262 Worker/tooling tests and 48 Rust tests**. The gate includes formatting, strict type-aware Effect/Oxlint rules, full native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Local Vectorize is a contract fixture; real provider recall and visibility require separate measurements.

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
