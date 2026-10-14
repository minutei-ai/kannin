# Deployed BM25 comparison

This is a bounded synthetic measurement, not a general parity claim. Both services received the same 10,000 documents. The client ran in Brazil; Cloudflare HTTP responses came from GRU, and Turbopuffer used aws-sa-east-1. At the time of this measurement, Kannin strong reads used a coordinator outside South America. An experiment fetching the canonical R2 manifest directly in the edge Worker was evaluated separately below and reverted after it regressed latency. Kannin edge reads use the explicit less-than-one-second snapshot contract, with minimumSequence set to the final acknowledged write. Turbopuffer reads are strong. Those guarantees differ even when the static corpus produces identical Kannin rows.

Each case has five warmups followed by 50 sequential measured requests per engine. Each iteration runs Kannin strong, Kannin edge, then Turbopuffer. The report records the first request separately; it does not prove a cold process. Timings include HTTP, response body consumption and decoding. No query-result cache is used. Fifty observations provide limited evidence about tail latency; raw samples and operational targets stay outside this public repository.

| Query     | Kannin strong p50 / p95 ms | Kannin edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -------------------------: | -----------------------: | ------------------------------: |
| rare      |              188.5 / 219.2 |              62.5 / 76.6 |                     64.4 / 78.5 |
| selective |              197.1 / 215.5 |              77.6 / 99.8 |                     67.8 / 85.0 |
| common    |              191.3 / 201.6 |              71.3 / 96.6 |                     82.7 / 90.3 |
| filtered  |              204.9 / 224.8 |             92.2 / 131.7 |                     81.1 / 89.6 |

Sequential ingestion in batches of 500 took 46.74 seconds for Kannin and 7.12 seconds for Turbopuffer. This measures acknowledged writes, not asynchronous vector visibility. The temporary Turbopuffer comparator was deleted after the completed run.

Corpus SHA-256: `2b6257d0fce1b430f1a4b91b6cca9af481da8aa820142cc94ca628cb5cee03f2`. Worker SHA-256: `0ddb644ba06cdef53e877a398fcb4a6dcebbc9d323039f677e4ca901c9d5925c`. WASM SHA-256: `a4d1fdf2a4a397dc4978dede178269c71e49954a15eb347ed15ac367d0813254`. Bun 1.4.3; Rust 1.96; Effect 4.0.4; Alchemy 2.0.0-beta.83. The executable corpus and comparison live in `tooling/corpus.ts` and `tooling/compare.ts`.

Before proactive refresh, edge p95 ranged from 269 to 378 ms because expired snapshots blocked on R2. Refreshing still-valid snapshots in native background work reduced that penalty without extending the age limit. Ingestion throughput, 1,000,000-document scale, concurrency, broader ranking judgments, vector recall and cost remain delivery gates. The public SciFact evaluation is recorded separately in quality.md.

## 100,000-document follow-up

After bounded filter-mask caching, tighter exact score bounds and separation of the logical one-second snapshot age from the physical two-second cache expiry, a follow-up reused the existing Kannin corpus and created a fresh Turbopuffer comparator with identical documents. This run measured query latency only; Kannin ingestion was not repeated. The same sequential client methodology and consistency differences apply.

| Query     | Kannin strong p50 / p95 ms | Kannin edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -------------------------: | -----------------------: | ------------------------------: |
| rare      |              191.6 / 235.7 |             71.8 / 110.3 |                     57.2 / 58.0 |
| selective |              196.3 / 224.2 |             88.1 / 148.9 |                     56.9 / 57.8 |
| common    |              213.1 / 231.7 |            105.6 / 153.8 |                     76.2 / 76.9 |
| filtered  |              205.0 / 230.3 |             98.1 / 164.2 |                     72.5 / 74.6 |

Corpus SHA-256: `e23ae431deaee2436ee6674a7834e57663739b6c5bd723b7c9137c4ab123dbfb`. The comparator was deleted after the run. Edge p99 ranged from 168.2 to 239.6 ms. This result does not establish performance parity: strong reads retain the coordinator hop, and edge tails remain above the comparator. Turbopuffer reported different exhaustive-search counts across repeated runs on the same synthetic corpus, so comparisons must record indexing state and cannot attribute every cross-run change to Kannin. Neither this run nor the earlier 10,000-document run proves sustained concurrent throughput.

