# Native ranking process

Experimental Rust HTTP process for a private Worker → Durable Object → Container path. The production Worker still ranks with WASM. R2 remains canonical; this process retains disposable immutable data only.

Build the image from the repository root:

```sh
podman build -f crates/native/Dockerfile -t kannin-native .
```

Provide `SOURCE_URL` as the private HTTP origin intercepted by the owning Durable Object. It must serve the existing segment protocol: `GET /range?key=…&offset=…&length=…` returns canonical bytes. The process reads the complete canonical header at offset zero, validates it in Rust, then fetches selected posting intervals. A cold miss does not require the Worker to parse or compress a directory first. No R2 credentials enter the process. Listen port is 8080; `GET /ready` checks readiness.

`POST /rank` accepts `NativeRankingInput` from `src/protocol.ts` and returns `NativeRankingResult`. The caller supplies at most eight immutable segment descriptors, current tombstones, global live statistics and an optional top-k cutoff. It owns authentication, captured-manifest leases, sequence barriers, global result merging and document materialization. The process uses the existing Rust scorer, including exact filters, positional matching, checksums and tie ordering.

Admission permits four ranking requests and sixteen connections. Four segment handles and four source acquisitions run concurrently. Request bodies are limited to four MiB; source bodies are bounded by the canonical sixteen-MiB format limit. Decoded directories retain at most 256 MiB of charged entries; encoded ranges share a 64-MiB quota. Active handles can outlive eviction, so these quotas do not bound total process memory. Acquisition producers keep their I/O permits after a waiting request disconnects; concurrent misses reuse the producer. Cache identities include the physical bucket and immutable object identity.

The six native tests cover full-segment/range ranking equivalence, filters, tombstones, phrase/all modes, cutoff pruning, cold/warm acquisition, bucket isolation, cancellation, cache eviction and overflow-safe range grouping. Run `cargo test -p kannin-native --locked`. [Performance and integration gates](../../docs/performance.md#native-cold-read-through-canonical-header-and-posting-ranges).
