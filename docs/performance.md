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

Before proactive refresh, edge p95 ranged from 269 to 378 ms because expired snapshots blocked on R2. Refreshing still-valid snapshots in native background work reduced that penalty without extending the age limit. Native ingestion throughput, native 1,000,000-document scale, concurrency, broader ranking judgments, vector recall and cost remain delivery gates. The public SciFact evaluation is recorded separately in quality.md.

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

Runtime `341e41c` deployed successfully and its CI passed. The first native load after deployment returned HTTP 503 during concurrency 1 and aborted; its old diagnostic did not capture the body, so the failure remains unclassified. Eight subsequent strong/edge diagnostic reads passed, and twelve conjunctive comparisons retained the original rows and scores. The load driver now consumes error bodies and records bounded wire details, query, server timing and request trace id on non-success responses. This improves future diagnosis without hiding or retrying failed samples.

A second native load completed all 192 strong-baseline comparisons without HTTP errors.

| Concurrency | Before p50 / p95 ms | After p50 / p95 ms | Before / after requests per second |
| ----------- | ------------------- | ------------------ | ---------------------------------- |
| 1           | 89.90 / 398.42      | 159.18 / 223.05    | 5.91 / 5.56                        |
| 4           | 153.63 / 1472.63    | 162.46 / 297.35    | 9.09 / 18.99                       |
| 16          | 178.44 / 1333.52    | 162.00 / 815.20    | 25.75 / 46.07                      |

The concurrency-1 median became slower. Separate sequential runs, deployment and cache warming limit timing attribution, and the completed second run does not classify or prove resolution of the first 503. Ranking acquisition intervals decreased: `text_rank` maxima changed from 1442/2160/1421 ms to 44/271/498 ms. Dictionary maxima were 110/109/146 ms after the change. Native clocks measure elapsed I/O intervals here, not isolated CPU. An immediate filtered strong query observed native projection/range HIT counters with about 2.17 MiB of decoded directory charge; the counters are process scoped and include preceding work.

SciFact's 300 judgments retained nDCG@10 0.67306, recall@10 0.79567 and MRR@10 0.64181. Local checks passed 100 Worker/tooling tests and 17 Rust tests, including strict lint and compiler rejection probes. General latency guarantees, the unclassified intermittent 503 and broad vector/hybrid throughput remain open.

## Vector document materialization and hybrid execution

A vector top-1 regression previously read all twenty candidate document pages; it now reads one and returns the same row. Canonical revision/epoch, vector presence and residual filters are validated before slicing eligible candidates. Validation and page reads each have concurrency four and retain provider order. The root's empty document count short-circuits the provider after input validation. Filter encoding is reused per query. Hybrid branches now start concurrently over one root view, while text-only responses avoid a duplicate map/sort at the outer query boundary.

A local native-workerd experiment uses 100 documents with identical unit vectors, sequential padded ids and `lexical cloudflare rust` text. Each case has five warmups and thirty measured requests; every measured row and score equals its initial result and the pre-change result. The Vectorize backend is a deterministic contract fixture, so these figures measure adapter/materialization overhead and cannot establish native ANN speed.

| Mode   | Top-k | Before p50 / p95 ms | After p50 / p95 ms |
| ------ | ----- | ------------------- | ------------------ |
| vector | 1     | 23.45 / 34.02       | 10.12 / 13.00      |
| vector | 10    | 22.60 / 27.67       | 12.51 / 16.48      |
| vector | 50    | 24.70 / 45.28       | 20.97 / 24.13      |
| hybrid | 1     | 25.14 / 37.61       | 10.73 / 16.71      |
| hybrid | 10    | 23.78 / 31.98       | 17.25 / 22.85      |
| hybrid | 50    | 34.61 / 41.15       | 34.99 / 41.97      |

An intermediate vector-only change measured hybrid top-50 p50 34.14 ms; parallelization did not demonstrate an additional local gain on this CPU-bound fixture. Native provider I/O requires separate proof. `vector_index`, `vector_reconcile` and `vector_documents` server timings now separate the relevant intervals, including I/O rather than isolated CPU.

A read-only native pre-change baseline reused the previously validated 100-vector corpus. It covered vector/hybrid top-k 1/10/50 plus filtered top-10, with five warmups and twenty measured requests per case. All 200 responses retained a stable ranking, revision and sequence within each case; vector medians were 283.93/278.56/278.55 ms and filtered 258.22 ms, while hybrid medians were 288.03/288.53/298.66 ms and filtered 263.43 ms. This is a controlled small-corpus baseline, not broad ANN recall evidence. Live Alchemy tailing was enabled during the run; no 503 or exception was observed in the returned stream, and the client checked every response. The historical failure remains unclassified.

Unexpected failures now emit native Effect error records before transport mapping at the term projection, namespace coordinator and gateway. Server-side rejections are recorded too; expected client errors do not enter this path. The public generic error response is unchanged. This enables future live-tail diagnosis without retries or a claim that the historical 503 has been resolved. The complete local gate passed 101 Worker/tooling tests and 17 Rust tests.

Runtime `2ffcafc` deployed successfully. The native post-change run completed the same 200 checks, with every case's ids, scores, attributes, revisions and sequence exactly equal to the pre-change run. Live Alchemy tailing recorded no 503 or exception during either controlled retrieval run.

| Mode   | Top-k | Filtered | Before p50 / p95 ms | After p50 / p95 ms |
| ------ | ----- | -------- | ------------------- | ------------------ |
| vector | 1     | no       | 283.93 / 297.57     | 303.33 / 334.31    |
| vector | 10    | no       | 278.56 / 297.81     | 293.30 / 331.62    |
| vector | 50    | no       | 278.55 / 294.25     | 310.74 / 437.66    |
| vector | 10    | yes      | 258.22 / 283.71     | 288.01 / 317.63    |
| hybrid | 1     | no       | 288.03 / 306.62     | 288.76 / 303.64    |
| hybrid | 10    | no       | 288.53 / 323.54     | 298.20 / 749.06    |
| hybrid | 50    | no       | 298.66 / 324.80     | 326.24 / 439.86    |
| hybrid | 10    | yes      | 263.43 / 280.32     | 290.63 / 388.60    |

The native run became slower in most cases despite fewer document reads and lower local adapter cost. Provider/network variation and deployment/cache state are uncontrolled. These results establish correct native behavior, not a native latency win. Post-change index interval medians were 115–131 ms; reconciliation/document medians were zero in the native I/O clock, which does not isolate CPU. Gateway medians added about 127 ms beyond the coordinator in unfiltered vector cases.

Moving this existing coordinator to Brazil is not an available documented placement operation: Cloudflare's current [data-location contract](https://developers.cloudflare.com/durable-objects/reference/data-location/) says existing objects do not relocate and `sam` hints currently instantiate in Eastern North America. The R2-first durability and strong-read contracts remain unchanged; no namespace replacement or weakened consistency was used to create an artificial latency gain. These platform constraints and the unclassified historical 503 keep the overall performance objective open.