## Rejected direct-R2 strong-read experiment

An uncached canonical R2 manifest read can select a strongly consistent snapshot without a coordinator hop, but the deployed measurement was slower. On the same 100,000-document Kannin corpus, direct-R2 strong p50 ranged from 263.0 to 294.0 ms and p95 from 403.5 to 495.9 ms. Edge p50 ranged from 65.3 to 116.1 ms. The fresh Turbopuffer comparator completed indexing before measurement; its strong p50 ranged from 49.6 to 50.3 ms. The direct-R2 request path was reverted, preserving the faster coordinator-backed strong path. This evidence does not prove that bucket placement alone explains the regression.

The updated comparison driver waits for native Turbopuffer metadata to report an up-to-date index, with a bounded observation window, before running measured queries. The metadata response did not supply the declared unindexed row count during that observation, so progress reporting uses the native index status only. The comparator was deleted after the run. Further work must address R2 acquisition latency and cold edge directory-cache tails before a parity claim.

## Bounded parallel-read follow-up

The deployed implementation at `f00df9e` loads dictionaries and result documents with concurrency four and reads postings in windows of four blocks. On the same 100,000-document corpus, with a fresh comparator fully indexed before query measurement, the sequential results were:

| Query     | Kannin strong p50 / p95 ms | Kannin edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -------------------------: | -----------------------: | ------------------------------: |
| rare      |              181.4 / 215.2 |              55.9 / 86.1 |                    51.6 / 321.6 |
| selective |              186.9 / 200.8 |             62.4 / 109.1 |                     49.5 / 52.6 |
| common    |              197.3 / 216.4 |              73.0 / 98.7 |                     50.2 / 53.4 |
| filtered  |              193.1 / 214.7 |             69.7 / 100.5 |                     50.5 / 53.2 |

The comparator was deleted. One rare-query comparator tail reached 1,057.5 ms; the other comparator cases had p95 near 53 ms. Edge medians improved relative to the preceding measurements, but cold tails remain and the consistency contracts still differ.

The separate `tooling/load.ts` driver checks every edge response against a strong baseline, including IDs, scores, revisions and corpus sequence. It ran mixed rare, selective, common and filtered requests on the same deployed corpus, in phases of 128 requests at concurrency 1, 4 and 16:

| Concurrency |      p50 / p95 / p99 ms | Requests per second |
| ----------: | ----------------------: | ------------------: |
|           1 |  106.6 / 546.7 / 2455.8 |                 3.8 |
|           4 |   91.3 / 350.6 / 1385.6 |                23.7 |
|          16 | 122.0 / 1239.6 / 1983.8 |                37.7 |

All 384 responses matched their strong baselines. These phases ran sequentially without resetting caches, so their throughput is not an isolated concurrency scaling comparison. The first phase included cold requests of 1.3, 3.3 and 7.3 seconds; the maximum observed latency was 7.3 seconds. This exposes a remaining cold-I/O problem despite improved warm medians. The later contiguous-term range implementation is separately verified by range-count tests and requires its own deployed comparison. This load run does not compare Turbopuffer throughput.

## Contiguous-term range load follow-up

The deployed implementation at `faa310e` retains the same corpus, scorer and concurrency bounds, and coalesces contiguous blocks into one read per requested term. Every response in a second 384-request load run again matched the strong baseline. The concurrency 1/4/16 phases respectively measured p50 of 104.6/89.3/110.6 ms, p95 of 542.0/190.3/1,090.5 ms and throughput of 5.4/29.1/45.4 requests per second. The maximum observed latency fell from 7.3 seconds to 3.4 seconds, but the first selective request still took 3.4 seconds. These are separate sequential load runs with cache warming and infrastructure variability; they support the range-read improvement but do not isolate its causal effect or establish parity. Cold dictionary acquisition, R2 snapshot acquisition and concurrent tails still require investigation.

The sequential comparison after coalescing, using the same static 100,000-document corpus and a fresh up-to-date Turbopuffer index, produced:

| Query     | Kannin strong p50 / p95 ms | Kannin edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| --------- | -------------------------: | -----------------------: | ------------------------------: |
| rare      |              165.3 / 194.8 |              53.4 / 77.2 |                     73.3 / 74.4 |
| selective |              172.0 / 187.2 |              63.8 / 87.1 |                     72.5 / 73.6 |
| common    |              181.6 / 196.7 |              68.7 / 95.7 |                   105.0 / 105.8 |
| filtered  |              177.4 / 189.7 |             68.2 / 102.1 |                     98.2 / 99.3 |

The comparator was deleted after the completed run. Edge medians were below this run's comparator medians, while strong Kannin reads remained slower. Selective edge p99 still reached 691.7 ms. The earlier comparator runs had substantially lower medians, and this run did not test concurrent comparator throughput. These results support continued investigation; they do not establish general parity across consistency modes, cold state, concurrency or larger corpora.

The query responses in the latest sequential run still reported 22,000 exhaustively searched rows despite the earlier metadata readiness result. [Metadata](https://turbopuffer.com/docs/metadata) and [query metrics](https://turbopuffer.com/docs/query) describe that count as unindexed rows, so metadata readiness alone cannot establish a fully indexed comparison. The driver now requires query-level exhaustive-search count zero before collecting samples and aborts if that condition changes. Earlier tables remain historical measurements, rather than proof of fully indexed parity.

## Benchmark operations

To exercise an already populated deterministic benchmark namespace, run `RAIO_LOAD_NAMESPACE=<owned-benchmark-namespace> bun tooling/load.ts` with `RAIO_URL` and `RAIO_API_TOKEN` supplied outside the repository. `RAIO_LOAD_REQUESTS` defaults to 128 per concurrency phase. The driver verifies every edge result against a strong baseline and reports concurrency 1, 4 and 16 separately. It does not mutate the corpus.

For an interrupted native ingestion, `RAIO_BENCH_RESUME_NAMESPACE=<owned-benchmark-namespace>` replays the deterministic batches with the original request IDs. R2 receipts prevent duplicate commits and reject payload changes. Resume verifies a nonempty existing corpus no larger than the requested size; a fresh Turbopuffer comparator is created and cleaned up independently. `RAIO_BENCH_REUSE_NAMESPACE` skips completed Kannin ingestion instead. These options are mutually exclusive. Keep the executable corpus and requested size unchanged when resuming.

## Queue batching and query encoding follow-up

The implementation at `e966ac4` reuses encoded terms, filters and global statistics per text query, removes a redundant final sort, and batches committed vector jobs through native Queues. A repeated local 100,000-document benchmark measured strong p50 of 3.46/24.74/26.50/26.79 ms for rare/selective/common/filtered queries, compared with 4.06/40.37/39.81/46.77 ms before this change. Local ingestion measured 4,350 documents/s. These sequential runs use the same corpus and unchanged WASM scorer; system variation still prevents attributing every difference to one code change.

Two deployed load runs used the same static corpus, client and 64 mixed-query requests per concurrency phase. All 192 responses in each run matched the strong baseline, including ids, scores, revisions and sequence.

| Concurrency | Before p50 / p95 ms | After p50 / p95 ms | Before / after requests per second |
| ----------- | ------------------- | ------------------ | ---------------------------------- |
| 1           | 57.3 / 110.1        | 56.7 / 223.6       | 6.0 / 4.7                          |
| 4           | 75.9 / 799.1        | 62.4 / 269.8       | 21.0 / 28.8                        |
| 16          | 90.9 / 1362.7       | 104.8 / 1208.0     | 28.8 / 35.6                        |

The first phase became slower at the tail, despite similar medians. Dictionary acquisition remains the largest cold interval. Phases run sequentially, caches are not reset between phases, and deployment changes process/cache state. The higher concurrency measurements improved in this run, but they do not establish isolated scaling, a universal improvement or Turbopuffer parity.

The native vector smoke now observes equality and numeric intervals independently within bounded windows. Equality visibility does not establish that a numeric predicate is already visible. An initial numeric check failed immediately after equality reached its target; later reads from the same namespace returned the expected five interval rows with the outbox already empty. This is provider visibility observation, not evidence of lost canonical state. Index acceptance and query visibility remain separate.

A subsequent complete 100-vector native smoke passed with recall@10 of 1.0 for the controlled expected neighbors and all five numeric-interval candidates. Equality required 35 observations and the subsequent numeric window required eight; these are independent readiness checks, not a global index-ready guarantee.

## Conjunctive query pruning

`all` and phrase queries now use both the manifest Bloom intersection and exact live per-segment document frequencies before reading postings. This preserves global statistics from every candidate dictionary, repeated-word semantics, positional matching and tombstones. Immutable segment bytes and the Rust scorer are unchanged.

Native workerd regressions first failed on the previous implementation: a 30-segment fixture read 62 ranges for `all` and 61 for a repeated-word phrase with no positional match. The optimized implementation reads 33 and 32 respectively, eliminating 29 unnecessary posting reads. A two-segment impossible intersection changed from two directory reads to zero. Deleting the only document containing a shared required term also skips postings, even while the immutable Bloom remains positive.

A separate local workload wrote 30 batches of 500 documents: the first 29 segments contain `cloudflare storage`, and the final segment contains `cloudflare rust`. Each id is `<batch>-<row>`. Both queries use `cloudflare rust`, top-k 10, no filters and edge-eventual consistency. Each mode uses a separate namespace in the same process; five warmups precede 50 measured HTTP requests. All measured rows and scores equal the first response, and the before/after rows agree.

| Mode   | Before p50 / p95 ms | After p50 / p95 ms | First-query range reads before / after |
| ------ | ------------------- | ------------------ | -------------------------------------- |
| all    | 14.11 / 18.43       | 6.83 / 9.56        | 46 / 17                                |
| phrase | 13.91 / 20.05       | 5.88 / 7.66        | 46 / 17                                |

The first query after ingestion measured 182.05 → 84.96 ms for `all` and 153.01 → 66.91 ms for phrase. Ingestion itself may warm immutable directories, so these are not fully cold-cache measurements. Separate runs and host variation limit causal timing attribution; the eliminated range reads are deterministic in the smaller regression. Directory bytes still dominate transfer: first-query range bytes changed from 335,477 to 331,678. Queries requiring all directories still pay that acquisition cost.

The standard 100,000-document benchmark also passed: strong p50 was 3.46/23.87/25.80/26.60 ms for rare/selective/common/filtered cases, and edge p50 was 2.99/23.12/28.33/26.69 ms. This workload uses `any` matching, so it does not exercise conjunctive pruning. Its edge common-query p95 rose to 52.58 ms; it does not establish a universal improvement. Ingestion measured 22.18 seconds, approximately 4,509 documents/s. Corpus SHA-256 remains `e23ae431deaee2436ee6674a7834e57663739b6c5bd723b7c9137c4ab123dbfb`; Worker SHA-256 is `8e465d169bfe7927fe466cc1a46485b241fa1138b1c62dbb7047af13e41fb954`, and WASM SHA-256 remains `aaeae13235476d95e4949f5066d6dc5b1f68d2f8c3eba41b209b432dcdab8b57`.

Alchemy deployed runtime `c14445d` successfully. Twelve native checks on the existing static 100,000-document corpus covered `all` and phrase, common and selective matches, and empty results in both strong and edge modes. Every id, score, revision, attribute and sequence matched the pre-deploy results; responses remained private/no-store. SciFact's 300 judged queries retained nDCG@10 0.67306, recall@10 0.79567 and MRR@10 0.64181.

These native checks are correctness probes, with one sample per case and no cache reset. Before deployment, the first selective edge query took 12.62 seconds; after deployment it took 422.78 ms. However, the first common edge query rose from 1.88 to 4.83 seconds. Cache state, deployment and infrastructure vary, so these observations do not establish isolated latency gains. Cold directory acquisition remains unresolved.

## Immutable term projections

The query path now caches each immutable segment's selected term metadata independently from its full document directory. The private native `Terms` entrypoint and Cache API return only frequencies and posting-block metadata. The 4 MiB process LRU reuses decoded catalogs across match modes, phrase order and filters; live statistics and returned documents remain query scoped. Physical bucket identity in native props permits cross-version Workers Cache for immutable responses while the public gateway stays uncached. See [Cloudflare's cache-key contract](https://developers.cloudflare.com/workers/cache/cache-keys/) and [configuration](https://developers.cloudflare.com/workers/cache/configuration/).

Two regressions failed before the relevant changes. After explicitly discarding directory memory, a 30-segment conjunctive query changed from 33 range reads to four. An unfiltered equal-score top-k over 16 segments changed from 19 to four. Returned rows and scores stayed identical. Phase order, filters, updates and sequence barriers have separate coverage. A concurrency regression exposed duplicate caches for distinct binding references to the same physical bucket; physical-name identities removed that split, and ten isolated twelve-query repeats each retained the original thirteen range reads.

The final local benchmark uses the same 100,000-document corpus, five warmups and 50 measured requests per case/mode as the preceding run.

| Query     | Before strong p50 / p95 ms | After strong p50 / p95 ms | After edge p50 / p95 ms |
| --------- | -------------------------- | ------------------------- | ----------------------- |
| rare      | 3.46 / 4.45                | 4.10 / 8.10               | 2.89 / 4.05             |
| selective | 23.87 / 30.14              | 16.64 / 26.07             | 14.48 / 21.41           |
| common    | 25.80 / 32.46              | 19.97 / 54.87             | 18.80 / 27.06           |
| filtered  | 26.60 / 33.69              | 19.06 / 23.86             | 19.47 / 27.30           |

Selective, common and filtered strong medians fell approximately 30%, 23% and 28%. Rare strong requests and the common strong tail became slower in this run. An earlier projection run measured common strong p95 of 27.99 ms, so host variation still affects the tails. These sequential experiments do not establish a universal latency improvement. Ingestion measured 23.32 seconds, approximately 4,289 documents/s. The term cache charged about 2.1 MiB in the earlier projection run.

Worker SHA-256: `6f0254f21549930e8e728e2b4107e36480a1b6650043f8400eb7bcabdaf203ad`. WASM SHA-256: `a99ca9af338335f621d1b945b3a948afafec250bfddae4d4b18bcfc53bc3b7f7`. The corpus SHA-256 remains `e23ae431deaee2436ee6674a7834e57663739b6c5bd723b7c9137c4ab123dbfb`. Independent SciFact judgments remain nDCG@10 0.67306, recall@10 0.79567 and MRR@10 0.64181. Immutable R2 segment bytes and framing are unchanged.

A fresh native baseline on the preceding deployed runtime completed the concurrency 1 and 4 phases with 64 matched responses each, then returned HTTP 503 during concurrency 16 and aborted. The completed phases recorded p50/p95 83.05/170.99 ms and 84.00/424.26 ms respectively. The interrupted phase is not a completed benchmark; its response body was not recorded, so the underlying failure is unclassified. Cache state is uncontrolled, and no successful scaling or before/after claim is based on that partial run.

Runtime `db3a373` deployed successfully and its CI passed. The subsequent native mixed-query run completed all 192 result checks, including concurrency 16, without HTTP errors. Each response matched its strong baseline in ids, scores, attributes, revisions and sequence.

| Concurrency | Requests | p50 / p95 / p99 ms         | Requests per second |
| ----------- | -------- | -------------------------- | ------------------- |
| 1           | 64       | 95.86 / 1807.06 / 2338.51  | 3.51                |
| 4           | 64       | 91.08 / 829.00 / 1579.01   | 18.00               |
| 16          | 64       | 100.59 / 1647.09 / 1978.92 | 28.53               |

These tails are slower than the completed phases of the preceding partial baseline. The new run's success does not classify or prove resolution of the earlier 503, and the timings do not establish a native latency win. The first directory interval reached 2.36 seconds. Twelve additional native conjunctive checks retained exactly the pre-optimization rows and scores, but first-query latency still reached 1.72 seconds. Cold acquisition remains open.

A subsequent strong query observed 32 term-catalog reads with 32 native Workers Cache hits and sixteen range reads with sixteen native Workers Cache hits. The term responses transferred 242,640 bytes, with no L1 term hits in that observed process. Reading metadata immediately after the query confirmed the counters. An earlier idle-process metadata read returned zero counters, so these remain process observations rather than persistent billing totals. This verifies native cache delivery of projections; retention across a separate deployment is not inferred from this same-version observation.

## Segment evaluation priority

Reusable unfiltered bounds now prioritize segments by descending potential score, breaking ties with the physical minimum document id in UTF-16 order. A regression writing sixteen equal-score segments in reverse id order first read 49 ranges; after prioritization it reads nineteen and returns the same lowest-id winner. The independent score oracle and mutation/Unicode tests remain green.

Computing extra unfiltered bounds for filtered segments regressed the first local follow-up's filtered median to 26.47 ms. The final implementation computes priority bounds only for unfiltered segments without tombstones; other segments retain their existing eligible-document bound. A repeat measured filtered strong median 20.57 ms. This preserves exact pruning and avoids that redundant bound work, without claiming universal timing improvement.

The final 100,000-document run measured strong p50/p95 of 3.45/4.85, 18.43/26.98, 20.15/26.29 and 20.57/33.00 ms for rare/selective/common/filtered queries. Edge values were 3.03/3.76, 14.29/22.08, 21.81/41.22 and 22.59/43.64 ms. Ingestion measured 22.50 seconds, approximately 4,445 documents/s. The corpus and WASM hashes are unchanged from the projection run; Worker SHA-256 is `5864ee5aff2abe71154a7325016be93b4b27ebb1d79d624b1b4dc04f048115ae`.

Runtime `9278a40` deployed successfully and its CI passed. The first observed strong query after this second deployment received all 32 term catalogs with native Workers Cache HITs and no L1 term hits. The term selector, bucket and immutable objects matched the preceding deployed runtime, confirming reuse across the Worker version change. Range counters also reported 46 HITs, but include migration work and are not attributed exclusively to that query.

A subsequent 192-query native load completed without HTTP errors and retained every strong-baseline result. Concurrency 1/4/16 measured p50 56.20/52.62/90.89 ms, p95 297.86/763.98/2255.38 ms, p99 545.66/2307.34/3035.30 ms and throughput 9.13/16.40/16.92 requests/s. Medians improved from the preceding projection run, while the concurrency-16 tail and throughput regressed. Cache warming and infrastructure variation remain uncontrolled.

The remaining largest observed interval moved to `text_rank`: maxima were 1504, 1732 and 2321 ms across the three phases, compared with dictionary maxima 86, 72 and 367 ms. These intervals include acquisition and I/O, not just CPU. Filtered/tombstoned bounds still acquire full directories, and this path needs further optimization. Neither these measurements nor cache-hit proof complete the cold-query or broad scaling goal.

## Physical filter eligibility projections

The `catalog-v2` private cache response now includes the minimum title/body lengths of physically filter-eligible documents. The selector contains both sorted terms and the exact filter predicate. A null minimum proves physical ineligibility; the dictionary still contributes namespace-wide DF before that segment is skipped. Deletions do not change physical attributes, so cached minima can only be lower than the live eligible minima and provide conservative bounds. Live statistics and tombstones still apply at the current root and exact ranker.

The previous `Directory.upper_bound` path has been removed. Every segment's query-specific bound now derives from the cached projection and current live statistics, without acquiring its full document directory. Candidate ranking and result materialization still load the directories they need. The new private path and Cache API namespace avoid interpreting a version-1 response as the new shape; canonical R2 framing and persisted manifests are unchanged.

A filtered top-k regression first read nineteen ranges after directory eviction and now reads four, with identical rows and scores. Separate regressions preserve global DF from ineligible segments, deletion of the shortest eligible document, negative eligibility across attribute updates, and phrase-order/filter/revision isolation.

The 100,000-document local run measured strong p50/p95 3.55/4.94, 16.70/25.76, 21.40/28.57 and 19.21/27.30 ms for rare/selective/common/filtered queries. Edge values were 3.15/3.44, 18.25/26.85, 22.37/30.03 and 20.18/27.54 ms. Ingestion measured 23.61 seconds, approximately 4,235 documents/s. Warm medians vary modestly from the preceding run; the deterministic range reduction concerns directory eviction, not a general warm latency claim. Worker SHA-256 is `79abfa72fa91b767e76d1cd7a6f72d4d25de782e9a36e08a775f0f4238c51528`; WASM SHA-256 is `7a6fabfcd0a8473a920af63d5afe6121a94437845f851f7c6d2cf4a69d7d3556`. Corpus SHA-256 remains `e23ae431deaee2436ee6674a7834e57663739b6c5bd723b7c9137c4ab123dbfb`.

A fresh native pre-change run completed all 192 strong-baseline comparisons. Concurrency 1/4/16 measured p50 89.90/153.63/178.44 ms, p95 398.42/1472.63/1333.52 ms and throughput 5.91/9.09/25.75 requests/s. These are a fresh comparison baseline, distinct from historical runs and their cache state.
