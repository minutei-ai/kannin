# Deployment

The optional Cloudflare stack declares the Worker, R2 bucket, coordinator namespace, and vector-validation and compaction job queues with dedicated dead-letter queues. It does not provision a Vectorize index. Kannin owns vector search in Rust/WASM against canonical R2 vectors. Docker and Railway instead run the complete API container against S3-compatible storage without Cloudflare credentials; see the target configuration in the [README](../README.md). Alchemy owns deployment; there is no Wrangler infrastructure configuration. Local `dev` stages use local infrastructure state. Other stages use Alchemy's Cloudflare state store.

The public project is Kannin. The existing `Raio` Alchemy stack, `RAIO_*` configuration keys, Rust artifact names and internal cache identifiers retain their deployment identity so renaming the repository does not recreate infrastructure or abandon data.

After publishing the Worker, the stack runs RootFormatMigration before the retained VectorMetadataMigration hook, without memoization. The latter name preserves the existing deployment identity; its current implementation pages through canonical vector rebuilds to validate persisted vectors and warm immutable structures, without submitting vectors to an external index. It inventories namespaces and invokes authenticated migrate-root serially. Stored v1–v4 Roots and rebuild checkpoints convert to StoredRoot v5 and RAIOSEG2 segments. Converted segments are published before their references; checkpoints activate through their captured ETags before canonical Root. Document identities, revisions, logical sequences, vector epochs and checkpoint expiry are preserved. Common-leader offsets and Bloom segment-key references change with the segment layout. V4 Bloom object bytes and hashes are reused; inline Bloom versions create validated packs. Models are derived once for v1/v2 and preserved for v3/v4. New keys separate older cached ranges and directory formats; snapshot caches recover through R2 under their v5 identity.

Normal reads require the converted format. Interrupted migrations may be retried without extending expiry or rewriting converted checkpoints. Segment output above sixteen MiB and checkpoint objects above eight MiB are rejected before publishing their manifest or checkpoint CAS. Migration reads and converted checkpoint states also have the existing 32-MiB batch budget. Source objects remain available for retry and normal retirement; these limits must be validated before a production cutover.

Local integration checks and performance evidence are recorded in [performance](performance.md). The generic cold-200-ms target remains unproven. Cloudflare deployment, actual provider latency and execution of the v5 stack hook remain unverified.

Commands default to the native Alchemy `minutei` profile. Configure Cloudflare credentials through Alchemy and supply `RAIO_API_TOKEN` privately:

```sh
bun run plan --stage prod
bun run deploy --stage prod
```

The API token becomes the Worker's secret binding. Do not publish it or put it in the repository. Cloudflare provisioning uses native provider authentication. The Docker and Railway application runtimes require no Cloudflare authentication. The native vector path needs no Vectorize account or binding. `bun run test` exercises local backends after dependency installation and requires the configured container engines; the native-vector replacement still awaits a passing complete gate and hosted validation.