## Bounded vector candidate windows

Previously, vector top-1 materialized one page but still located every one of up to fifty provider candidates. Reconciliation now advances through ordered windows, sized to the remaining top-k with a minimum of four. It stops only after enough live eligible matches are found or the complete provider list is exhausted. All provider metadata is decoded first; epoch/revision/vector-presence and residual filters still apply before top-k.

A native workerd regression with twenty vectors in twenty immutable segments first read 21 ranges after directory-memory eviction and now reads five. A separate regression advances through stale revisions and non-indexed residual predicates, returning the same three live candidates before and after compaction.

A controlled local experiment used fifty vectors in fifty segments and the real native workerd/R2/DO path with a deterministic ANN fixture. Each query explicitly discards the process's immutable caches; Cache API remains warm. Five warmups precede twenty measured requests for each top-k. The baseline bundle was compiled from the preceding public commit `e65f983` with the same resolved dependencies and unchanged WASM engine, outside the tracked repository. Every before/after row and score agreed.

| Top-k | Before p50 / p95 ms | After p50 / p95 ms | Before / after range reads |
| ----- | ------------------- | ------------------ | -------------------------- |
| 1     | 63.67 / 70.40       | 10.51 / 12.40      | 51 / 5                     |
| 10    | 74.15 / 88.78       | 28.21 / 32.60      | 60 / 20                    |
| 50    | 112.41 / 124.60     | 115.69 / 132.44    | 100 / 100                  |

The full top-50 requires all candidate locations and pages; its timing regressed modestly in this run. These measurements isolate process-cache eviction in the local adapter, not a fully cold Cloudflare ANN service. Large native corpus throughput and consistent latency still require proof.

Runtime `09418f5` deployed successfully and its full CI passed. A new native corpus contains 96 vectors in 32 immutable segments, with distinct cosine scores and exact long-string metadata filtering. Five warmups precede twenty measured requests per case. Baseline and isolated post-deploy runs each completed 200 requests without errors; all eight cases retained identical rows, scores, attributes and revisions. A first post-deploy run overlapped the separate BM25 load and is treated as correctness evidence only; the table uses the subsequent isolated run.

| Native case        | Before p50 / p95 ms | After p50 / p95 ms |
| ------------------ | ------------------- | ------------------ |
| Vector 1           | 275.36 / 299.72     | 270.89 / 317.65    |
| Vector 10          | 263.49 / 286.89     | 261.73 / 328.84    |
| Vector 50          | 285.91 / 430.52     | 300.30 / 532.36    |
| Vector filtered 10 | 266.66 / 278.88     | 269.33 / 300.53    |
| Hybrid 1           | 266.82 / 282.51     | 266.65 / 279.11    |
| Hybrid 10          | 271.46 / 286.81     | 279.70 / 302.02    |
| Hybrid 50          | 317.61 / 545.20     | 311.15 / 341.37    |
| Hybrid filtered 10 | 273.39 / 285.31     | 272.30 / 293.87    |

The local I/O reduction does not produce a consistent native latency improvement. Several p95 values regressed. A separate 192-request native BM25 load on the unchanged 100,000-document corpus also completed without errors: concurrency 1/4/16 p50 was 56.09/62.48/75.89 ms, p95 200.90/187.76/688.30 ms, throughput 11.52/38.49/50.95 requests/s. That load overlapped the first retrieval run and is not an isolated causal comparison. The broad performance objective remains open.

## Rejected direct strong reads from R2

Runtime `560abfd` tested uncached canonical manifest reads and query execution in the authenticated edge Worker, removing the strong-query coordinator hop. It used the native R2 binding's [global read-after-write guarantee](https://developers.cloudflare.com/r2/reference/consistency/), retained the sequence barrier, rejected missing acknowledged manifests and bounded selection plus evaluation to 30 seconds under the existing 24-hour segment quarantine. The full local gate passed with 106 Worker/tooling and 17 Rust tests. Concurrent queries observed complete revisions while writes advanced.

Correctness passed, but native latency regressed. Baseline and experimental retrieval runs each completed 200 requests on the same 96-vector, 32-segment corpus, with five warmups and twenty measured requests per case; every row and score matched across runs. The runs did not overlap the separate BM25 loads.

| Native case        | Coordinator p50 / p95 ms | Direct R2 p50 / p95 ms |
| ------------------ | ------------------------ | ---------------------- |
| Vector 1           | 259.96 / 295.13          | 468.52 / 756.20        |
| Vector 10          | 257.58 / 274.82          | 465.11 / 691.71        |
| Vector 50          | 285.79 / 501.19          | 489.85 / 681.75        |
| Vector filtered 10 | 257.64 / 274.72          | 459.25 / 710.53        |
| Hybrid 1           | 260.81 / 271.25          | 455.95 / 682.45        |
| Hybrid 10          | 266.99 / 283.34          | 465.85 / 705.76        |
| Hybrid 50          | 315.07 / 562.18          | 513.23 / 784.42        |
| Hybrid filtered 10 | 263.60 / 277.00          | 464.23 / 735.45        |

Separate strong-consistency BM25 loads each completed 192 requests over the unchanged 100,000-document corpus and checked every response against the strong baseline.

| Concurrency | Coordinator p50 / p95 ms | Direct R2 p50 / p95 ms | Coordinator / direct R2 requests/s |
| ----------- | ------------------------ | ---------------------- | ---------------------------------- |
| 1           | 199.08 / 263.12          | 332.40 / 787.30        | 4.83 / 2.37                        |
| 4           | 204.33 / 268.95          | 314.43 / 640.59        | 18.37 / 10.35                      |
| 16          | 338.89 / 413.60          | 344.66 / 951.04        | 46.28 / 31.29                      |

The experimental native `strong_snapshot` interval included 203–507 ms in the first four measured responses, dominating their I/O intervals. The local 100,000-document benchmark also paid fresh-root decoding: strong rare/selective/common/filtered p50 was 5.84/19.14/23.94/21.93 ms. This deployment did not benefit from exchanging coordinator access for a fresh R2 GET per query. Runtime `877a403` reverts that path; strong queries again use the coordinator, with no additional R2 GET or snapshot cache. The concurrent revision regression remains in the suite. No consistency contract was relaxed to compensate for latency.

## Conditional manifest reads and bounded ANN caching

Runtime `4c7e246` tried bodyless conditional R2 GETs against a bounded 4 MiB decoded manifest-version cache. Every query validated the ETag with R2; the local full gate passed. Despite avoiding unchanged-body transfer, a native strong BM25 load over 100,000 documents still regressed. Baseline and experimental runs each completed 192 correct requests: concurrency 1/4/16 p50 changed from 176.58/181.36/244.30 to 270.06/275.09/335.60 ms, p95 from 198.29/221.25/349.52 to 428.78/988.30/722.06 ms, throughput from 5.58/20.82/53.37 to 3.32/9.36/30.94 requests/s. Runtime `e39fa4c` reverted the experiment. Strong manifest acquisition remains with the coordinator.

