# Kannin

Target: full drop-in compatibility with Turbopuffer’s public API and behavior. **Not compatible yet:** the current API and feature gaps are tracked in the [compatibility contract](docs/turbopuffer-contracts.md), including the public v3 research and Cloudflare constraints.

The public `GET /v1/namespaces` listing and native Effect `namespaces` operation now share the R2 catalog. The official Turbopuffer TypeScript SDK 2.13.0 passes bounded local listing and warm-hint cases on workerd and the portable S3-backed HTTP server in the [complete gate](https://github.com/minutei-ai/kannin/actions/runs/40875717014). The historical 2.12.0 probe paginated 1,002 IDs without loss or duplication; that large SDK loop has not been repeated with 2.13.0. Public writes, query expressions, schema evolution and other compatibility gaps remain. See [the conformance evidence](docs/turbopuffer-contracts.md).

The [native Effect SDK](docs/sdk.md) connects Workers through a service binding to `KanninRpc`, including coordinator RPC, without HTTP. Query replies avoid repeated result traversal at both binding boundaries. Isolated SDK cost falls 23–48%; a rich-row local binding case measures 22.10 / 21.59 / 19.14 ms warm for baseline / identical control / candidate. Other workloads remain mixed, with no general cold or RSS improvement established. See [SDK measurements and limits](docs/performance.md#one-operation-result-validation-in-the-native-effect-sdk).

BM25, vector and hybrid search with canonical documents, vector frames and indexes in S3/R2. Rust/WASM owns lexical ranking and exact cosine vector selection, including filters and tombstones before top-k. TypeScript + Effect owns contracts and operations. The runtime and infrastructure no longer require Vectorize or Qdrant. **The [full native-vector gate](https://github.com/minutei-ai/kannin/actions/runs/40862361854) passed at `3f56aa6`; hosted validation remains pending.** The StoredRoot v6 column-schema cutover passed the [complete gate](https://github.com/minutei-ai/kannin/actions/runs/40875717014) at `15cec61` (110 Rust and 488 Bun/workerd tests); the later portable-retention and coordinator-admission regressions passed the [subsequent gate](https://github.com/minutei-ai/kannin/actions/runs/40877887921) at `a4a1b3f` (110 Rust, 493 Bun/workerd tests). Hosted migration remains unverified. Embeddings are currently supplied by the caller; generation is a separate optional model-provider concern. No application SQLite, D1 or KV.

The document-column/RAIOSEG3 cutover passed the [complete gate](https://github.com/minutei-ai/kannin/actions/runs/40899268051) at `ae683d1`: 121 Rust tests and 502 Bun/workerd tests, with 18,693 assertions. It retains readers for existing v2 segments and leaves native write/log/receipt contracts unchanged. Binary64 attribute precision and vector bytes are preserved through the tested migration paths. Older binaries cannot read new v3 segments, so mixed-version deployments require coordinated replacement. Hosted migration and full public API compatibility remain pending.

- BM25F with global live statistics, phrase matching and filters before top-k.
- Atomic R2 manifest commits, durable idempotency receipts and disposable coordinator memory.
- Bounded immutable range and term-catalog caches, native Worker Cache and Cache API; explicit edge reads with snapshots younger than one second at selection.
- Native exact vector ranking with canonical revision visibility, filters before top-k and reciprocal rank fusion.

## Cloud portability and local development

Railway and Docker are the priority deployment targets. Both use the same complete Bun API image and require S3-compatible canonical object storage; Cloudflare remains an optional runtime with an R2 adapter. Vector queries, synchronization and rebuild use Kannin itself. Local conformance uses real RustFS and runs the OCI image with Podman and Docker Engine, without external vector services. The [complete gate](https://github.com/minutei-ai/kannin/actions/runs/40862361854) passed at `3f56aa6`, including cross-engine writes/restarts/text/vector reads, with 110 Rust tests, 476 Bun/workerd tests and 18,504 assertions. Hosted Railway deployment and subsequent changes still require validation. See [running the portable API](docs/portable-runtime.md) and [the portability gates](docs/architecture.md#cloud-portability-gates).

Docker includes a private immutable HTTP cache built on the official Varnish image. Its TypeScript/Effect adapter implements `match/put/delete`, with bucket/version-scoped keys, a separate service credential and bounded memory. Cache loss recovers through S3-compatible storage; see [the cache contract and limits](docs/portable-runtime.md#self-hosted-immutable-cdn-cache).

Alchemy is pinned to `2.0.0-beta.84`, with the matching `@alchemy.run/cloudflare` provider and Effect `4.0.7`. The dependency refresh passed the [full gate](https://github.com/minutei-ai/kannin/actions/runs/40862361854) at `3f56aa6`. The provider split replaces `alchemy/Cloudflare`; the WorkerEntrypoint guard is fixed upstream. A [pinned provider patch](docs/alchemy-patch.md) restores the missing local queue gateway and missing Vectorize/Secrets Store binding inference in the published Cloudflare provider.

Local emulation coverage, checked against the official Alchemy documentation on 2026-10-27:

| Target            | Local development coverage                                                                                                                                | Kannin status                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| AWS               | Docker/floci emulates Lambda/ECS, S3, SQS and S3 Vectors among roughly 40 services. Unsupported resources still use the real cloud.                       | Emulation reference; Railway/Docker are the selected next targets.                                                               |
| Cloudflare        | workerd emulates Workers, R2, Queues and Durable Objects. Vectorize Index and metadata resources still use the real cloud.                                | Native vector path uses local R2; full gate passed at `3f56aa6`, hosted validation pending.                                      |
| GCP, Fly, Hetzner | No complete provider emulation is documented in the shared local-development guide. Running a container locally does not emulate the cloud control plane. | No application adapters for these targets.                                                                                       |
| Railway           | No complete Railway control-plane emulator. Local tests run the same OCI image and real selected backends.                                                | Alchemy Railway stack added; hosted deployment unverified.                                                                       |
| Docker            | Runs containers directly; it does not emulate a cloud provider.                                                                                           | Root Dockerfile runs the complete native API with S3 and native vectors; `crates/native/Dockerfile` remains the internal ranker. |

No provider offers complete emulation of every cloud service. The selected Kannin stack avoids external vector services: workerd can exercise the Cloudflare runtime with local R2, and Docker runs the API against a local S3-compatible service. A passing complete gate must establish this path; local execution does not emulate Railway control-plane behavior or establish hosted latency and ranking-quality parity.

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

**The general 200 ms cold and 100 ms warm targets remain unmet.** Derived objects are prepared and backend/filesystem caches may be warm. RSS measures the workerd process, not individual-isolate heap. Native-vector scale, cold-tail reliability, sustained capacity and full Turbopuffer compatibility remain unverified or incomplete; the historical external-vector fixture returned 25 of 50 and must be remeasured against the native engine. No Cloudflare deployment or hosted competitor test accompanied this change.

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

Authenticated namespace endpoints support atomic writes, text/vector/hybrid queries, metadata, compaction, collection and vector rebuilds. Declare up to 64 `schema.filterable` names per namespace and its ordered `schema.vectorFilterFields` subset on a write; queries allow up to 16 predicates and reject undeclared attributes. The schema is persisted in object storage and changing it requires reset/reimport. Configured writes keep only declared filter attributes in segment headers; complete attributes stay in document payloads and returned rows. Root v7 pools bounded native eligibility models for those declarations and query subsets and stores Bloom bitsets in immutable content-addressed R2 packs; unsupported or high-cardinality models retain canonical catalog evaluation. Existing Root v1/v2/v3/v4/v5/v6 data requires the explicit [migration](docs/deployment.md). BM25 currently indexes fixed `title` and `text` fields; arbitrary full-text attribute indexing remains unimplemented. Text reads default to strong consistency; edge eventual is explicit and supports a `minimumSequence` barrier. Vector and hybrid reads evaluate the captured canonical Root with strong consistency and filter live rows before top-k. Text top-k is capped at 100; vector/hybrid at 50. The full native-vector gate passed at `3f56aa6`; hosted and scale validation remain pending.

[API and durability](docs/api.md) · [architecture](docs/architecture.md) · [search research](docs/search-research.md) · [lint](docs/lint.md)

The current source introduces an explicit internal canonical write envelope for string, uint64 and UUID identities through the same object-storage writer. Root v7 owns one ID-type policy, typed rows retain tagged IDs, and native write/log/receipt contracts remain available. Root v6 requires envelope-only migration; segment/log/receipt objects are retained. This cut passed the [complete gate at `9367a54`](https://github.com/minutei-ai/kannin/actions/runs/40974573962); hosted validation remains open. Public Turbopuffer typed schemas, row codecs, attribute predicates, inference and null semantics remain delivery gates; the internal extension does not establish public v2 compatibility.

The candidate Rust/WASM engine also contains exact typed attribute cells in RAIOSEG6, with matching TypeScript cell contracts. The current uncommitted source connects them to the existing writer and query operation through Root.schema typed columns, StoredRoot v8, Log 3 and typed filters, with Root v7 migrating by envelope only. This work is unvalidated: it has not passed the complete gate or hosted validation, and public v2 routes, row codecs, schema inference/evolution and ANN/full-text column flags remain delivery gates. Its presence does not establish typed-attribute API compatibility.

The following are internal candidate limits, not hosted Turbopuffer compatibility guarantees. The HTTP request-body budget still applies even when an individual cell permits a larger value.

| Typed-column contract      | Candidate bound or behavior                                                       |
| -------------------------- | --------------------------------------------------------------------------------- |
| Declared attribute columns | 1,024 per namespace; zero-column typed mode is explicit                           |
| Filterable attributes      | 64; at most 16 query predicates                                                   |
| Typed arrays               | 4,096 homogeneous non-null scalar elements; no nested arrays or bytes arrays      |
| Bytes                      | Canonical padded base64; at most 8 MiB decoded; not filterable                    |
| Exact numeric cells        | Signed/unsigned 64-bit decimal tags and finite binary64 bit tags                  |
| Missing and null           | Stored separately; internal null acceptance is declared per column                |
| Schema changes             | Explicit declarations; changes require reset and reimport                         |
| Public delivery gates      | v2 codecs/routes, inference/evolution/drop, indexing flags and hosted conformance |

## License

MIT. Third-party licenses remain with their packages. [Declared Alchemy patch](docs/alchemy-patch.md).
