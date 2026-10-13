# Raio

Search on Cloudflare: an R2-native BM25 engine, volatile Durable Object coordination, and native Vectorize similarity search. Effect owns the HTTP contracts and operation boundaries. Rust compiles to WebAssembly for Unicode normalization, immutable compressed segments, positional postings and exact block-bound pruning. R2 stores the manifests, index segments, documents, tombstones, write logs, receipts and vector outbox. The application never uses Durable Object storage or a local database.

**Status:** local validation and native Alchemy deployment passed. Real R2 writes, BM25 reads, queue submission, eventual Vectorize visibility and native Worker/Cache API hits have been exercised. Comparable Turbopuffer performance has not been verified. Raio is inspired by object-storage search architecture; it is not a Turbopuffer implementation or API-compatible replacement.

## Build and test

Requires Bun, Rust 1.96 with the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun run check
```

The tests execute the compiled Rust/WASM Worker inside workerd with native local R2, volatile Durable Object coordination and Cloudflare Queues. Vectorize has a separate RPC contract fixture supporting failures and delayed, reordered writes. That fixture does not prove real Vectorize latency, recall, indexing visibility, or regional behavior. HTTP fixtures consume their full response bodies before releasing the connection.

## Deploy

Alchemy declares the Worker, R2 bucket, coordinator namespace, 768-dimensional cosine Vectorize index, vector and compaction job queues with dedicated dead-letter queues. Alchemy owns deployment; there is no Wrangler infrastructure configuration. Local `dev` stages use local infrastructure state. Other stages use Alchemy's Cloudflare state store.

Commands default to the native Alchemy `minutei` profile. Configure Cloudflare credentials through Alchemy and supply `RAIO_API_TOKEN` privately:

```sh
bun run plan --stage prod
bun run deploy --stage prod
```

The API token becomes the Worker's secret binding. Do not publish it or put it in the repository. Alchemy development still needs native provider authentication for capabilities that Cloudflare does not emulate, including Vectorize. `bun run test` runs offline after dependency installation.

## API

`GET /health` is public. All namespace operations require `Authorization: Bearer <token>`.

```sh
curl "$RAIO_URL/v1/namespaces/example/write" \
  -H "Authorization: Bearer $RAIO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"requestId":"batch-1","upserts":[{"id":"one","title":"Cloudflare search","text":"Rust, R2 and Durable Objects","attributes":{"year":2026}}],"deletes":[]}'

curl "$RAIO_URL/v1/namespaces/example/query" \
  -H "Authorization: Bearer $RAIO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"kind":"text","text":"cloudflare rust","match":"any","topK":10,"filters":[{"field":"year","op":"gte","value":2026}]}'
```

- `POST /v1/namespaces/:name/write`: atomic upserts/deletes, optional `reset: true`, durable request-id receipts. Reusing an id with another payload returns 409.
- `POST /v1/namespaces/:name/query`: `text`, `vector`, or `hybrid`; required `topK` and `filters`. Text matching supports `any`, `all`, and `phrase`. A vector query supplies 768 finite float32-range numbers with nonzero float32 magnitude. Hybrid supplies both text and vector. Text top-k is capped at 100; vector/hybrid top-k is capped at 50 by the native full-metadata retrieval contract.
- `GET /v1/namespaces/:name/metadata`: manifest document count, committed sequence, and pending vector outbox count.
- `POST /v1/namespaces/:name/vector-sync`: submits up to sixteen committed outbox jobs; Cloudflare Queues submit automatically. Accepted Vectorize mutations become visible asynchronously.
- `POST /v1/namespaces/:name/rebuild`: reloads the R2 manifest into the volatile coordinator. No database replay or bootstrap is needed; index segments are already canonical R2 objects.
- `POST /v1/namespaces/:name/compact`: coalesces up to eight small segments within a 10,000-document / 8 MiB decoded-document window, dropping tombstoned rows and retaining original document revisions. The new segment is activated by manifest CAS. Native Cloudflare Queues schedule bounded compaction automatically when segment counts exceed the namespace target. Obsolete-object garbage collection remains unimplemented.

Filters are ANDed. Supported operators are `eq`, `ne`, numeric `gt/gte/lt/lte`, `in`, and `exists`. Booleans, numbers, strings, JSON null, and absent properties are distinguished. Rust owns the same filter semantics for text and vector result reconciliation. Text filters apply before top-k. Vector filters currently apply to Vectorize's top 50 candidates, so selective filters or stale candidates can return fewer matches even when other eligible vectors exist. Native Vectorize metadata pre-filtering remains a delivery requirement.

Rust implements field-normalized BM25 with namespace-wide live document frequencies, title weight 2, body weight 1, `k1=1.2` and `b=0.75`. Posting blocks carry token positions and conservative score bounds; exact block pruning is checked against exhaustive scoring. Unicode words are lowercased and decomposed with combining marks removed; CJK word boundaries currently produce character tokens. No stemming, synonym expansion, or typo tolerance is claimed. Hybrid ranking uses reciprocal rank fusion with denominator `60 + rank`.

## Durability

A write stores an immutable Rust/WASM index segment and compressed log, atomically advances the R2 manifest with an ETag precondition, then persists the receipt and submits any vector job. R2 is the source of truth. A failed response may follow a successful manifest commit; retry the same request id and payload. The manifest's last receipt repairs an interrupted acknowledgement without duplicating the write. Unreferenced segments and log objects are never queried.

Text reads default to strong consistency through the namespace coordinator. Text-only `consistency: "edge-eventual"` evaluates in the edge Worker using an R2 snapshot less than one second old at selection. Set `minimumSequence` to the sequence returned by a write for read-after-write: an insufficient snapshot is refreshed, and an uncommitted sequence returns 409. Snapshot age is bounded at selection, not at response delivery; slow storage can delay the response. Cache failures use fresh R2 reads and never serve expired snapshots. The sequence barrier does not wait for Vectorize visibility. Coordinator memory and immutable caches are disposable. Vectors are explicitly eventually consistent. Versioned vector identities prevent delayed older embeddings from replacing newer revisions. Deleted and stale documents are checked against the current R2 manifest and segment metadata before results are returned. Resets move vector queries to a new epoch namespace.

See [architecture and remaining gates](docs/architecture.md) and [the enforced static checks](docs/lint.md).

## Performance

```sh
bun run bench
RAIO_BENCH_DOCUMENTS=100000 bun run bench
```

The deterministic local benchmark records corpus SHA-256, ingestion throughput, and 50 measured samples after five warmups for rare, selective, common, and filtered BM25 queries. These are local workerd timings, including HTTP transport and response validation. They are not Cloudflare production timings or evidence of Turbopuffer parity. No result cache is used to improve repeated benchmark queries.

## License

Apache-2.0. Third-party licenses remain with their packages. The declared Alchemy patch corrects native Vectorize binding type inference in version 2.0.0-beta.83; see [the patch record](docs/alchemy-patch.md).