Runtime `81755b2` instead caches only ANN candidates with native Cache API for one second. The key includes the canonical epoch, sequence and outbox, physical bucket and query/filter configuration. Every hit still reconciles revisions, vector presence and residual filters against the live strong R2 view before materializing documents. Empty responses and failures are not cached. The workerd regression checks provider call counts, expiry and mutation invalidation. The final suite passes 105 Worker/tooling and 17 Rust tests.

A native before/after comparison used the same 96-vector, 32-segment corpus, with five warmups and twenty measured requests per case. Both runs completed 200 requests; all rows, scores, attributes and revisions agreed. The workload repeats each query rapidly and measures TTL reuse, not unique-query latency or fully cold ANN service.

| Native case        | Before p50 / p95 ms | Cache p50 / p95 ms | Measured hits / 20 |
| ------------------ | ------------------- | ------------------ | ------------------ |
| Vector 1           | 261.59 / 283.34     | 191.39 / 287.65    | 16                 |
| Vector 10          | 255.68 / 280.79     | 186.41 / 260.97    | 17                 |
| Vector 50          | 284.15 / 368.38     | 207.43 / 308.02    | 16                 |
| Vector filtered 10 | 260.12 / 286.51     | 180.51 / 289.33    | 16                 |
| Hybrid 1           | 256.27 / 269.96     | 183.14 / 280.85    | 16                 |
| Hybrid 10          | 271.74 / 388.37     | 190.54 / 282.24    | 16                 |
| Hybrid 50          | 319.41 / 549.08     | 232.52 / 332.93    | 16                 |
| Hybrid filtered 10 | 266.97 / 291.71     | 191.78 / 285.02    | 16                 |

Median latency decreased across the repeated-query cases, while several p95 values rose slightly. Within the experimental samples, unfiltered vector-10 cache hits had median 185.80 ms and misses 260.97 ms; hybrid-10 hits had median 188.82 ms and misses 270.53 ms. Each miss subset has only three or four observations and is not an independent causal comparison. Cache hits avoid the provider call; expiry, unique inputs and canonical changes still pay that call and cache-adapter work. Vector visibility remains eventual, with up to one additional second of cached candidate visibility. These results do not establish general Turbopuffer parity or removal of the remote strong-read hop.

A separate owned native namespace confirmed actual cache reuse, then deleted the top candidate and reset the namespace. The sequence-2 query returned only the surviving revision-1 document; sequence 3 returned no rows after reset. The first bounded observation window did not satisfy its combined visibility/cache-hit assertion; persisted metadata showed two committed documents and an empty outbox. The probe resumed on that same namespace without repeating the seed and then completed. Its first resumed cold request recorded 1,120 ms in the ANN/cache interval and 1,644 ms at the gateway, reinforcing that this cache does not solve cold service latency.

## Million-document local workload

Runtime `34fa7de` batches Bloom probes and caches compact exact block-score projections under private `catalog-v3` / `raio-terms-v3` identities. Canonical R2 segment, root, log and receipt formats remain unchanged. The full local gate passes 106 Worker/tooling and 18 Rust tests. SciFact nDCG@10, recall@10 and MRR@10 remain exactly 0.6730619695232347, 0.7956666666666666 and 0.641808201058201.

The isolated WASM experiment probes 1,000 bitsets against 500 IDs, with five warmups and twenty measured iterations. Before p50/p95 was 62.70/86.29 ms; batches of at most 64 measured 16.69/18.22 ms, with identical candidate lists. This baseline pre-encodes the input IDs, so it excludes additional old caller serialization work. A separate old/new WASM comparison on one 500-document segment reduced the two-term dictionary from 1,239 to 140 bytes while retaining bit-identical score bounds for unfiltered, eligible and empty-filter cases. No claim attributes the full-engine improvement solely to either isolated experiment.

Both complete local runs ingested the same one million documents in 500-document batches. Background queue consumption is disabled in this benchmark, leaving 2,000 uncompacted segments. Each query/mode has five warmups and fifty measured requests. The new driver additionally checks the acknowledged sequence and identical rows/scores across every measured request and both consistency modes, outside the latency interval. The baseline driver checked nonempty results and requested consistency; it did not retain large-corpus row snapshots for a cross-version row comparison. Exact-ranking regressions, isolated old/new bounds and independent SciFact evaluation provide separate correctness evidence.

| Query     | Mode          | Before p50 / p95 ms | After p50 / p95 ms |
| --------- | ------------- | ------------------- | ------------------ |
| rare      | strong        | 15.62 / 24.95       | 5.98 / 8.94        |
| selective | strong        | 119.29 / 183.02     | 107.84 / 171.54    |
| common    | strong        | 2,108.04 / 2,355.76 | 126.86 / 240.24    |
| filtered  | strong        | 2,020.38 / 2,343.25 | 125.82 / 245.20    |
| rare      | edge eventual | 28.39 / 52.21       | 25.30 / 49.20      |
| selective | edge eventual | 148.45 / 234.28     | 205.51 / 436.75    |
| common    | edge eventual | 2,037.85 / 2,230.52 | 238.81 / 365.12    |
| filtered  | edge eventual | 2,005.69 / 2,211.08 | 146.65 / 219.10    |

Ingestion changed from 1,541.07 to 1,346.82 seconds, or 648.90 to 742.49 documents/s. Selective edge latency regressed; the fresh/snapshot acquisition and large manifest costs remain in that path. Separate runs, emulator scheduling, cache state and host load limit causal attribution. These are local workerd measurements, not native million-document latency or Turbopuffer parity. The emulator process contains R2, Cache API and queue emulation; its RSS is not the Worker isolate's memory usage.

The catalog L1 charge stayed within the same 4 MiB budget: 4,192,276 → 4,193,844 bytes. Projection acquisitions fell from 444,002 to 12,002 and acquired projection bytes from 426,308,418 to 1,476,148. These counters measure the private projection path, including Cache API hits, rather than raw R2 operations. Immutable range acquisitions and bytes stayed identical at 287,801 and 54,534,565,213; most were served from Cache API. Directory charge stayed at 41,873,899 bytes and WASM linear memory changed from 34,668,544 to 34,340,864 bytes. The unchanged range work still dominates large ingestion; this optimization does not remove that cost or establish a complete isolate memory bound.

