# Deployed BM25 comparison

This is a bounded synthetic measurement, not a general parity claim. Both services received the same 10,000 documents. The client ran in Brazil; Cloudflare HTTP responses came from GRU, and Turbopuffer used aws-sa-east-1. At the time of this measurement, Raio strong reads used a coordinator outside South America. An experiment fetching the canonical R2 manifest directly in the edge Worker was evaluated separately below and reverted after it regressed latency. Raio edge reads use the explicit less-than-one-second snapshot contract, with minimumSequence set to the final acknowledged write. Turbopuffer reads are strong. Those guarantees differ even when the static corpus produces identical Raio rows.

Each case has five warmups followed by 50 sequential measured requests per engine. Each iteration runs Raio strong, Raio edge, then Turbopuffer. The report records the first request separately; it does not prove a cold process. Timings include HTTP, response body consumption and decoding. No query-result cache is used. Fifty observations provide limited evidence about tail latency; raw samples and operational targets stay outside this public repository.

| Query     | Raio strong p50 / p95 ms | Raio edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -----------------------: | ---------------------: | ------------------------------: |
| rare      |            188.5 / 219.2 |            62.5 / 76.6 |                     64.4 / 78.5 |
| selective |            197.1 / 215.5 |            77.6 / 99.8 |                     67.8 / 85.0 |
| common    |            191.3 / 201.6 |            71.3 / 96.6 |                     82.7 / 90.3 |
| filtered  |            204.9 / 224.8 |           92.2 / 131.7 |                     81.1 / 89.6 |

Sequential ingestion in batches of 500 took 46.74 seconds for Raio and 7.12 seconds for Turbopuffer. This measures acknowledged writes, not asynchronous vector visibility. The temporary Turbopuffer comparator was deleted after the completed run.

Corpus SHA-256: `2b6257d0fce1b430f1a4b91b6cca9af481da8aa820142cc94ca628cb5cee03f2`. Worker SHA-256: `0ddb644ba06cdef53e877a398fcb4a6dcebbc9d323039f677e4ca901c9d5925c`. WASM SHA-256: `a4d1fdf2a4a397dc4978dede178269c71e49954a15eb347ed15ac367d0813254`. Bun 1.4.3; Rust 1.96; Effect 4.0.4; Alchemy 2.0.0-beta.83. The executable corpus and comparison live in `tooling/corpus.ts` and `tooling/compare.ts`.

Before proactive refresh, edge p95 ranged from 269 to 378 ms because expired snapshots blocked on R2. Refreshing still-valid snapshots in native background work reduced that penalty without extending the age limit. Ingestion throughput, 1,000,000-document scale, concurrency, broader ranking judgments, vector recall and cost remain delivery gates. The public SciFact evaluation is recorded separately in quality.md.

## 100,000-document follow-up

After bounded filter-mask caching, tighter exact score bounds and separation of the logical one-second snapshot age from the physical two-second cache expiry, a follow-up reused the existing Raio corpus and created a fresh Turbopuffer comparator with identical documents. This run measured query latency only; Raio ingestion was not repeated. The same sequential client methodology and consistency differences apply.

| Query     | Raio strong p50 / p95 ms | Raio edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -----------------------: | ---------------------: | ------------------------------: |
| rare      |            191.6 / 235.7 |           71.8 / 110.3 |                     57.2 / 58.0 |
| selective |            196.3 / 224.2 |           88.1 / 148.9 |                     56.9 / 57.8 |
| common    |            213.1 / 231.7 |          105.6 / 153.8 |                     76.2 / 76.9 |
| filtered  |            205.0 / 230.3 |           98.1 / 164.2 |                     72.5 / 74.6 |

Corpus SHA-256: `e23ae431deaee2436ee6674a7834e57663739b6c5bd723b7c9137c4ab123dbfb`. The comparator was deleted after the run. Edge p99 ranged from 168.2 to 239.6 ms. This result does not establish performance parity: strong reads retain the coordinator hop, and edge tails remain above the comparator. Turbopuffer reported different exhaustive-search counts across repeated runs on the same synthetic corpus, so comparisons must record indexing state and cannot attribute every cross-run change to Raio. Neither this run nor the earlier 10,000-document run proves sustained concurrent throughput.

## Rejected direct-R2 strong-read experiment

An uncached canonical R2 manifest read can select a strongly consistent snapshot without a coordinator hop, but the deployed measurement was slower. On the same 100,000-document Raio corpus, direct-R2 strong p50 ranged from 263.0 to 294.0 ms and p95 from 403.5 to 495.9 ms. Edge p50 ranged from 65.3 to 116.1 ms. The fresh Turbopuffer comparator completed indexing before measurement; its strong p50 ranged from 49.6 to 50.3 ms. The direct-R2 request path was reverted, preserving the faster coordinator-backed strong path. This evidence does not prove that bucket placement alone explains the regression.

The updated comparison driver waits for native Turbopuffer metadata to report an up-to-date index, with a bounded observation window, before running measured queries. The metadata response did not supply the declared unindexed row count during that observation, so progress reporting uses the native index status only. The comparator was deleted after the run. Further work must address R2 acquisition latency and cold edge directory-cache tails before a parity claim.

## Bounded parallel-read follow-up

The deployed implementation at `f00df9e` loads dictionaries and result documents with concurrency four and reads postings in windows of four blocks. On the same 100,000-document corpus, with a fresh comparator fully indexed before query measurement, the sequential results were:

| Query     | Raio strong p50 / p95 ms | Raio edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -----------------------: | ---------------------: | ------------------------------: |
| rare      |            181.4 / 215.2 |            55.9 / 86.1 |                    51.6 / 321.6 |
| selective |            186.9 / 200.8 |           62.4 / 109.1 |                     49.5 / 52.6 |
| common    |            197.3 / 216.4 |            73.0 / 98.7 |                     50.2 / 53.4 |
| filtered  |            193.1 / 214.7 |           69.7 / 100.5 |                     50.5 / 53.2 |

The comparator was deleted. One rare-query comparator tail reached 1,057.5 ms; the other comparator cases had p95 near 53 ms. Edge medians improved relative to the preceding measurements, but cold tails remain and the consistency contracts still differ.

The separate `tooling/load.ts` driver checks every edge response against a strong baseline, including IDs, scores, revisions and corpus sequence. It ran mixed rare, selective, common and filtered requests on the same deployed corpus, in phases of 128 requests at concurrency 1, 4 and 16:

| Concurrency |      p50 / p95 / p99 ms | Requests per second |
| ----------: | ----------------------: | ------------------: |
|           1 |  106.6 / 546.7 / 2455.8 |                 3.8 |
|           4 |   91.3 / 350.6 / 1385.6 |                23.7 |
|          16 | 122.0 / 1239.6 / 1983.8 |                37.7 |

All 384 responses matched their strong baselines. These phases ran sequentially without resetting caches, so their throughput is not an isolated concurrency scaling comparison. The first phase included cold requests of 1.3, 3.3 and 7.3 seconds; the maximum observed latency was 7.3 seconds. This exposes a remaining cold-I/O problem despite improved warm medians. The later contiguous-term range implementation is separately verified by range-count tests and requires its own deployed comparison. This load run does not compare Turbopuffer throughput.
