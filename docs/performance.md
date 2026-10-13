# Deployed BM25 comparison

This is a bounded synthetic measurement, not a general parity claim. Both services received the same 10,000 documents. The client ran in Brazil; Cloudflare HTTP responses came from GRU, and Turbopuffer used aws-sa-east-1. Raio strong reads still use a coordinator outside South America. Raio edge reads use the explicit less-than-one-second snapshot contract, with minimumSequence set to the final acknowledged write. Turbopuffer reads are strong. Those guarantees differ even when the static corpus produces identical Raio rows.

Each case has five warmups followed by 50 sequential measured requests per engine. Each iteration runs Raio strong, Raio edge, then Turbopuffer. The report records the first request separately; it does not prove a cold process. Timings include HTTP, response body consumption and decoding. No query-result cache is used. Fifty observations provide limited evidence about tail latency; raw samples and operational targets stay outside this public repository.

| Query     | Raio strong p50 / p95 ms | Raio edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -----------------------: | ---------------------: | ------------------------------: |
| rare      |            188.5 / 219.2 |            62.5 / 76.6 |                     64.4 / 78.5 |
| selective |            197.1 / 215.5 |            77.6 / 99.8 |                     67.8 / 85.0 |
| common    |            191.3 / 201.6 |            71.3 / 96.6 |                     82.7 / 90.3 |
| filtered  |            204.9 / 224.8 |           92.2 / 131.7 |                     81.1 / 89.6 |

Sequential ingestion in batches of 500 took 46.74 seconds for Raio and 7.12 seconds for Turbopuffer. This measures acknowledged writes, not asynchronous vector visibility. The temporary Turbopuffer comparator was deleted after the completed run.

Corpus SHA-256: `2b6257d0fce1b430f1a4b91b6cca9af481da8aa820142cc94ca628cb5cee03f2`. Worker SHA-256: `0ddb644ba06cdef53e877a398fcb4a6dcebbc9d323039f677e4ca901c9d5925c`. WASM SHA-256: `a4d1fdf2a4a397dc4978dede178269c71e49954a15eb347ed15ac367d0813254`. Bun 1.4.3; Rust 1.96; Effect 4.0.4; Alchemy 2.0.0-beta.83. The executable corpus and comparison live in `tooling/corpus.ts` and `tooling/compare.ts`.

Before proactive refresh, edge p95 ranged from 269 to 378 ms because expired snapshots blocked on R2. Refreshing still-valid snapshots in native background work reduced that penalty without extending the age limit. Filtered tails, ingestion throughput, 100,000/1,000,000-document scale, concurrency, public ranking judgments, vector recall and cost remain delivery gates.