Corpus SHA-256: `8bd38242bd5eaad8d4b69bc4e21d8d29000e59dd659018489d42758b88911bcd`. Before Worker/WASM hashes: `6557dc37438e011f9247391bc37b79a1df664a5f2f8620adfee6d1b321ae03d8` / `7a6fabfcd0a8473a920af63d5afe6121a94437845f851f7c6d2cf4a69d7d3556`. After: `eaeb9f38126bf59512759395918be9f0c0948b03d8852549b43de5d5a5888456` / `19ed91b57716a49c23938b6baccbdd061a29dd147bd6c4f43a21af924ec3c44b`. Reproduce with `RAIO_BENCH_DOCUMENTS=1000000 bun tooling/benchmark.ts` after the native build.

Native validation on the existing 100,000-document corpus completed 192 requests before deployment, 192 immediately after and 192 in a warm repeat, all matching their strong baselines. This smaller corpus did not demonstrate a native latency win.

| Concurrency | Before p50 / p95 ms | Post-deploy p50 / p95 ms | Warm repeat p50 / p95 ms |
| ----------- | ------------------- | ------------------------ | ------------------------ |
| 1           | 53.05 / 84.54       | 68.36 / 367.83           | 62.03 / 125.42           |
| 4           | 58.74 / 149.84      | 68.64 / 308.64           | 75.36 / 231.53           |
| 16          | 70.04 / 476.57      | 87.64 / 402.16           | 76.84 / 448.84           |

A separate native vector/hybrid run completed all 200 requests on the existing 96-vector corpus with exactly the same rows and scores as the preceding ANN-cache run. Vector-10 and hybrid-10 p50/p95 were 185.67/260.89 and 189.59/270.98 ms. Native large-corpus throughput, selective edge tails, ingestion range work and cold service latency remain open.

## Batched exact segment score bounds

Runtime `19d3e0f` evaluates at most 64 compact catalogs in one WASM call, decoding shared namespace statistics once per batch. Bound values and segment order remain unchanged; the caller checks finite values and returned cardinality before priority sorting. Canonical R2 formats and private catalog-v3 cache shape remain unchanged. The full local gate passed 107 Worker/tooling and 18 Rust tests, and SciFact's three aggregate metrics remained identical.

The isolated comparison uses 2,000 identical old/new catalog inputs with varied eligibility minima, including null. Every bound is bit-identical. With five warmups and thirty measured iterations, p50/p95 changed from 6.64/10.67 to 5.35/7.48 ms. The baseline pre-encodes each catalog, while the batched loop encodes its windows during measurement; this does not isolate all caller serialization work.

A full workerd comparison ingests 2,000 one-document segments in each version, then runs five warmups and thirty measured strong queries. Before p50/p95 was 135.76/203.50 ms; after was 95.25/206.46 ms. All rows and scores match across versions and every repeated request, with sequence 2,000 verified. The baseline Worker was compiled from preceding public commit `2561bc6` with its preserved WASM and the same resolved dependencies outside the tracked repository. This small-document workload stresses segment count; it is not a rerun of the million-document corpus. Separate processes and host variation limit causal attribution, and p95 rose slightly.

The native before/after loads reused the unchanged 100,000-document corpus. Each completed 192 requests and checked every result against its strong baseline. The measured loads use explicit edge eventual consistency with an acknowledged sequence barrier.

| Concurrency | Before p50 / p95 ms | After p50 / p95 ms | Before / after requests/s |
| ----------- | ------------------- | ------------------ | ------------------------- |
| 1           | 59.38 / 100.71      | 47.49 / 86.20      | 14.71 / 16.17             |
| 4           | 60.06 / 115.37      | 50.89 / 137.86     | 50.74 / 50.87             |
| 16          | 73.60 / 444.26      | 60.80 / 465.50     | 105.77 / 121.47           |

All measured medians decreased, but two p95 values increased and concurrency-4 throughput was effectively unchanged. Provider/network variation, deployment and cache state remain uncontrolled; these results support a bounded improvement, not general parity or attribution of the whole latency change to this batch operation. Native million-document proof, selective edge tails, cold service latency and ingestion range work remain open.

## Native million-document diagnostics

The deployed runtime at `19d3e0f` completed the deterministic million-document corpus. A subsequent persisted metadata audit confirmed 1,000,000 live documents, sequence 2,000 and zero vector outbox entries. This establishes native ingestion completion. The resumed ingestion included replaying acknowledged batch receipts, so its elapsed time is not a fresh million-document ingestion rate.

Three initial strong queries returned HTTP 200: rare took 1,345.93 ms, selective took 7,643.60 ms and common took 5,356.06 ms. Server timings attributed 6,574 ms of the selective request and 4,560 ms of the common request to term-directory acquisition. These are individual diagnostic observations after ingestion, not controlled cold-cache percentiles.

Six alternating repetitions per selective/common case returned identical rows and scores to their respective initial response. Selective median was 210.58 ms, with a range of 184.01–425.69 ms; common median was 225.58 ms, with a range of 207.48–238.51 ms. This small diagnostic sample isolates a substantial initial acquisition cost; it does not establish concurrent throughput, percentile tails or Turbopuffer parity. The Cloudflare clock's reported zero-duration warm stages do not isolate their CPU time.

The first full comparison aborted before collecting latency samples: Turbopuffer metadata reported `up-to-date`, while twelve query probes still reported 47,500 unindexed documents. The temporary comparator's deletion was confirmed. A fresh comparator was then evaluated against the existing Kannin corpus with 360 readiness probes spaced five seconds apart, without relaxing the zero-unindexed-document requirement. Every probe still reported 15,000 unindexed documents; that run also aborted before collecting strict comparison samples, and its comparator deletion was confirmed. The initial observations above warmed Kannin before this repeated comparison, so its first query must not be described as a cold-cache measurement. Full comparison results remain unverified.

### Operational comparison with unindexed comparator writes

A separate read-only diagnostic reused that fresh comparator while the strict readiness run continued waiting. Turbopuffer strong queries included all writes, and every measured response reported 15,000 unindexed documents. This is an operational observation of partially indexed search, not a fully indexed comparison. It used the same corpus SHA-256 as the local million-document workload, Cloudflare ingress `GRU`, Turbopuffer `aws-sa-east-1`, concurrency one, five warmups and fifty measured requests per case and mode. Background readiness probes also queried the comparator; that extra traffic and earlier cache warming limit attribution.

| Query     | Strong p50 / p95 ms | Edge p50 / p95 ms | Turbopuffer p50 / p95 ms |
| --------- | ------------------: | ----------------: | -----------------------: |
| rare      |     169.37 / 194.01 |    90.73 / 514.35 |            59.69 / 61.22 |
| selective |     174.22 / 194.85 |    98.10 / 509.17 |            58.91 / 60.53 |
| common    |     192.07 / 205.84 |   126.12 / 746.27 |            81.49 / 82.99 |
| filtered  |     187.02 / 201.40 |   109.44 / 464.95 |            77.37 / 78.34 |

