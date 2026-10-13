# API

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
- `POST /v1/namespaces/:name/vector-rebuild`: rebuild derived Vectorize metadata from an R2 snapshot in pages of at most 100 vectors; return the snapshot/segment/row cursor unchanged to resume. Deployment runs this migration automatically.
- `POST /v1/namespaces/:name/query`: `text`, `vector`, or `hybrid`; required `topK` and `filters`. Text matching supports `any`, `all`, and `phrase`. A vector query supplies 768 finite float32-range numbers with nonzero float32 magnitude. Hybrid supplies both text and vector. Text top-k is capped at 100; vector/hybrid top-k is capped at 50 by the native full-metadata retrieval contract.
- `GET /v1/namespaces/:name/metadata`: manifest document count, committed sequence, and pending vector outbox count.
- `POST /v1/namespaces/:name/vector-sync`: submits up to sixteen committed outbox jobs; Cloudflare Queues submit automatically. The response contains `submitted` (0–16 processed jobs) and `visibility: "vectorize-eventual"`. Accepted Vectorize mutations become visible asynchronously.
- `POST /v1/namespaces/:name/rebuild`: reloads the R2 manifest into the volatile coordinator. No database replay or bootstrap is needed; index segments are already canonical R2 objects.
- `POST /v1/namespaces/:name/collect`: scans up to 100 R2 segments per page. Send `{}` initially and then `{ "cursor": "..." }` until the returned cursor is null. Unreferenced segments require a 24-hour quarantine measured from their first unreferenced observation. Active roots and rebuild checkpoints pin segments; checkpoints expire after seven days and an expired rebuild cursor returns 410. Logs and idempotency receipts remain durable indefinitely.
- `POST /v1/namespaces/:name/compact`: coalesces up to eight small segments within a 10,000-document / 8 MiB decoded-document window, dropping tombstoned rows and retaining original document revisions. The new segment is activated by manifest CAS. Native Cloudflare Queues schedule bounded compaction automatically when segment counts exceed the namespace target.

Filters are ANDed. Supported operators are `eq`, `ne`, numeric `gt/gte/lt/lte`, `in`, and `exists`. Booleans, numbers, strings, JSON null, and absent properties are distinguished. Rust owns the same filter semantics for text and vector result reconciliation. Text filters apply before top-k. Configure up to five indexed attribute names through `RAIO_VECTOR_FILTER_FIELDS`, a JSON array supplied to Alchemy. Each field owns a typed scalar SHA-256 equality index and a numeric range index. Equality, membership and numeric intervals are pushed into Vectorize before its top-50 limit; strings beyond 64 UTF-8 bytes retain exact equality through hashing. R2 reconciles every candidate against live revisions and all original filters. Unconfigured fields, negative/existence predicates, filters beyond the provider's 2 KiB pushdown budget, and stale candidates can still underfill results.

Rust implements field-normalized BM25 with namespace-wide live document frequencies, title weight 2, body weight 1, `k1=1.2` and `b=0.75`. Posting blocks carry token positions and conservative score bounds; exact block pruning is checked against exhaustive scoring. Unicode words are lowercased and decomposed with combining marks removed; CJK word boundaries currently produce character tokens. No stemming, synonym expansion, or typo tolerance is claimed. Hybrid ranking uses reciprocal rank fusion with denominator `60 + rank`.

## Durability

A write stores an immutable Rust/WASM index segment and compressed log, atomically advances the R2 manifest with an ETag precondition, then persists the receipt and submits any vector job. R2 is the source of truth. A failed response may follow a successful manifest commit; retry the same request id and payload. The manifest's last receipt repairs an interrupted acknowledgement without duplicating the write. Unreferenced segments and log objects are never queried.

Text reads default to strong consistency through the namespace coordinator. Text-only `consistency: "edge-eventual"` evaluates in the edge Worker using an R2 snapshot less than one second old at selection. Set `minimumSequence` to the sequence returned by a write for read-after-write: an insufficient snapshot is refreshed, and an uncommitted sequence returns 409. Snapshot age is bounded at selection, not at response delivery; slow storage can delay the response. Cache failures use fresh R2 reads and never serve expired snapshots. The sequence barrier does not wait for Vectorize visibility. Coordinator memory and immutable caches are disposable. Vectors are explicitly eventually consistent. Versioned vector identities prevent delayed older embeddings from replacing newer revisions. Deleted and stale documents are checked against the current R2 manifest and segment metadata before results are returned. Resets move vector queries to a new epoch namespace.

See [architecture and remaining gates](architecture.md) and [the enforced static checks](lint.md).
