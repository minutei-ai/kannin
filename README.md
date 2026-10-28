# Kannin

Target: full drop-in compatibility with Turbopuffer’s public API and behavior. **Not compatible yet:** the current API and feature gaps are tracked in the [compatibility contract](docs/turbopuffer-contracts.md), including the public v3 research and Cloudflare constraints.

The public `GET /v1/namespaces` listing and native Effect `namespaces` operation now share the R2 catalog. The official Turbopuffer TypeScript SDK 2.12.0 locally paginates 1,002 IDs without loss or duplication. This validates listing only; writes, query expressions, schema evolution and other compatibility gaps remain. See [the conformance evidence](docs/turbopuffer-contracts.md).

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP. Query replies avoid repeated result traversal at both binding boundaries. Isolated SDK cost falls 23–48%; a rich-row local binding case measures 22.10 / 21.59 / 19.14 ms warm for baseline / identical control / candidate. Other workloads remain mixed, with no general cold or RSS improvement established. See [SDK measurements and limits](docs/performance.md#one-operation-result-validation-in-the-native-effect-sdk).

BM25, vector and hybrid search with object storage owning documents and indexes. TypeScript + Effect owns contracts and operations. The required architecture gives Rust/WASM both lexical and vector search over S3/R2 state. **Vector migration is incomplete:** the active runtime still delegates candidate selection to Vectorize on Cloudflare and Qdrant on portable targets; these paths must be replaced by Kannin's native engine. The API currently receives client-generated embeddings; optional embedding generation is separate from search. No application SQLite, D1 or KV.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Vectorize metadata filtering, stale-revision reconciliation and reciprocal rank fusion.

## Cloud portability and local development

Railway and Docker are the priority deployment targets. Cloud independence is a product requirement: both targets must run without Cloudflare services, credentials or accounts. R2 and Vectorize may only remain optional backend adapters. The same TypeScript/Effect and Rust/WASM core now runs as a Worker or a complete Bun API image. The portable adapters use S3-compatible object storage and Qdrant. Local conformance uses real RustFS/Qdrant and executes the OCI image with rootless Podman; a hosted Railway deployment and full provider conformance remain delivery gates. See [running the portable API](docs/portable-runtime.md) and [the portability gates](docs/architecture.md#cloud-portability-gates).

Docker includes a private immutable HTTP cache built on the official Varnish image. Its TypeScript/Effect adapter implements `match/put/delete`, with bucket/version-scoped keys, a separate service credential and bounded memory. Cache loss recovers through S3-compatible storage; see [the cache contract and limits](docs/portable-runtime.md#self-hosted-immutable-cdn-cache).

Alchemy is pinned to `2.0.0-beta.84`, with the matching `@alchemy.run/cloudflare` provider and Effect `4.0.6`. The provider split replaces `alchemy/Cloudflare`; the WorkerEntrypoint guard is fixed upstream. A [pinned provider patch](docs/alchemy-patch.md) restores the missing local queue gateway and missing Vectorize/Secrets Store binding inference in the published Cloudflare provider.

Local emulation coverage, checked against the official Alchemy documentation on 2026-10-27:

| Target            | Local development coverage                                                                                                                                | Kannin status                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| AWS               | Docker/floci emulates Lambda/ECS, S3, SQS and S3 Vectors among roughly 40 services. Unsupported resources still use the real cloud.                       | Emulation reference; Railway/Docker are the selected next targets.                                                   |
| Cloudflare        | workerd emulates Workers, R2, Queues and Durable Objects. Vectorize Index and metadata resources still use the real cloud.                                | Existing backend; full vector/hybrid development is not offline.                                                     |
| GCP, Fly, Hetzner | No complete provider emulation is documented in the shared local-development guide. Running a container locally does not emulate the cloud control plane. | No application adapters for these targets.                                                                           |
| Railway           | No complete Railway control-plane emulator. Local tests run the same OCI image and real selected backends.                                                | Alchemy Railway stack added; hosted deployment unverified.                                                           |
| Docker            | Runs containers directly; it does not emulate a cloud provider.                                                                                           | Root Dockerfile runs the complete native API with S3/Qdrant; `crates/native/Dockerfile` remains the internal ranker. |

No provider offers complete emulation of every cloud service. AWS is the documented option for a fully local stack when all selected resources have local implementations; this is not yet a validated local Kannin stack. Cloudflare vector fixture results do not establish real Vectorize ANN behavior. Separate portable checks exercise Qdrant itself, without establishing hosted latency or ANN recall parity.

Sources: [shared local development](https://alchemy.run/environments/local-development/), [AWS local development](https://alchemy.run/aws/local-development/), [Cloudflare local development](https://alchemy.run/cloudflare/local-development/).

## Performance

The latest Rust overview format separates singleton facts from shared score summaries and projects only requested facts. The final six-cohort, million-document comparison checks **864 complete responses** against baseline oracles with an identical-binary control. Rare-query WASM capacity falls from **4.94 to 4.5 MiB**; directory acquisition remains unnecessary for these queries. These are local measurements, not hosted parity or production heap evidence.

| Query / process state                    | Cold before → after (ms) | Warm before → after (ms) |
| ---------------------------------------- | -----------------------: | -----------------------: |
| Filtered any, top 10, fresh              |          796.78 → 798.93 |            13.55 → 14.00 |
| Filtered phrase, top 10, fresh           |          935.61 → 936.84 |            15.53 → 15.73 |
| 64 rare terms, top 100, fresh            |        1785.79 → 1582.88 |            32.66 → 33.29 |
| Filtered any, top 10, R2-only restart    |          551.24 → 549.91 |            13.69 → 12.80 |
| Filtered phrase, top 10, R2-only restart |          677.46 → 669.61 |            16.93 → 17.34 |
| 64 rare terms, top 100, R2-only restart  |        1714.34 → 1500.69 |            34.17 → 34.24 |

Dense timings, warm reads and RSS remain workload-dependent. [Methods, controls, limits and gate099 evidence](docs/performance.md#compact-singleton-overviews).

**The general 200 ms cold and 100 ms warm targets remain unmet.** Derived objects are prepared and backend/filesystem caches may be warm. RSS measures the workerd process, not individual-isolate heap. Real Vectorize ANN, cold-tail reliability, sustained capacity and full Turbopuffer compatibility remain unverified or incomplete; filtered vector still returns 25 of 50 in the existing local fixture. No Cloudflare deployment or hosted competitor test accompanied this change.

Five public BEIR test splits cover **3,677 queries**. [Ranking quality](docs/quality.md) · [measurement history](docs/performance.md) · [compatibility contract](docs/turbopuffer-contracts.md).

## Run

Requires Bun, Rust 1.99.1 with `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.129. The WASM build enables SIMD, supported by Cloudflare Workers.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The gate includes formatting, strict type-aware Effect/Oxlint rules, native and WASM Clippy (all/pedantic/nursery), Effect tsgo compiler checks and workerd tests. Gate093 passes **98 Rust and 436 Bun/workerd tests**, with 17,572 assertions. Its single executor enforces **MemoryMax=2 GiB** and no swap, peaking at 1.76 GiB without OOM; its receipt retains memory-pressure counters. [Validation evidence](docs/performance.md#id-order-validation).

For deployment, configure Alchemy's `minutei` profile and supply `RAIO_API_TOKEN` privately, then run `bun run deploy --stage prod`. Existing `Raio` stack and `RAIO_*` identifiers preserve infrastructure identity. [Deployment details](docs/deployment.md).

## API and limits

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Declare up to 64 `schema.filterable` names per namespace and its ordered `schema.vectorFilterFields` subset on a write; queries allow up to 16 predicates and reject undeclared attributes. The schema is persisted in R2 and changing it requires reset/reimport. Configured writes keep only declared filter attributes in segment headers; complete attributes stay in document payloads and returned rows. Root v5 pools bounded native eligibility models for those declarations and query subsets and stores Bloom bitsets in immutable content-addressed R2 packs; unsupported or high-cardinality models retain canonical catalog evaluation. Existing Root v1/v2/v3/v4 data requires the explicit [migration](docs/deployment.md). BM25 currently indexes fixed `title` and `text` fields; arbitrary full-text attribute indexing remains unimplemented. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector visibility is eventual. Text top-k is capped at 100; vector/hybrid at 50. Unsupported provider filter pushdown and stale candidates can underfill vector results.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [search research](docs/search-research.md) · [lint](docs/lint.md)

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