All 224 strong/edge pairs, including initial requests and warmups, returned identical rows and scores with the acknowledged sequence barrier. Turbopuffer results were nonempty; this driver does not assert cross-engine score or tie-order equality. Final metadata still reported one million documents and sequence 2,000. These observations do not establish concurrent throughput or general parity.

The first operational attempt aborted on selective edge with HTTP 504 after its 30-second snapshot lease expired. Subsequent diagnostic edge requests succeeded in 2,416.88 ms for selective and 6,181.57 ms for common, matching strong rows and scores. The later successful run above also observed initial filtered strong/edge requests of 5,844.11/5,272.55 ms. Warming does not resolve the earlier timeout: initial acquisition cost and edge tails remain optimization requirements. The strict comparison owned the comparator lifecycle and confirmed its deletion after exhausting the readiness window.

## Large edge snapshot budget

The previous process snapshot cache admitted at most 4 MiB of conservative charge, calculated as four times the encoded snapshot size. A million live document IDs require at least 2 MB of Bloom bytes, or about 2.67 MB of base64 before other manifest fields. Those strings alone exceed the previous charged budget. Runtime `b8fcc92` raises this bounded budget to 24 MiB, retaining the original less-than-one-second observation age, namespace/bucket isolation and acknowledged sequence barrier. Larger snapshots still bypass this layer. This changes disposable process memory, not canonical storage or consistency.

A workerd regression first failed with HTTP 503 when a large snapshot was evicted from Cache API and the canonical root was made unavailable. It now serves the still-valid memory snapshot, then rejects it after the original age expires. The full gate passed with 108 Worker/tooling and 18 Rust tests. An initial full run counted 26 rather than 13 range acquisitions in the existing concurrent-cold test; the isolated test and subsequent complete gate passed without changing that assertion. Peak native isolate memory was not measured.

Three native load runs used the same million-document corpus, 32 requests per concurrency phase and exact strong baselines. All 288 edge responses across those runs matched their respective strong rows and scores. Rare, selective and common strong rows/scores also matched retained pre-deploy diagnostic responses exactly. The first post-deploy run and its warm repetition are both retained:

| Concurrency | Before p50 / p95 ms | First after p50 / p95 ms | Warm after p50 / p95 ms |
| ----------: | ------------------: | -----------------------: | ----------------------: |
|           1 |     130.49 / 754.60 |           82.04 / 761.90 |          88.53 / 614.95 |
|           4 |     148.62 / 867.01 |          94.81 / 1303.02 |          81.65 / 499.04 |
|          16 |    349.73 / 1341.91 |         445.59 / 1632.40 |        114.47 / 1145.73 |

Before throughput was 3.44/12.46/20.75 requests/s at concurrency 1/4/16; first after was 4.44/9.59/18.98, and warm after was 4.82/22.59/23.07. Initial post-deploy tails and high-concurrency throughput regressed; the warm repetition improved medians and p95 relative to the baseline. Deployment, cache state, network variation and the small sample prevent attributing the whole difference to the budget. Initial catalog acquisition, the earlier 30-second edge timeout and native concurrent tails remain unresolved.

## Batched native query projections

Runtime `e3e4e17` introduced native cached projections for groups of up to sixteen immutable directories. Runtime `13c257a` schedules four batches concurrently with sequential directory reads inside each request, preserving the previous four-read bound per query. Runtime `8059479` restores that same implementation after an unsuccessful full-header experiment. R2 root and index formats are unchanged; `catalog-v4` and its private cache namespace separate the array response from older projections. Per-segment query projections retain the four-MiB charged memory budget. `termReads` counts acquired catalogs and `termRequests` counts native requests.

A workerd regression with thirty-three segments verifies three native calls rather than thirty-three, including the final partial batch. A different eligibility predicate requires new projections and retains namespace-wide document frequencies and exact filtered scores. The complete retained implementation passes 109 Worker/tooling and 18 Rust tests, including the existing phrase, revision, tombstone, cache isolation and independent ranking regressions.

Native diagnostics append a unique absent token to each query, preserving its exact result while forcing a new projection selector. Each variant is checked against the corresponding strong base query. The million-document corpus, segment caches and prior requests remain in place; this isolates new projection selection, not a completely cold storage environment. Each cell is one observation, not a percentile:

| Query     | Individual projections ms | Serial batches ms | Four batch lanes ms | Full-header experiment ms |
| --------- | ------------------------: | ----------------: | ------------------: | ------------------------: |
| selective |                  5,110.80 |          6,385.32 |            4,462.44 |                  6,974.86 |
| common    |                  4,245.13 |          5,989.52 |            4,349.80 |                  4,618.98 |
| filtered  |                  4,361.26 |          6,605.73 |            4,611.44 |                  5,399.78 |

All twelve responses returned HTTP 200 and matched their respective base rows and scores exactly. Batching reduces native calls; only the selective lane observation improved over the individual-projection baseline. The full-header variant reused immutable bytes across selectors and passed 110 Worker/tooling plus 18 Rust tests, but increased total latency and moved full directory decoding to the caller. It was reverted, including its entrypoint, transport schemas and tests. A smaller directory interval in one case did not justify retaining higher total cost. Deployment, cache state and provider variation remain uncontrolled.

A final native mixed-query load against the restored implementation verified all ninety-six edge responses against strong baselines at sequence 2,000 and one million documents. Concurrency 1/4/16 p50 was 79.90/91.20/195.90 ms, p95 was 3,517.22/750.73/1,451.56 ms and throughput was 2.01/15.63/21.89 requests/s. The initial phase had substantial tails after redeployment. These results do not establish general latency improvement or Turbopuffer parity. First-use projection acquisition and concurrent tails remain open.

## Compressed segment overviews

Runtime `a8df7ed` adds a separate four-MiB compressed overview LRU and private Cache API fallback at the immutable directory boundary. Each overview contains all physical term frequencies and block bounds plus the exact minimum field lengths for its filter predicate. Bucket, immutable segment key, header length and encoded filter identify the source; changing query terms does not invalidate it. Rust bounds decoded size at sixteen MiB, verifies length and CRC, then returns only requested term metadata. Live frequencies, tombstones, phrase ordering and revision checks remain owned by the existing query path. Corrupted cache data is discarded and reconstructed from a verified directory. R2 formats and the native projection response format remain unchanged.

The complete gate passed with 112 Worker/tooling and 18 Rust tests. New native codec tests compare projected dictionaries and filter minima against the original directory for multiple selectors, including an empty eligible set, and reject corruption and excessive term counts. Workerd tests verify memory reuse for new selectors, Cache API recovery after process eviction and canonical fallback after cache corruption. Independent BEIR SciFact evaluation of 5,183 documents and 300 queries exactly retained nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201. Eight retained native vector/hybrid cases also returned identical rows and scores; these are controlled provider fixtures, not broad vector recall proof.

The same million-document diagnostic appends new absent tokens to selective, common and filtered queries. Every variant matched its corresponding strong base rows and scores. Segment caches and previous requests remain in place. These are individual observations of new projection selectors, not fully cold namespace percentiles:

| Query     | Four batch lanes before ms | First overview observation ms | Repeated new selector ms |
| --------- | -------------------------: | ----------------------------: | -----------------------: |
| selective |                   4,462.44 |                      4,315.76 |                 2,698.00 |
| common    |                   4,349.80 |                      3,415.73 |                 1,790.25 |
| filtered  |                   4,611.44 |                      3,895.77 |                 3,187.78 |

A process health sample reported 496,516 charged overview bytes and thirty-two builds, with zero overview hits in that sampled isolate. Isolate routing and shared counters make that sample insufficient to identify the cache tier serving a specific query. The repeated timings are consistent with warming, but do not independently prove which native cache tier caused the improvement. Native peak isolate memory was not measured.

A subsequent complete native mixed-query load checked all ninety-six edge responses against strong baselines, retaining one million documents and sequence 2,000. Concurrency 1/4/16 p50 was 80.83/83.75/142.43 ms, p95 was 682.73/772.23/860.56 ms and throughput was 6.40/13.55/24.17 requests/s. Concurrency-four throughput and p95 regressed relative to the preceding batch run; other tails improved. Small samples, prior requests, cache state, deployment and network variation limit causal attribution. New selectors still take seconds, concurrent tails remain substantial, and a fully indexed Turbopuffer comparison remains unavailable from the earlier readiness window. These limits keep general parity and first-use latency unresolved.

## Memory overview path without native cache acquisition

Runtime `8ee3b40` validates and projects a compressed memory overview before computing the filter SHA-256 or opening Cache API. A miss retains the existing native cache lookup and verified directory fallback; a malformed memory entry can still recover from a valid Cache API copy. Budgets, keys, CRC validation, filters and response formats are unchanged. The complete gate and CI passed with 112 Worker/tooling and 18 Rust tests.

A controlled workerd workload creates sixty-four one-document segments, then issues sixty new selectors: ten warmups and fifty measured requests. Each selector appends an absent token, and every response matches the original rows and scores. Before/after both built sixty-four overviews, recorded 3,840 memory hits and retained 45,532 charged bytes. Before p50/p95 was 28.68/79.42 ms; after was 21.89/27.03 ms. Separate process runs and host variation limit attribution, but the source path now demonstrably skips the two native operations on a memory hit.

Native million-document diagnostics reused the same corpus and filter predicates, with newly generated absent tokens in each run. Each cell is an individual observation; the first after-deploy run and its repetition are both retained:

| Query     | Before ms | First after ms | Repeated new selector ms |
| --------- | --------: | -------------: | -----------------------: |
| selective |  2,575.24 |       2,894.75 |                 1,723.43 |
| common    |  2,295.11 |       1,226.92 |                 1,608.26 |
| filtered  |  2,318.06 |       1,189.87 |                 2,656.96 |

All nine responses matched their strong base rows and scores. The first selective observation and the repeated filtered observation regressed relative to the baseline. These variations prevent a universal latency claim or attributing every change to the memory branch; cache locality and first-use acquisition still require work.

The subsequent native mixed-query load verified all ninety-six edge responses against strong baselines at one million documents and sequence 2,000. Concurrency 1/4/16 p50 was 70.95/109.58/146.22 ms, p95 was 696.96/929.67/578.04 ms and throughput was 5.35/10.87/36.48 requests/s. Concurrency-sixteen p95 and throughput improved relative to the previous overview load, while concurrency-four p50, p95 and throughput regressed. The thirty-two samples per phase, prior cache warming and provider variation keep general throughput and parity claims unproven. New selectors remain above one second, and the earlier thirty-second first-use edge failure remains unproven resolved.

## Selective overview deserialization

Runtime `12d5aa0` uses a native Serde map visitor to project a compressed overview without retaining its entire dictionary. Each term summary is still deserialized and validated; only requested entries are inserted into the returned map. The root reader preserves duplicate/unknown-field rejection, nullable minima and trailing-data validation. CRC and decoded-size checks are unchanged. The projection retains at most sixty-four requested terms instead of the complete dictionary. This reduces retained entries, not a measured peak-isolate memory guarantee.

The complete gate and CI passed with 113 Worker/tooling and 18 Rust tests. A new independent fixture uses standard zlib compression and CRC to generate valid frames with malformed unrequested values, duplicate/unknown root fields or trailing data; every invalid projection is rejected. Existing filter, phrase, revision, live-frequency and cache-recovery regressions passed. SciFact's 300-query quality metrics remained exactly unchanged, as did all eight retained native vector/hybrid cases.

A WASM microbenchmark builds a 5,000-document segment and projects three requested names from its 12,908-byte overview. Each run has ten warmups and fifty measured projections, with every result checked against the original directory. An initial isolated baseline measured 8.16/8.63 ms p50/p95; that observation was not stable. Three subsequent alternating before/after process pairs produced:

| Pair | Before p50 / p95 ms | After p50 / p95 ms |
| ---: | ------------------: | -----------------: |
|    1 |         4.35 / 4.48 |        2.77 / 2.87 |
|    2 |         4.65 / 5.91 |        2.75 / 3.20 |
|    3 |         4.45 / 4.63 |        2.86 / 3.30 |

All projected dictionaries and minima matched. This isolates the WASM projection on a controlled segment; it is not native network latency. Separate processes and host variation limit causal attribution.

Native new-selector observations against the same million-document corpus measured selective/common/filtered before at 1,267.88/2,699.87/2,560.87 ms and after at 1,840.68/1,070.71/2,029.95 ms. Every result matched its strong base rows and scores. Selective total latency regressed while the directory interval decreased slightly, and its snapshot interval increased from 345 to 554 ms. These individual observations do not establish a universal improvement.

The subsequent complete native mixed-query load retained one million documents and sequence 2,000; all ninety-six edge responses matched strong baselines. Concurrency 1/4/16 p50 was 66.92/78.14/139.78 ms, p95 was 369.75/655.99/1,118.67 ms and throughput was 7.24/20.23/25.76 requests/s. Relative to the preceding memory-path load, concurrency-one and concurrency-four improved while concurrency-sixteen p95 and throughput regressed. The sample size, deployment, prior warming and network variation keep causal and parity claims bounded. Initial acquisition remains above one second, high-concurrency tails remain open, and the earlier edge lease failure is not proven resolved.

## Cache API overview batches

Runtime `6b60343` recovers compressed overviews with one Cache API lookup per ordered batch, rather than one per segment. The private `raio-overview-batches-v1` namespace uses bucket identity, immutable keys/header lengths and filter digest; changing query terms does not change the source key. Its Schema-owned base64 array contains at most sixteen CRC-framed overviews and three MiB of compressed source bytes. Oversized groups bypass Cache API admission. The existing four-MiB per-segment memory LRU remains; complete memory hits perform no native cache acquisition. Partial memory hits survive a batch miss. Corrupt or mismatched batches are discarded, and missing data is rebuilt from verified directories. Root/index formats and the compact projection response remain unchanged.

The full gate and CI passed with 113 Worker/tooling and 18 Rust tests. A workerd regression recovers seventeen segments after process eviction through two Cache API lookups, with seventeen source hits, zero rebuilds and identical rows/scores. The corruption test targets the new batch format and verifies source recovery. Existing global frequencies, filtered minima, phrase, revision, tombstone, namespace isolation and integrity regressions passed. The per-segment Cache API owner was removed in the same change; there are no compatibility reads of its previous namespace.

Native new-selector observations against the million-document corpus were:

| Query     | Before ms | First batch observation ms | Repeated new selector ms |
| --------- | --------: | -------------------------: | -----------------------: |
| selective |  2,953.15 |                   4,228.23 |                 4,161.52 |
| common    |  2,326.83 |                   2,630.43 |                 1,771.87 |
| filtered  |    863.06 |                   3,902.85 |                 2,625.32 |

Every response matched its strong base rows and scores. Initial batch observations all regressed; the repetition improved common latency relative to the baseline, while selective and filtered remained slower. A new Cache API namespace begins empty, but that alone does not establish the cause of these variations. Reducing lookups does not prove lower native latency. New-selector acquisition remains unresolved.

A subsequent native mixed-query load verified all ninety-six edge responses against strong baselines, retaining one million documents and sequence 2,000. Concurrency 1/4/16 p50 was 66.96/64.75/112.32 ms, p95 was 572.18/657.42/1,040.79 ms and throughput was 6.41/23.70/24.78 requests/s. Relative to the preceding parsing run, concurrency-four median and throughput improved, concurrency-sixteen median and p95 improved, and concurrency-one p95/throughput regressed. The small sample, prior requests, deployment and provider variation limit attribution. General parity, first-use edge deadline reliability and native peak isolate memory remain unverified.

## Allocation-free validation of discarded term bounds

Runtime `07368b6` validates every unrequested term summary but does not allocate its bounds vector. Requested summaries retain the same owned representation. Missing fields, duplicate bounds fields, tuple lengths, negative values and integers above u32 remain rejected. The rejected borrowed-key experiment produced inconsistent timings and was removed before publication.

Three paired WASM runs used the same 5,000-document segment, 12,908-byte compressed overview and three requested terms. Each run warmed up 50 times and measured 500 projections; every projection matched the original directory summary and minimum. Before/after p50 was 2.683/2.560, 2.773/2.590 and 2.678/2.520 ms, a 4.6–6.6% reduction. p95 was 4.812/2.884, 4.040/4.990 and 5.362/2.634 ms; one pair regressed. These process-local measurements do not prove a native latency gain.

The complete local gate passed 113 Worker/tooling tests and 18 Rust tests. Deployment completed. Native new-selector observations on the unchanged million-document corpus returned exact strong rows and scores: selective 2,450 ms, common 1,285 ms and filtered 2,740 ms. Compared with the preceding batch-cache repeat, two improved and the filtered case regressed. Existing segment caches remained eligible; this was not a fully cold namespace test.

All 96 mixed-load responses matched strong baselines and the acknowledged sequence barrier. Concurrency 1/4/16 measured p50 84.18/105.94/143.22 ms, p95 1,023.91/868.16/1,391.12 ms and throughput 3.58/13.76/19.15 requests/s. All phases regressed relative to the preceding run. Server timings include snapshot reads and ranking work as well as overview processing; cache, isolate and network state were not controlled. No causal overall speedup or Turbopuffer parity is claimed. First-use lease reliability and native peak memory remain open.

## Memory snapshot acquisition

Runtime `1572b02` skips `caches.open` when a bucket-scoped in-memory snapshot satisfies the original less-than-one-second selection bound and minimumSequence. Cache API acquisition for a background refresh occurs inside the detached request-owned task. Cold and insufficient memory reads still use the existing Cache API/R2 path. No snapshot age or consistency contract changed.

A local workerd run used 1,000 documents, 20 warmups and 80 measured edge queries, checking every sequence and row count. Before/after total p50 was 4.495/4.433 ms and p95 6.515/7.023 ms; snapshot phase p95, rounded by the existing Server-Timing instrumentation, changed from 1 ms to 0 ms. This demonstrates removal of an awaited native cache acquisition, but does not establish a total-latency improvement. The full gate passed 113 Worker/tooling and 18 Rust tests, including snapshot expiry, cache eviction, large manifests and sequence barriers. Deployment completed.

Two native loads immediately before deployment and two after used the same million-document corpus. Each run measured 32 mixed queries at concurrency 1/4/16 with exact strong-baseline rows/scores and sequence checks. All 384 edge responses passed.

| Run      | Concurrency | p50 ms |  p95 ms | Requests/s |
| -------- | ----------: | -----: | ------: | ---------: |
| Before 1 |           1 |  64.16 |  372.69 |       8.75 |
| Before 1 |           4 |  78.02 |  754.57 |      18.24 |
| Before 1 |          16 | 140.90 |  701.60 |      23.21 |
| Before 2 |           1 |  82.41 |  820.04 |       5.38 |
| Before 2 |           4 |  78.37 |  533.84 |      17.35 |
| Before 2 |          16 | 123.86 |  861.37 |      29.45 |
| After 1  |           1 |  80.69 |  603.34 |       6.08 |
| After 1  |           4 |  83.73 |  783.66 |      19.32 |
| After 1  |          16 | 146.77 | 1077.28 |      28.90 |
| After 2  |           1 |  60.09 |  526.21 |       7.93 |
| After 2  |           4 |  63.13 |  432.11 |      25.82 |
| After 2  |          16 | 110.42 |  806.83 |      26.62 |

The second post-deploy run improved all medians relative to both preceding baseline runs, while the first post-deploy run regressed several phases. Concurrency-sixteen p95 remained above the first baseline. Isolate, cache and network state were uncontrolled; these measurements do not establish a causal overall speedup. The README reports the latest run, with both runs retained here. New-selector latency, first-use lease reliability, native peak memory and fully indexed Turbopuffer parity remain open.

## Direct projection on overview misses

Runtime `7f4bc5b` obtains selected summaries and filter minima directly from the verified Rust directory when a compressed overview is missing. It still builds that overview for future selectors, but avoids immediately decompressing and scanning the full dictionary again. Partial memory hits reuse the catalog already decoded during the memory probe. Persisted formats, cache identities, admission budgets and global live ranking statistics are unchanged.

An alternating local WASM microbenchmark used the same 5,000-document segment and three terms, 50 warmup pairs and 100 measured pairs. Each path built an overview; the baseline then projected it, while the new path used directory summary/minimum APIs. Every result matched the expected catalog. p50 fell from 5.718 to 3.037 ms and p95 from 5.956 to 3.190 ms. This measures that operation, not complete-query latency. The full local gate passed 113 Worker/tooling tests and 18 Rust tests; deployment completed.

Native diagnostics used the unchanged million-document corpus. Each query appended an absent random token and an independently generated negative year lower bound, which all benchmark documents satisfy. The fresh filter identity forced a compressed-overview miss while preserving the original strong result. Existing immutable range/directory caches remained eligible; this was not a wholly cold namespace. Before/after row scores were also compared directly across report files.

| Query     | Before ms | After ms | Second fresh-filter run ms |
| --------- | --------: | -------: | -------------------------: |
| Selective |   4496.76 |  4357.80 |                    4304.40 |
| Common    |   3959.79 |  3131.45 |                    2997.55 |
| Filtered  |   3480.38 |  2971.81 |                    3114.29 |

All six post-deploy diagnostics returned exact baseline rows and scores. All three observations improved in both runs, but single observations with uncontrolled cache/isolate/network state cannot establish a causal general latency percentage.

A separate 96-request mixed load retained exact strong rows/scores and acknowledged sequence. Concurrency 1/4/16 measured p50 62.63/65.99/176.19 ms, p95 527.87/960.33/912.96 ms and throughput 8.24/14.43/25.07 requests/s. Relative to the preceding latest snapshot run, concurrency-four p95 and concurrency-sixteen medians regressed. The README reports this latest load; previous measurements remain above. New-selector/filter misses still take seconds, and first-use lease reliability, native peak memory and fully indexed Turbopuffer parity remain open.

## Borrowed overview serialization

Runtime `e74f8ba` serializes overview dictionaries and block tuples directly from borrowed directory entries. Native Serde `collect_map` and `collect_seq` retain ordered JSON while removing copied term strings, a second BTreeMap and allocated per-term bounds vectors. The cache format, CRC framing, decoded-size limit, filter minima and exact scoring contract are unchanged.

An alternating old/new WASM comparison used the same 5,000-document segment, 50 warmup pairs and 100 measured pairs. Every compressed output was byte-identical to the old implementation. Building an overview measured before/after p50 2.947/2.403 ms and p95 3.098/2.563 ms. This is an operation-level measurement, not a whole-query claim. A codec regression independently compares framed overviews with the concrete Schema-encoded directory summaries/minima for empty, matching and empty-result predicates. The full gate passed 113 Worker/tooling tests and 18 Rust tests; deployment completed.

Native diagnostics reused the million-document corpus and the preceding section's absent-token/always-true fresh-year-filter method. Every query forced a new overview filter identity; immutable range and directory caches remained eligible. Exact row scores matched both the strong baseline and the saved preceding-version responses.

| Query     | Before ms | First after ms | Second fresh-filter run ms |
| --------- | --------: | -------------: | -------------------------: |
| Selective |   4250.74 |        4312.38 |                    3843.30 |
| Common    |   3459.93 |        4096.91 |                    3324.12 |
| Filtered  |   3563.92 |        3591.01 |                    3094.19 |

All first-run observations regressed; all second-run observations improved. The cache/isolate/network state was uncontrolled, so the local serialization gain does not establish a causal native latency improvement.

All 96 mixed-load responses retained exact strong rows/scores and the acknowledged sequence. Concurrency 1/4/16 measured p50 62.58/61.89/255.18 ms, p95 387.82/250.70/1,189.85 ms and throughput 8.30/28.21/21.20 requests/s. Relative to the preceding direct-projection load, concurrency-four tails improved substantially, while concurrency-sixteen median, tail and throughput regressed. The README reports this latest load. New-selector/filter misses still take seconds; first-use lease reliability, native peak memory and fully indexed Turbopuffer parity remain open.

## Shared native snapshot acquisition

Runtime `90632d8` shares only pending native snapshot acquisitions per physical bucket/namespace. The owning request consumes and decodes the R2 body and publishes the snapshot once. Other readers await the decoded result, then check their own sequence barrier and the observation age recorded before the original R2 read. The entry is removed after success, absence or failure. Completed acquisitions are not another persistent cache. Existing memory/Cache API age bounds remain unchanged.

The first attempted implementation used `Effect.cached` across request fibers. Workerd canceled joined requests as hung; that implementation was removed before publication. Sharing a native acquisition Promise preserved request-owned I/O. A twelve-request local regression with mixed committed/future sequence barriers observed seven R2 acquisitions before and two after. Late requests may legitimately start another acquisition, so the regression asserts actual sharing and fewer acquisitions than requests rather than requiring one acquisition for the entire HTTP burst. Every request retained its individual 200/409 result. A second regression corrupts canonical data during overlapping reads, verifies 503 responses, repairs it and verifies immediate recovery. The complete gate passed 115 Worker/tooling tests and 18 Rust tests; deployment completed.

`GET /health` now exposes isolate-local snapshot acquisition/join counters. Native requests can land in different isolates, so these counters are not global I/O counts. The native driver below measures latency and result equality, not aggregate R2 call reduction.

Two native loads before deployment and two after used the same million-document corpus, 32 mixed queries per concurrency phase, and exact strong rows/scores plus acknowledged sequence checks. All 384 edge responses passed.

| Run      | Concurrency | p50 ms |  p95 ms | Requests/s |
| -------- | ----------: | -----: | ------: | ---------: |
| Before 1 |           1 |  76.72 |  389.05 |       8.25 |
| Before 1 |           4 |  76.30 |  381.26 |      32.50 |
| Before 1 |          16 | 121.69 | 1006.07 |      25.67 |
| Before 2 |           1 |  59.55 |  356.02 |       8.51 |
| Before 2 |           4 |  83.15 |  362.35 |      26.52 |
| Before 2 |          16 | 118.55 |  865.78 |      21.99 |
| After 1  |           1 |  77.52 |  275.50 |       6.95 |
| After 1  |           4 | 106.16 |  981.11 |      12.07 |
| After 1  |          16 | 210.26 | 1162.10 |      23.73 |
| After 2  |           1 |  81.81 |  499.24 |       7.09 |
| After 2  |           4 |  78.94 |  271.84 |      28.20 |
| After 2  |          16 | 111.19 |  951.71 |      22.02 |

The local overlapping-read reduction is demonstrated. Native results remain mixed: the second concurrency-sixteen median improved against both baselines, but its tail exceeded the second baseline; concurrency-one median and throughput regressed. Uncontrolled cache/isolate/network state prevents a causal overall latency claim. The README reports the latest run and retains the preceding fresh-filter diagnostic separately. New-selector/filter misses, first-use lease reliability, native peak memory and fully indexed Turbopuffer parity remain open.
