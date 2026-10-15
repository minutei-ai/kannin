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

## Reusable exact eligibility groups

Runtime `ae75f45` replaced filter-specific compressed overviews with one immutable source per physical bucket/segment/header length. Documents with identical serialized attributes share component-wise title/body minima. Evaluating the real filter over groups gives the same physical minimum as scanning documents, including null for no matches and the original zero floor for an empty predicate. Physical frequencies and bounds remain unchanged; fresh live statistics/tombstones remain query-local. The private source format is now `raio-overview-batches-v2` / `batch-v2`, with no old-format reads. Canonical R2 files and projected catalog responses did not change.

Group tuples serialize borrowed attribute JSON objects directly. A rejected prototype serialized attribute objects inside JSON string keys, adding another parse/escape layer and regressing high-cardinality CPU. The tuple representation removed that regression. Failure to build a disposable overview skips its admission and returns the directly validated catalog; existing four-MiB LRU, three-MiB batch admission and sixteen-MiB decoded-page limits remain enforced.

Alternating old/new WASM comparisons used 5,000 documents and ten changing filters, checking every catalog/minimum against the original directory. Repeated attributes used 10 warmup pairs and 30 measured pairs; unique attributes used 5 warmup pairs and 15 measured pairs.

| Attribute shape     | Old/new compressed bytes | Before/after p50 ms | Before/after p95 ms |
| ------------------- | -----------------------: | ------------------: | ------------------: |
| Repeated groups     |            19081 / 21392 |       81.25 / 36.65 |       86.70 / 38.45 |
| Unique per document |            19081 / 46548 |       92.09 / 77.50 |      102.86 / 84.36 |

These timings cover ten projections, including per-filter source construction in the old path and one reusable source construction in the new path. They do not imply the same percentage for complete queries. High cardinality grows payload size and can reduce LRU admission. The full gate passed 116 Worker/tooling tests and 18 Rust tests. Regression coverage includes conjunctions, every filter operator, missing/null/boolean attributes, groups with different document lengths, malformed groups/root fields, empty eligibility, corruption and cross-filter recovery after process eviction. The seventeen-segment cache regression recovered all sources through two Cache API lookups without rebuilding when the predicate changed.

Native fresh-filter diagnostics used the unchanged million-document corpus and the preceding absent-token/always-true negative-year-predicate method. The first post-deploy source-cache round had a selective regression; following rounds reused the new source format. Every row/score matched strong baselines and the saved preceding-version responses.

| Query     | Before ms | First v2 run ms | Second v2 run ms | After snapshot publication fix ms |
| --------- | --------: | --------------: | ---------------: | --------------------------------: |
| Selective |   3907.67 |         5432.69 |          2177.71 |                           2487.41 |
| Common    |   3699.68 |         3605.19 |          1000.43 |                           1566.20 |
| Filtered  |   3750.69 |         2579.26 |          1386.67 |                           1750.99 |

All final observations improved relative to the preceding implementation, but immutable range, process and regional caches remained eligible. These are not fully cold namespace measurements or a causal global latency guarantee.

The first v2 mixed load aborted on a native 503 `Snapshot freshness budget exceeded`, with gateway duration 1,629 ms. That failed run produced no complete percentile report and is not counted as a passing load. Runtime `f1d5c6f` then moved the derived Cache API snapshot write to the owning request's native waitUntil. Snapshot selection still enforces the observation time recorded before R2 acquisition and each caller's minimumSequence; no freshness bound was relaxed. The complete local gate passed again and deployment completed.

Two subsequent native loads completed, each checking 96 edge responses against exact strong rows/scores and the acknowledged sequence.

| Run         | Concurrency | p50 ms |  p95 ms | Requests/s |
| ----------- | ----------: | -----: | ------: | ---------: |
| After fix 1 |           1 |  65.23 |  411.25 |       8.03 |
| After fix 1 |           4 |  79.33 |  833.56 |      19.16 |
| After fix 1 |          16 |  98.89 | 1392.46 |      22.89 |
| After fix 2 |           1 |  58.13 |  273.65 |       8.30 |
| After fix 2 |           4 |  67.71 |  506.18 |      20.80 |
| After fix 2 |          16 | 147.75 |  825.32 |      28.04 |

The README reports the latest complete run. Native tails remain variable; two passing loads do not establish that every first-use/freshness failure is resolved. Native peak memory, cold reliability and fully indexed Turbopuffer parity remain open.

Independent SciFact evaluation after the cutover retained nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201 across 300 queries. Eight read-only native vector/hybrid cases retained the exact previously recorded rows and scores; this is fixture evidence, not a general provider recall claim. Both runtime CI jobs completed successfully.

## Selective attribute projection

Runtime `7f6d00c` retains only attribute fields referenced by up to eight distinct filter fields during group decoding. It still parses every value through native serde_json Value validation, including discarded values, preserving rejection of malformed JSON and invalid numeric/string values. Repeated conditions on a field remain in the original predicate array. Larger field sets delegate to native full-map/tuple decoding after the selective prototype regressed sixteen-field CPU. Cached source bytes, identities, budgets and exact minima are unchanged.

Alternating WASM comparisons used 1,000 documents, the same compressed source, 10 warmup pairs and 30 measured pairs per filter shape. Every projected catalog/minimum matched the old implementation. The wide records had group/year plus 32 numeric attributes; the small records had group/year only.

| Distinct filter fields | Wide before/after p50 ms | Two-attribute before/after p50 ms |
| ---------------------: | -----------------------: | --------------------------------: |
|                      0 |           11.735 / 7.000 |                     1.304 / 1.300 |
|                      1 |           11.696 / 7.361 |                     1.020 / 1.021 |
|                      4 |           11.931 / 9.294 |                     1.008 / 0.947 |
|                      8 |          12.192 / 10.315 |                     1.027 / 0.980 |
|                     16 |          13.065 / 13.150 |                     0.997 / 1.045 |

This operation-level result demonstrates a benefit for wide attributes with narrow predicates. It does not demonstrate a benefit for every attribute/filter shape; the small sixteen-field case regressed slightly. The full gate passed 116 Worker/tooling tests and 18 Rust tests, including repeated-field conjunctions and invalid overflowing numbers/unpaired Unicode in discarded fields. Deployment completed.

Native fresh-selector/filter diagnostics reused the unchanged million-document, two-attribute corpus and the previous absent-token/always-true-year method. Every row/score matched strong baselines and the saved prior-version responses. Existing immutable/process/regional caches remained eligible.

| Query     | Before ms | First after ms | Second after ms |
| --------- | --------: | -------------: | --------------: |
| Selective |   1981.04 |        1274.08 |         1831.98 |
| Common    |   1444.73 |         989.01 |          837.85 |
| Filtered  |   1222.32 |        1025.87 |         1681.67 |

All first-run observations improved; the second filtered observation regressed. Uncontrolled cache/isolate/network state prevents causal general latency attribution.

All 96 native mixed-load edge responses retained exact strong rows/scores and the acknowledged sequence. Concurrency 1/4/16 measured p50 68.94/66.61/152.74 ms, p95 510.22/348.31/1,036.17 ms and throughput 7.25/34.20/28.28 requests/s. Relative to the preceding latest group/snapshot-publication run, concurrency-four tails and throughput improved, while concurrency-one tails and concurrency-sixteen tails regressed. The README reports this latest complete load. Native cold reliability, peak memory and fully indexed Turbopuffer parity remain open.

## Rejected Terms tier bypass

The `7f6d00c` runtime was tested with the Alchemy per-entrypoint `Terms.cache.enabled` override temporarily set false. `Segments` retained native Workers Cache, and Terms retained its local LRU and Cache API projections/overviews. The full local gate passed 116 Worker/tooling and 18 Rust tests, but the resolved Alchemy provider explicitly does not emulate Workers Cache in local dev, so the decision relied on native measurements. The experimental setting was not committed and was restored to true; the final source and deployment retain the original configuration.

Cloudflare documents that disabling an entrypoint skips its native cache lookup and preserves previously cached responses for reuse if it is enabled again. This made the setting reversible without purging immutable data. The tier-latency hypothesis was an inference to test, not proof that this workload would benefit. See [Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/).

The same million-document corpus and fresh-selector/always-true-year diagnostic were used before, twice while disabled, and after restoration. Each response matched strong rows/scores and saved prior responses. Cache and isolate state were uncontrolled across deployments.

| Query     | Enabled before ms | Disabled first ms | Disabled second ms | Enabled restored ms |
| --------- | ----------------: | ----------------: | -----------------: | ------------------: |
| Selective |            687.36 |           2671.73 |            2498.86 |             2222.02 |
| Common    |           1052.28 |           1883.89 |            1783.82 |             1046.00 |
| Filtered  |           1042.67 |           1328.61 |            1666.78 |              770.64 |

All disabled observations regressed versus the initial enabled run. All restored observations improved versus both disabled runs, although the restored selective case remained much slower than the initial baseline. These observations do not isolate a universal causal gain, but provide no reason to retain the bypass.

Three mixed loads completed, each with 32 requests per concurrency phase and exact strong-baseline rows/scores plus acknowledged sequence checks. All 288 edge responses passed.

| Configuration    | Concurrency | p50 ms |  p95 ms | Requests/s |
| ---------------- | ----------: | -----: | ------: | ---------: |
| Enabled before   |           1 |  85.15 |  139.00 |       9.62 |
| Enabled before   |           4 |  93.58 |  752.43 |      19.38 |
| Enabled before   |          16 | 176.23 |  847.98 |      24.09 |
| Disabled         |           1 |  64.15 |  584.62 |       6.29 |
| Disabled         |           4 |  72.92 |  628.28 |      17.40 |
| Disabled         |          16 | 166.64 | 1065.86 |      22.67 |
| Enabled restored |           1 | 101.04 | 1183.56 |       3.67 |
| Enabled restored |           4 |  95.41 |  764.86 |      16.61 |
| Enabled restored |          16 | 149.87 |  877.11 |      25.76 |

The restored concurrency-sixteen median and throughput improved, but concurrency-one and four throughput regressed. The README reports the latest restored run. The experiment did not produce a consistent whole-workload benefit, so no application change was retained. Native first-use reliability, peak memory and fully indexed Turbopuffer parity remain open.

## Rejected binary overview dictionary

Experimental runtime `476a2e1` encoded cached dictionaries as ordered UTF-8 keys and little-endian frequency/bound integers, retaining group JSON. It removed term-key allocations during unrequested entry traversal and validated magic, counts, lengths, ordering, UTF-8, summary ranges and CRC. Its private namespace was v3; canonical R2 formats and projected catalog JSON did not change. The full gate passed 116 Worker/tooling and 18 Rust tests, including malformed payloads with recomputed CRC. Runtime `5291fda` reverted the experiment after native regressions; final deployment uses the previous v2 JSON sources, with no v3 compatibility reads.

Alternating local old/new WASM comparisons used 5,000 documents, 50 warmup pairs and 100 measured pairs. Every projected catalog/minimum matched the prior implementation. On the initial fixture, no/one/two-filter projection p50 changed from 2.977/3.078/3.109 ms to 1.366/1.475/1.493 ms; compressed source size changed from 19,615 to 19,660 bytes. On the actual benchmark text/attributes, p50 changed from 5.574/5.772/5.778 ms to 2.432/2.607/2.680 ms; bytes changed from 17,647 to 18,000. These demonstrate an operation-level CPU gain, not native-query acceleration or a payload-size gain.

Native fresh-selector/always-true-year diagnostics used the unchanged million-document corpus. Every response matched strong rows/scores and saved prior-version results. The experimental v3 source namespace began without the existing v2 entries; process, regional and immutable caches were otherwise uncontrolled.

| Query     | JSON before ms | Binary first ms | Binary repeat ms | JSON restored ms |
| --------- | -------------: | --------------: | ---------------: | ---------------: |
| Selective |         925.85 |         4818.99 |          2902.12 |          1535.61 |
| Common    |         875.66 |         4239.73 |          1779.59 |          1538.34 |
| Filtered  |         712.94 |         2532.65 |          2008.63 |           848.01 |

Both binary rounds regressed all cases against the preceding JSON run. All restored observations improved against both binary rounds, although they remained slower than the initial baseline. Cache reset and network/isolate variation prevent a clean causal attribution. The measurements provided no sufficient native benefit to retain the new format.

A 96-response load completed for each experimental and restored runtime, preserving exact strong rows/scores and sequence barriers.

| Configuration | Concurrency | p50 ms |  p95 ms | Requests/s |
| ------------- | ----------: | -----: | ------: | ---------: |
| Binary        |           1 |  65.84 |  424.26 |       7.83 |
| Binary        |           4 | 110.36 |  893.60 |      12.63 |
| Binary        |          16 | 132.00 | 1742.91 |      18.28 |
| JSON restored |           1 | 113.07 |  659.43 |       5.01 |
| JSON restored |           4 | 122.76 |  981.85 |      11.39 |
| JSON restored |          16 | 272.29 | 1518.85 |      17.40 |

The restored mixed load still regressed medians/throughput; reverting the experiment does not prove resolution of the wider workload variability. The README reports the latest restored run. The restoration passed the full 134-test gate and deployment completed. Native cold reliability, peak memory and fully indexed Turbopuffer parity remain open.

## Prepared Rust BM25 scoring

The ranker computes each term's live IDF and field-length averages once per `finish`, reusing them for posting scores and block bounds. It retains the original floating-point operation order, term ordering, cutoff guard, phrase matching, filters and tombstones. No persisted format or cache identity changes. A regression compares prepared scores bit for bit with the prior formula, including empty/invalid frequencies and counts beyond JavaScript integer precision.

A local alternating old/new WASM microbenchmark ranks the same 10,000-document segment with ten warmup pairs and 100 measured pairs. Posting decompression, directory acquisition and ranker construction are outside the timed `finish` operation. Every result, ID and score matches exactly, including a repeated-term phrase, four tombstones and an equality filter.

| Match  | Filter | Before p50 ms | After p50 ms |
| ------ | ------ | ------------: | -----------: |
| any    | False  |         7.871 |        4.607 |
| any    | True   |         7.521 |        4.199 |
| all    | False  |         7.753 |        4.541 |
| all    | True   |         7.519 |        4.169 |
| phrase | False  |         3.437 |        2.593 |
| phrase | True   |         2.148 |        1.358 |

These operation-level measurements do not establish an equivalent whole-query gain or Turbopuffer parity.

Native runtime `8604bfe` completed the same read-only million-document load before/after deployment: 32 responses per concurrency phase, 192 exact edge/strong checks in total. Process, regional caches and network conditions were uncontrolled.

| Runtime | Concurrency | p50 ms |  p95 ms | Requests/s |
| ------- | ----------: | -----: | ------: | ---------: |
| before  |           1 |  65.19 |  760.67 |       6.21 |
| before  |           4 |  78.87 |  819.81 |      16.62 |
| before  |          16 | 199.34 | 1272.02 |      19.96 |
| after   |           1 |  68.83 |  545.02 |       7.90 |
| after   |           4 |  73.78 | 1249.02 |      15.98 |
| after   |          16 | 170.47 | 1151.99 |      19.70 |

The lower local kernel cost is supported by alternating binary measurements. Native latency and throughput remain mixed; this is not a general whole-query acceleration claim. The full gate passed 116 Worker/tooling and 19 Rust tests. Deployment completed.

Fresh native selector/filter diagnostics returned exact strong rows/scores in 1,056/949/1,247 ms for selective/common/filtered queries. Server timings attribute 567–914 ms to directory work, 207–224 ms to snapshots, and 0–11 ms to ranking; these observations leave directory/snapshot acquisition as the dominant measured next targets.

The post-change local SciFact evaluation completed 5,183 documents and 300 queries: nDCG@10 0.673061970, Recall@10 0.795666667, MRR@10 0.641808201. Every evaluated query result matched the previous report. Source CI passed.

## Rejected 64-segment projection batches

An uncommitted native experiment expanded only the term/overview batch budget from 16 to 64, retaining four concurrent requests, exact global frequencies, immutable identities and the three-MiB overview admission limit. Its full local gate passed 116 Worker/tooling and 19 Rust tests. Boundary regressions used 65 segments and verified a full batch, partial tail, filters, scores and cache restoration after memory eviction. Canonical R2 formats did not change.

Fresh-selector diagnostics on the unchanged million-document corpus preserved exact strong results in every case. Ordered batch cache keys changed with batching, so the first experimental run began without the old batch entries; isolate and regional cache placement remained uncontrolled.

| Query     | 16 before ms | 64 first ms | 64 repeat ms |
| --------- | -----------: | ----------: | -----------: |
| Selective |      1796.38 |     5950.22 |       813.58 |
| Common    |      1083.50 |     5889.23 |      4111.63 |
| Filtered  |      1034.90 |      841.13 |      1408.48 |

The common query regressed in both rounds; directory time was 5,537 ms first and 3,627 ms repeated, compared with 383 ms before. Selective improvement on the repeat did not establish a whole-workload benefit. The 96-response experimental load preserved exact rows/scores and sequence barriers but reduced throughput across all phases against the preceding 16-segment runtime measurement.

| Concurrency | 64 p50 ms | 64 p95 ms | 64 requests/s |
| ----------: | --------: | --------: | ------------: |
|           1 |     68.83 |    966.57 |          2.34 |
|           4 |     84.20 |   1104.71 |          8.97 |
|          16 |    359.33 |   1546.04 |         16.31 |

The experiment was rejected and the 16-segment source restored. Fewer internal calls alone did not prove lower native latency. Larger source batches can increase cold work per entrypoint and cache retention pressure; this is an inference from the timings, not independently measured CPU or memory proof.

Restored deployment completed. The three fresh-selector checks again matched strong rows/scores, taking 1,640/1,366/998 ms for selective/common/filtered queries; common-query latency improved against both 64-segment rounds. Directory timings remained 648–949 ms, so the wider directory bottleneck is unresolved.

## Eight concurrent immutable catalog reads

The catalog reader now processes up to eight 16-segment batches concurrently, preserving native ordered `Effect.forEach` results and manifest-order live frequency aggregation. Posting/document concurrency, batch schemas, canonical R2 formats, cache identities and admission budgets remain unchanged. The boundary regression spans 129 segments (nine batches), checking complete and partial batches, exact request counts, filtered scores and live frequency preservation. The full gate passed 116 Worker/tooling and 19 Rust tests.

The unchanged million-document native corpus was measured before/after deployment. Each phase has 32 edge responses compared exactly against strong rows/scores and sequence barriers; 288 responses passed across the three complete runs. Before/first-after loads overlapped the three fresh-selector diagnostics; the repeated after load ran without those diagnostics. Regional/isolate caches and network conditions were uncontrolled.

| Catalog concurrency | Public concurrency | p50 ms |  p95 ms | Requests/s |
| ------------------- | -----------------: | -----: | ------: | ---------: |
| 4 before            |                  1 |  94.50 |  507.22 |       5.05 |
| 4 before            |                  4 | 101.90 |  749.17 |      14.19 |
| 4 before            |                 16 | 343.35 | 1165.62 |      20.16 |
| 8 first             |                  1 |  75.09 |  433.14 |       6.17 |
| 8 first             |                  4 |  73.24 |  908.78 |      22.49 |
| 8 first             |                 16 |  87.22 | 1270.57 |      23.11 |
| 8 repeated          |                  1 | 104.59 | 1014.42 |       3.72 |
| 8 repeated          |                  4 |  98.03 |  873.32 |      12.34 |
| 8 repeated          |                 16 | 183.64 |  968.68 |      25.51 |

Both eight-read runs improved the public-concurrency-sixteen median and throughput against the reference. The repeated p95 also improved. Public concurrency one/four regressed throughput in the repeat, so the observations do not establish a universal improvement. The bounded increase was retained for its measured high-concurrency benefit; low-load tails, peak memory and general Turbopuffer parity remain open.

| Query     | 4 reads before ms | 8 reads after ms |
| --------- | ----------------: | ---------------: |
| Selective |           2409.28 |          1556.20 |
| Common    |           1000.40 |          1245.74 |
| Filtered  |           1070.43 |           520.20 |

All six diagnostic responses matched strong rows/scores. Directory time changed from 1,058/388/632 ms to 743/504/285 ms; the common-query regression and snapshot variation limit attribution. Deployment completed before both after measurements.

## Partial immutable catalog reuse

The catalog reader previously abandoned the memory-hit scan at the first miss and fetched every range in a partially cached batch. It now retains all immutable hits, fetches only missing ranges, and merges the response by original position before global live frequency aggregation. Held query-local catalogs survive LRU eviction by concurrent batch admission. Physical bucket, immutable object/header, terms and filter identity remain unchanged. Native response/count validation and the bounded batch/concurrency budgets remain in force.

A workerd regression prepares 15 immutable single-document segments and queries them, then adds the sixteenth segment. The old binary requested all 16 catalogs; the new reader requests one and reports 15 memory hits. This is a 93.75% reduction in requested catalog projections for that incremental-write case, not a whole-query latency claim. The test also checks the new global score, then replaces a document and deletes another, checking exact live IDs and an independent BM25 score. It failed on the old reader (`expected 1, received 16`) and passed with the change. The full gate passed 117 Worker/tooling and 19 Rust tests.

Native deployment completed and the unchanged million-document read-only corpus passed two complete 96-response loads, one before and one after. Every edge response matched strong rows/scores and the sequence barrier. This workload does not write between queries and therefore does not isolate the incremental-write benefit. Isolate/cache/network placement was uncontrolled.

| Runtime | Concurrency | p50 ms |  p95 ms | Requests/s |
| ------- | ----------: | -----: | ------: | ---------: |
| before  |           1 |  69.19 |  318.07 |       8.53 |
| before  |           4 |  85.07 |  716.51 |      14.78 |
| before  |          16 | 157.21 | 1147.17 |      24.55 |
| after   |           1 |  72.64 |  569.17 |       5.94 |
| after   |           4 |  72.63 |  946.23 |      19.54 |
| after   |          16 | 140.51 | 1018.69 |      21.28 |

The after run improved concurrency-four throughput and concurrency-sixteen median/p95, while concurrency-one and sixteen throughput regressed. Native whole-query effects remain mixed. The retained change removes reproducible unnecessary immutable catalog projections after writes; no general latency or Turbopuffer parity claim follows from it.

## Reused Rust candidate buffers and early exclusion

The Rust ranker reuses one posting-selection vector per finish operation instead of allocating a BTreeMap for every candidate. Phrase token positions are mapped once into the sorted term slots, preserving repeated terms and field-specific positional matching. Query terms are sorted/deduplicated in their small vector instead of an intermediate BTreeSet. Rows excluded by filters or tombstones advance their posting cursors without calculating a score. Term accumulation order, live global statistics, exact block-bound guards and deterministic ties remain unchanged; canonical R2 formats and cache identities do not change.

The integrated full gate passed 117 Worker/tooling and 20 Rust tests. A new native regression checks repeated-token phrase order and excluded candidate state. A deterministic differential test compared 1,296 old/new WASM query pairs on 256 varied documents: Unicode normalization, eight filter selections, empty/absent terms, repeated phrases, top-k 1/10/100, and tombstones with recomputed live statistics. Every serialized row, ID and score matched exactly.

Alternating local WASM measurements use ten warmup pairs and 100 measured pairs per case, timing Ranker.finish only. Directory/ranker acquisition and posting decompression are excluded. Both binaries rank identical segments with top-k ten, four tombstones and an optional group equality filter.

| Documents | Match  | Filter | Before p50 ms | After p50 ms |
| --------: | ------ | ------ | ------------: | -----------: |
|       500 | any    | False  |         0.389 |        0.309 |
|       500 | any    | True   |         0.347 |        0.187 |
|       500 | all    | False  |         0.204 |        0.178 |
|       500 | all    | True   |         0.170 |        0.096 |
|       500 | phrase | False  |         0.162 |        0.083 |
|       500 | phrase | True   |         0.081 |        0.018 |
|     10000 | any    | False  |         4.586 |        4.043 |
|     10000 | any    | True   |         4.250 |        2.927 |
|     10000 | all    | False  |         4.718 |        4.183 |
|     10000 | all    | True   |         4.262 |        2.922 |
|     10000 | phrase | False  |         2.548 |        1.330 |
|     10000 | phrase | True   |         1.313 |        0.267 |

These local kernel gains do not establish whole-query or Turbopuffer parity. An initial copy-only full gate was blocked by sandbox EPERM while Miniflare opened its local server; after workspace restrictions were lifted, the integrated full gate completed successfully.

Native deployment completed on the unchanged million-document corpus. The first post-deploy edge load aborted with HTTP 503 (`Snapshot freshness budget exceeded`, gateway 1,336 ms); it produced no complete report and is not counted as a passing load. The pre-deploy reference and a subsequent post-deploy repetition each completed 96 responses, preserving exact strong rows/scores and sequence barriers. The failed attempt remains evidence that first-use snapshot reliability is unresolved.

| Runtime        | Concurrency | p50 ms |  p95 ms | Requests/s |
| -------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 |  75.79 |  717.15 |       4.47 |
| Before         |           4 |  91.77 |  958.00 |      12.51 |
| Before         |          16 | 461.53 | 1745.21 |      18.28 |
| After repeated |           1 |  67.66 |  267.92 |       8.17 |
| After repeated |           4 |  77.70 |  845.48 |      15.54 |
| After repeated |          16 | 141.35 | 1195.39 |      19.38 |

The completed repeat improved median, p95 and throughput in all three phases against this reference; uncontrolled isolate/cache/network conditions prevent attributing that whole-query difference solely to Rust. Local alternating binary measurements support a kernel gain of 11–46% for any/all and 48–80% for these phrase fixtures. The change does not fix snapshot acquisition failures or prove Turbopuffer parity.

## Query-local prepared Rust block bounds

The ranker previously looked up term metadata and recalculated the same block BM25 bound at every candidate after filling top-k. It now prepares an ordered vector of block references and exact bounds once per finish operation, only when a full top-k first makes pruning possible. Existing linear first-match block selection, term summation order, floating-point guard and tie behavior remain unchanged. No block ordering assumption or persisted/cache format changes were introduced. Local lifetime and lazy acquisition avoid retaining query statistics globally and avoid preparing unused bounds for queries without enough hits.

The eager prototype reduced any/all CPU on larger segments but regressed several 16-document fixtures; it was replaced before deployment by demand-driven preparation. Alternating original/final WASM measurements used ten warmup pairs and 100 measured pairs, top-k ten, four tombstones and optional equality filters. They time finish only, excluding decompression and acquisition. All result rows and scores match.

| Documents | Match  | Filter | Before p50 ms | After p50 ms |
| --------: | ------ | ------ | ------------: | -----------: |
|        16 | any    | False  |        0.0171 |       0.0180 |
|        16 | any    | True   |        0.0049 |       0.0049 |
|        16 | all    | False  |        0.0129 |       0.0128 |
|        16 | all    | True   |        0.0041 |       0.0042 |
|        16 | phrase | False  |        0.0073 |       0.0072 |
|        16 | phrase | True   |        0.0033 |       0.0032 |
|       500 | any    | False  |        0.1843 |       0.1060 |
|       500 | any    | True   |        0.0947 |       0.0332 |
|       500 | all    | False  |        0.1761 |       0.1014 |
|       500 | all    | True   |        0.0942 |       0.0330 |
|       500 | phrase | False  |        0.0881 |       0.0904 |
|       500 | phrase | True   |        0.0177 |       0.0177 |
|     10000 | any    | False  |        4.1202 |       2.6759 |
|     10000 | any    | True   |        3.0110 |       1.5648 |
|     10000 | all    | False  |        4.0896 |       2.6667 |
|     10000 | all    | True   |        2.9293 |       1.5486 |
|     10000 | phrase | False  |        1.6695 |       1.6189 |
|     10000 | phrase | True   |        0.2875 |       0.2778 |

Small-query and phrase results were close to baseline, with occasional microsecond regressions. Any/all on 500/10,000-document fixtures gained substantially; this is an operation-level improvement, not a universal whole-query guarantee. The full local gate passed 117 Worker/tooling and 20 Rust tests; all 1,296 differential query pairs preserved exact rows/scores, including empty/missing terms, Unicode, repeated phrases, filters, live frequencies, tombstones and top-k 1/10/100.

Native deployment completed on the unchanged million-document corpus. The first post-deploy load aborted with HTTP 503 (`Snapshot freshness budget exceeded`, gateway 1,358 ms) and produced no complete report; it is not a passing load. The pre-deploy reference and one subsequent repetition each completed 96 responses with exact strong rows/scores and sequence barriers. Snapshot first-use reliability remains unresolved.

| Runtime        | Concurrency | p50 ms |  p95 ms | Requests/s |
| -------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 | 101.56 |  511.02 |       5.30 |
| Before         |           4 | 106.67 |  873.49 |      14.63 |
| Before         |          16 | 241.06 | 1477.99 |      15.09 |
| After repeated |           1 |  71.74 |  332.81 |       8.13 |
| After repeated |           4 |  68.60 |  571.81 |      16.80 |
| After repeated |          16 | 155.17 | 1179.61 |      19.79 |

The complete repeat improved median, p95 and throughput in all phases against this reference, but uncontrolled cache/isolate/network conditions prevent attributing that change solely to Rust. Kernel measurements support the local larger-segment any/all gain; the aborted snapshot request prevents a universal reliability or Turbopuffer parity claim.

## Rejected fixed Rust positional field storage

Posting decoding used a heap Vec to temporarily hold exactly two title/body positional vectors. An uncommitted experiment replaced it with a fixed two-element array and destructured the fields in wire order. The experiment was rejected after two native regressions and the prior decoder restored. The experiment retained exact capacity reservation, avoiding the larger minimum capacity of generic reserve for short fields. Varint overflow, row/position ordering, field length, empty posting, framing, CRC, decompressed length and trailing-byte validation remain unchanged; no wire or cache formats change.

Alternating old/new WASM measurements used five warmup pairs and sixty measured pairs per fixture, timing all Ranker.add calls (WASM input transfer, decompression, decoding and header/list validation). Ranker acquisition, finish and release are outside the measured interval. Density one/twelve repeats `alpha beta gamma` one/twelve times in each body, with variable trailing gamma counts. Every finished row and score matched exactly.

| Documents | Density | Blocks | Before p50 ms | After p50 ms |
| --------: | ------: | -----: | ------------: | -----------: |
|       500 |       1 |     12 |         0.559 |        0.444 |
|       500 |      12 |     12 |         1.051 |        0.877 |
|     10000 |       1 |    237 |         5.451 |        4.176 |
|     10000 |      12 |    237 |         9.504 |        7.566 |

All four local fixtures improved p50 by 16–23%; these are local decode/add measurements, not native whole-query latency. The full gate passed 117 Worker/tooling and 20 Rust tests, and 1,296 original/new differential query pairs preserved exact rows/scores.

The unchanged million-document corpus completed four 96-response native loads: original, experimental first, experimental repeated and restored. All 384 edge responses matched strong rows/scores and sequence barriers. No corpus writes occurred.

| Configuration     | Concurrency | p50 ms |  p95 ms | Requests/s |
| ----------------- | ----------: | -----: | ------: | ---------: |
| Original          |           1 |  64.38 |  108.03 |      12.25 |
| Original          |           4 |  73.62 |  604.55 |      21.44 |
| Original          |          16 | 190.17 |  972.22 |      26.32 |
| Array first       |           1 |  75.55 |  462.07 |       4.77 |
| Array first       |           4 |  74.39 | 2631.00 |       6.41 |
| Array first       |          16 | 358.57 | 3111.74 |       7.46 |
| Array repeated    |           1 |  74.90 |  354.65 |       6.48 |
| Array repeated    |           4 |  72.97 | 1784.82 |       8.56 |
| Array repeated    |          16 | 376.93 | 4649.08 |       5.78 |
| Original restored |           1 |  63.97 |  226.37 |       9.93 |
| Original restored |           4 |  89.89 |  954.59 |      16.65 |
| Original restored |          16 | 129.12 | 1247.37 |      16.59 |

Both experimental loads regressed throughput in every phase against the original run; the first concurrency-one server trace spent 955 ms in the rank phase, which also includes acquisition and is not a pure decode timer. Restored throughput improved against both experimental runs in every phase, although it remained below the original reference. Cache/isolate/network conditions were uncontrolled, so this does not independently prove the small Rust change caused the full regression. The native evidence did not justify retaining it. The original decoder source and deployment were restored, preserving the prior candidate-buffer and block-bound optimizations. The README reports the restored measurement; no application change from this experiment remains.

## Rejected exact declared Rust page output buffer

An uncommitted experiment replaced miniz_oxide's dynamically doubling Vec decompressor with its native fixed-slice API. It was rejected after mixed native observations and the previous decoder restored. Pages already declare a decoded length; that value is checked against the same sixteen-MiB ceiling before allocating the output. The API retains zlib Adler-32 validation (`ignore_adler32=false`), and the reader still checks actual output length and CRC. No compressed or decoded wire format changes. Native tests include empty pages, declared shorter/longer/over-budget lengths, incorrect CRC/Adler and truncated streams.

The integrated gate passed 117 Worker/tooling and 21 Rust tests; 1,296 differential WASM query pairs preserved exact rows and scores. A first alternating benchmark overlapped other checks and had noisy tails; the reported isolated repeat used five warmup pairs and sixty measured pairs per fixture. It times Ranker.add calls, including input transfer, decompression, decoding and list/header validation; acquisition and finish are excluded.

| Documents | Density | Blocks | Before p50 ms | After p50 ms | Before p95 ms | After p95 ms |
| --------: | ------: | -----: | ------------: | -----------: | ------------: | -----------: |
|       500 |       1 |     12 |         0.316 |        0.295 |         0.483 |        0.473 |
|       500 |      12 |     12 |         0.463 |        0.406 |         0.493 |        0.438 |
|     10000 |       1 |    237 |         5.619 |        5.215 |         6.528 |        6.113 |
|     10000 |      12 |    237 |         9.383 |        8.180 |        11.149 |        9.980 |

The isolated local p50 gain was 7–13%, with improved p95 in all four fixtures. This is a local operation measurement, not a Cloudflare whole-query guarantee or measured peak-memory proof.

The unchanged million-document corpus completed four 96-response native loads: before, experimental first, experimental repeat and restored repeat. All 384 completed edge responses matched strong rows/scores and sequence barriers. The first restored load aborted with HTTP 503 (`Snapshot freshness budget exceeded`, gateway 1,066 ms) and produced no complete report; it is not counted as passing.

| Configuration           | Concurrency | p50 ms |  p95 ms | Requests/s |
| ----------------------- | ----------: | -----: | ------: | ---------: |
| Before                  |           1 |  96.19 |  586.63 |       5.68 |
| Before                  |           4 |  75.85 |  684.29 |      19.91 |
| Before                  |          16 |  95.82 |  727.70 |      20.35 |
| Fixed buffer first      |           1 | 140.76 | 1200.45 |       2.85 |
| Fixed buffer first      |           4 | 115.92 | 1436.66 |      10.45 |
| Fixed buffer first      |          16 | 584.44 | 1545.53 |      18.39 |
| Fixed buffer repeated   |           1 |  80.04 |  263.47 |       8.23 |
| Fixed buffer repeated   |           4 |  90.25 |  955.25 |      10.92 |
| Fixed buffer repeated   |          16 | 393.43 | 1247.39 |      17.71 |
| Dynamic restored repeat |           1 |  68.30 |  511.32 |       5.65 |
| Dynamic restored repeat |           4 | 126.15 |  810.40 |      12.96 |
| Dynamic restored repeat |          16 | 112.45 | 1242.01 |      22.16 |

The fixed-buffer repeat improved the public-concurrency-one phase, but regressed concurrency-four/sixteen against the reference. Restoring the previous decoder improved concurrency-four/sixteen throughput against both experimental runs, while restored concurrency-one remained mixed. Cache/isolate/network placement was uncontrolled, so these are not isolated native CPU measurements. They provided insufficient whole-workload evidence to retain the change. The algorithm and deployment were restored; the new page-integrity regression was retained and the restored full gate passed all 138 tests. Snapshot first-use reliability remains open. The follow-up below isolates native CPU from R2/cache acquisition.

## Native CPU follow-up for the declared page buffer

A temporary Alchemy stack deployed both WASM binaries in one Cloudflare Worker, with an authenticated Tail Worker storing only synthetic sample identifiers and native `TraceItem.cpuTime`/`wallTime` receipts in a temporary R2 bucket. Producer requests performed no R2/cache acquisition. The producer compared baseline/candidate rows and scores exactly when preparing each fixture and after each add batch; rank requests checked every repeated finish. Cloudflare runtime timers freeze during CPU work, so `performance.now()` was not used as a native CPU timer. See the [runtime timing contract](https://developers.cloudflare.com/workers/runtime-apis/performance/) and [Tail Worker contract](https://developers.cloudflare.com/workers/observability/logs/tail-workers/).

Each case alternated request order across 23 pairs, excluded three warmup pairs and every request that prepared a new fixture. Small cases used 128 operations per request, large cases 16. The reported native invocation CPU is divided by that repetition count; add includes ranker acquisition, input transfer, decoding, release and one final correctness check. It is not the narrower local add timer above. Authentication, schema validation and receipt encoding also contribute to invocation CPU. Both versions share the deployed Worker, but isolate lifecycle and Cloudflare hardware scheduling remain uncontrolled. A rank-only control exercises unchanged ranking code.

| Documents | Density | Operation | Baseline samples | Candidate samples | Baseline p50 ms/op | Candidate p50 ms/op | Baseline p95 ms/op | Candidate p95 ms/op |
| --------: | ------: | :-------- | ---------------: | ----------------: | -----------------: | ------------------: | -----------------: | ------------------: |
|       500 |       1 | add       |               20 |                20 |           0.312500 |            0.296875 |           0.539062 |            0.468750 |
|       500 |       1 | rank      |               20 |                20 |           0.085938 |            0.093750 |           0.148438 |            0.195312 |
|       500 |      12 | add       |               20 |                20 |           0.460938 |            0.445312 |           0.835938 |            0.851562 |
|       500 |      12 | rank      |               20 |                20 |           0.085938 |            0.078125 |           0.179688 |            0.164062 |
|     10000 |       1 | add       |               20 |                20 |           6.187500 |            5.562500 |          10.625000 |           10.500000 |
|     10000 |       1 | rank      |               20 |                19 |           2.750000 |            2.812500 |           4.000000 |            3.437500 |
|     10000 |      12 | add       |               20 |                20 |          11.625000 |           12.562500 |          18.187500 |           16.562500 |
|     10000 |      12 | rank      |               20 |                20 |           2.750000 |            2.625000 |           4.687500 |            3.062500 |

All 369 producer invocations completed with exact matching results and native `ok` outcomes. Five fixture preparations were discarded, including one additional preparation in the large low-density rank control, leaving 19 candidate samples there. Decoding medians improved by 3–10% in three cases, but regressed by 8% for 10,000 high-density documents. The unchanged rank control also varied between versions, demonstrating residual scheduling noise. The combined evidence does not establish a consistent native gain; the original dynamic decompressor remains deployed. No production source, corpus, cache configuration or search resource changed during this follow-up. Synthetic receipts were exported before removing the two temporary Workers and bucket. This CPU measurement does not establish whole-query latency, peak memory or Turbopuffer parity.

## Rejected binary lookup of Rust pruning blocks

The pruning loop previously searched each term's block bounds from the beginning for every candidate row. The candidate checks the prepared bounds once and uses binary lookup for at least eight non-overlapping, ordered blocks. Short, overlapping, inverted or unordered block ranges retain the original first-match linear search. Bound scores, term accumulation order, epsilon, tie-breaking, filters, tombstones, phrase order and wire/cache formats remain unchanged. A regression compares selected bounds with the original linear rule over gaps, overlaps, unordered/inverted ranges, empty lists and the binary path.

A local alternating WASM comparison preserved all 1,296 query results/scores across any/all/phrase modes, eight filters, three top-k budgets and live statistics/tombstones. Larger 10,000-document any/all cases improved median finish time by 17–25%; the filtered phrase case improved 3%. Small cases varied by microseconds. The local timing overlapped validation on a heavily loaded shared machine, so native CPU evidence is reported separately.

The temporary native CPU harness described above was rebuilt with the current baseline and candidate. This round measured rank-only requests: 23 alternating pairs per fixture, three excluded warmup pairs, 128 repetitions for 500 documents and 16 for 10,000. Every repetition checked exact rows/scores. The producer acquired no R2/cache data. Native invocation CPU includes validation and output serialization and is divided by repetitions. Isolate lifecycle and hardware scheduling remain uncontrolled.

| Documents | Density | Baseline samples | Candidate samples | Baseline p50 ms/op | Candidate p50 ms/op | Baseline p95 ms/op | Candidate p95 ms/op |
| --------: | ------: | ---------------: | ----------------: | -----------------: | ------------------: | -----------------: | ------------------: |
|       500 |       1 |               20 |                20 |           0.164062 |            0.140625 |           0.242188 |            0.351562 |
|       500 |      12 |               20 |                20 |           0.156250 |            0.156250 |           0.218750 |            0.273438 |
|     10000 |       1 |               19 |                20 |           4.437500 |            3.625000 |           5.187500 |            5.625000 |
|     10000 |      12 |               20 |                20 |           4.500000 |            3.375000 |           5.375000 |            4.187500 |

All 185 invocations completed with matching results and native `ok` outcomes. Fresh fixture preparation is excluded; an additional preparation left 19 baseline samples for the large low-density case. Larger-segment median CPU improved 18–25%; p95 improved in the dense case and regressed in the low-density case. The candidate did not establish improved whole-query latency, peak-memory or Turbopuffer parity. The temporary two Workers and bucket were removed after receipt export.

Local lint, typechecking, native/WASM Clippy and all 22 Rust tests passed. Two full default-timeout gates failed with workerd test timeouts: one R2 listing test in the first run, then vector rebuild and long-history reload tests in the second. The shared machine had load averages above 100. All 117 Worker/tooling tests passed with the identical assertions and a 30-second per-test timeout; repository timeout configuration was unchanged. A subsequent local full gate passed with the default timeout after machine load subsided; the independent CI gate also passed ([run 38578665699](https://github.com/minutei-ai/kannin/actions/runs/38578665699)).

The unchanged million-document corpus then completed four 96-response loads: original, candidate first, candidate repeated and original restored. All 384 edge responses matched strong rows/scores and sequence barriers, with the corpus remaining at one million documents and sequence 2,000. No corpus writes occurred. Each phase used 32 requests, four text cases, no separate warmup and uncontrolled cache/isolate/network conditions.

| Configuration      | Concurrency | p50 ms |  p95 ms | Requests/s |
| :----------------- | ----------: | -----: | ------: | ---------: |
| Original           |           1 |  78.05 |  680.28 |       4.96 |
| Original           |           4 |  72.08 | 1086.42 |      13.79 |
| Original           |          16 | 128.97 | 2045.28 |      15.58 |
| Candidate first    |           1 | 123.27 | 1061.58 |       3.02 |
| Candidate first    |           4 |  94.19 | 1194.87 |      12.97 |
| Candidate first    |          16 | 156.45 | 1753.02 |      13.84 |
| Candidate repeated |           1 |  96.94 |  824.23 |       4.35 |
| Candidate repeated |           4 |  89.61 |  867.13 |      13.65 |
| Candidate repeated |          16 | 221.34 |  870.20 |      16.07 |
| Original restored  |           1 |  81.51 |  538.25 |       6.33 |
| Original restored  |           4 |  80.70 |  971.67 |      12.98 |
| Original restored  |          16 | 138.42 | 1215.32 |      17.96 |

Both candidate runs regressed median latency in every phase against the reference. Candidate throughput regressed in all first-run phases; its repeat remained below the reference at concurrency one/four and improved slightly at sixteen. Restoration reduced medians in all phases against both candidate runs, while tail latency/throughput remained mixed. These uncontrolled loads do not prove the binary lookup caused the regression, but they did not justify promoting it as a whole-search improvement. Production was restored to the previous Rust source; the candidate and its passing CI remain in `perf/rust-block-lookup` for reproducibility. The README reports the restored load. Native CPU gain alone does not establish end-to-end speed or Turbopuffer parity.

## Coordinator recovery for unavailable edge snapshots

Two catalog-candidate loads aborted with `Snapshot freshness budget exceeded`, even though the waiting request measured only 504/909 ms at the gateway: a shared acquisition may have started before that request. The catalog candidate was archived and the previous source restored before changing snapshot recovery. The gateway now rejects the expired snapshot as an input to edge ranking and forwards its original authenticated request to the coordinator. It also forwards a successfully decoded snapshot that is below minimumSequence, allowing the coordinator to revalidate that barrier against its current view rather than rejecting from an older overlapping read. Genuine future sequences still return 409; storage/decoding failures retain their existing failure path. No age window, cache TTL, R2 format, scorer or authorization rule changes. The fallback may add a coordinator network hop after acquisition; it is recovery, not a latency guarantee.

`edge_snapshot_fallback` Server-Timing makes forwarding visible per response. The local regression first failed for missing recovery timing, then passed after the change; its second red/green case exercises a populated namespace with an uncommitted minimum sequence. It covers preserved request bodies, empty namespaces, future barriers and post-write results. The complete default gate passed 21 Rust and 118 Worker/tooling tests with 1,098 assertions, including cache-age, namespace/auth isolation and canonical-corruption checks. The local regression does not force a delayed native R2 acquisition; that expiration branch still requires direct native evidence.

An age-recovery-only deployment completed a 96-response native filter load with exact strong rows/scores and no coordinator fallbacks. The final deployment includes insufficient-sequence recovery and completed 64-request phases at concurrency one/four/sixteen against the unchanged one-million-document corpus, sequence 2,000. All 192 responses matched strong rows/scores and the sequence barrier. The four cases use `cloudflare` without a filter and group filters 42/43/44; no separate warmup was used. These counts/workload differ from the README's previous 32-request rare/selective/common/filter mix, so the measurements are not a direct speedup comparison.

| Concurrency | Requests | p50 ms |  p95 ms | Requests/s |
| ----------: | -------: | -----: | ------: | ---------: |
|           1 |       64 |  76.31 |  376.12 |       6.44 |
|           4 |       64 |  81.00 |  885.96 |      18.98 |
|          16 |       64 |  95.94 | 1530.77 |      36.43 |

No response in either completed load carried the fallback marker, so the formerly failing native expiration condition was not exercised and no universal reliability claim is made. A separate authenticated native future-sequence request against the populated corpus did carry the coordinator fallback timing and returned 409, preserving the uncommitted barrier. Cache/isolate/network conditions remain uncontrolled, peak-memory proof and fully indexed Turbopuffer comparison remain outstanding. The following section records the shared-catalog repeat against this recovery path.

## Shared term dictionaries and eligibility minima

The process cache now owns one bounded entry per bucket, immutable segment key and header length, with dictionaries indexed by term selector and eligibility minima indexed by filter selector. This replaces complete duplicated catalog entries per selector/filter combination. Missing-part groups preserve order, acquire only missing data and retain query-local references across cache eviction. The total conservative charge remains capped at four MiB. The native internal projection accepts zero terms for eligibility-only acquisition; public text queries retain their existing contract. Physical frequencies and minima remain immutable, and live global statistics/tombstones are recomputed against the chosen root.

The 129-segment local regression initially received 14,392 bytes on a filter change after a 14,457-byte initial response. It now requires less than half the initial response bytes while preserving exact rows/scores. It also covers changed terms with retained filters, a subsequent zero-request warm query with 129 complete memory hits, the cache budget and incremental-write/tombstone behavior. The integrated default gate passed 21 Rust and 118 Worker/tooling tests with 1,105 assertions.

The native million-document comparison used `cloudflare` with no filter and group filters 42/43/44. Every phase used 32 requests. Baseline, first candidate and two repeated candidate loads all completed; all 384 edge responses matched strong rows/scores and sequence 2,000. No separate warmup was used, and cache/isolate/network conditions were uncontrolled. None of these responses used coordinator recovery.

| Configuration        | Concurrency | p50 ms |  p95 ms | Requests/s |
| :------------------- | ----------: | -----: | ------: | ---------: |
| Baseline             |           1 |  81.14 |  900.50 |       4.31 |
| Baseline             |           4 | 104.96 |  888.25 |      12.19 |
| Baseline             |          16 | 631.56 | 1077.35 |      15.80 |
| Shared first         |           1 | 167.87 |  878.58 |       3.05 |
| Shared first         |           4 | 215.25 | 1032.42 |       9.91 |
| Shared first         |          16 | 695.14 | 1332.16 |      13.07 |
| Shared repeat        |           1 |  88.56 |  481.67 |       5.40 |
| Shared repeat        |           4 |  90.74 |  282.23 |      27.53 |
| Shared repeat        |          16 | 265.32 | 1157.42 |      16.10 |
| Shared second repeat |           1 | 131.56 |  810.06 |       3.56 |
| Shared second repeat |           4 | 121.16 |  885.56 |      12.70 |
| Shared second repeat |          16 | 218.40 | 1031.04 |      15.82 |

First-load medians and throughput regressed. Repeated concurrency-sixteen medians improved against this reference, but lower concurrency and throughput remained mixed. This is not evidence of a uniform whole-query speedup. A separate read-only native coordinator diagnostic observed 200 segment catalogs: initial dictionary/minimum acquisition transferred 101,243 bytes, while each new filter acquired 7,013 bytes (93% less than the initial payload). A second cycle of all four queries transferred zero catalog bytes, made zero catalog requests and recorded 200 complete memory hits per query. The resulting cache charge was 754,268 bytes. Counters are process-scoped; this short sequential diagnostic is distinct from the uncontrolled edge load and is not a per-request billing meter.

The change is retained for demonstrated transfer reduction and dictionary/minimum reuse, not a universal latency claim. The general rare/selective/common/filter workload then completed another 96 exact edge responses at the same corpus sequence, for 480 verified responses across these five complete loads. Its latest values are shown below and in the README; they are a different query mix from the shared-filter comparison.

| Concurrency | p50 ms |  p95 ms | Requests/s |
| ----------: | -----: | ------: | ---------: |
|           1 | 136.11 | 1091.42 |       3.51 |
|           4 | 105.80 |  699.75 |      17.33 |
|          16 | 468.70 | 1289.97 |      19.50 |

Source and deployment include snapshot coordinator recovery. First-use expiration recovery was not exercised in these completed loads; native peak-memory proof and fully indexed Turbopuffer parity remain unverified.

## Rust intersection candidates for all and phrase modes

The previous loop traversed the union of posting lists and scored partial matches before rejecting rows missing a required term. The retained cursor owner now drives all/phrase traversal from the shortest list, advances other lists directly toward that candidate with exponential search plus a bounded binary partition, and stops when any required list is exhausted. Excluded driver rows are skipped before alignment. Full physical coverage has a direct row/index path; it resynchronizes cursors only after exclusions create divergence. Any traversal, block score bounds, term accumulation order, tie-breaking and positional phrase semantics remain unchanged. No wire/cache formats or infrastructure bindings change.

The initial plain binary seeks regressed alternating disjoint lists, especially with filters; adaptive seeks and early exclusions removed that regression. An initial full-coverage implementation rewrote every cursor on every candidate and regressed dense unfiltered queries; synchronizing only after divergence removed that overhead. Native Clippy rejected an oversized finish function; cursor navigation now owns its actual traversal state and policy, without suppressions. Local alternating finish measurements used ten warmup pairs and one hundred measured pairs for 16/500/10,000 documents, dense/sparse/disjoint postings, any/all/phrase modes and filtered/unfiltered cases. Large sparse all/phrase medians improved 96–97%; disjoint cases improved 77–95%; dense filtered cases improved 78–80%, while dense unfiltered medians stayed close to the reference. Every fixture preserved finished rows/scores. A separate 1,296-query differential preserved exact rows/scores over filters, top-k, tombstones, live statistics and repeated words.

The independent Rust regression derives all-term membership and contiguous phrase positions from input title/body tokens, then checks exact scores/order against the unaffected any-mode exhaustive result over the entire small fixture. It covers both fields, repeated alpha, disjoint terms, filters, tombstones and top-k 1/10/100. The default gate passed 22 Rust and 118 Worker/tooling tests.

A temporary native Worker ran both WASM versions against identical synthetic bytes. Each of eleven cases used 23 alternating pairs with 128 finish repetitions per invocation; three warmup pairs and every fixture-preparation request were excluded. All 506 invocations finished with exact matching results and native `ok` outcomes. Twelve fixture preparations occurred, all outside measured samples; each variant has twenty measured samples per case. One fixture is retained at a time. Tail Worker CPU receipts include invocation validation/serialization overhead and are divided by repetitions; the producer performs no R2/cache acquisition. One-ms receipt granularity limits interpretation of the smallest per-operation values. Isolate lifecycle and scheduling remain uncontrolled.

| Distribution | Mode   | Filter | Before p50 ms/op | After p50 ms/op | Before p95 ms/op | After p95 ms/op |
| :----------- | :----- | :----- | ---------------: | --------------: | ---------------: | --------------: |
| Dense        | any    | False  |         2.554688 |        2.625000 |         3.875000 |        4.328125 |
| Dense        | all    | False  |         2.484375 |        2.390625 |         4.117188 |        4.140625 |
| Dense        | all    | True   |         1.804688 |        0.296875 |         2.945312 |        0.359375 |
| Sparse       | all    | False  |         1.632812 |        0.039062 |         2.453125 |        0.101562 |
| Sparse       | all    | True   |         0.335938 |        0.007812 |         0.742188 |        0.265625 |
| Sparse       | phrase | False  |         1.468750 |        0.039062 |         1.921875 |        0.046875 |
| Sparse       | phrase | True   |         0.312500 |        0.007812 |         0.367188 |        0.031250 |
| Disjoint     | all    | False  |         0.476562 |        0.109375 |         1.039062 |        0.218750 |
| Disjoint     | all    | True   |         0.210938 |        0.015625 |         0.398438 |        0.039062 |
| Disjoint     | phrase | False  |         0.500000 |        0.171875 |         0.851562 |        0.250000 |
| Disjoint     | phrase | True   |         0.210938 |        0.015625 |         0.398438 |        0.078125 |

Native sparse all/phrase median CPU improved 97–98%, dense filtered all improved 84%, and disjoint all/phrase improved 66–93%. The any-mode control median increased 2.8% with a noisier tail, while dense unfiltered all improved 3.8%; neither is a universal latency claim. Receipts were exported before removing the two temporary Workers and bucket.

The unchanged million-document corpus completed original, first candidate and repeated candidate loads with rare compound all, common all, filtered all and common phrase queries. Every phase used 32 edge requests. All 288 responses matched strong rows/scores and sequence 2,000; none used coordinator recovery. No separate warmup was used and cache/isolate/network conditions were uncontrolled.

| Configuration         | Concurrency | p50 ms |  p95 ms | Requests/s |
| :-------------------- | ----------: | -----: | ------: | ---------: |
| Original              |           1 |  83.32 | 1062.91 |       3.74 |
| Original              |           4 | 110.25 |  822.48 |      16.57 |
| Original              |          16 | 165.86 | 1244.78 |      16.85 |
| Intersection first    |           1 |  80.39 |  311.43 |       7.69 |
| Intersection first    |           4 |  98.29 | 1289.86 |      10.76 |
| Intersection first    |          16 | 196.87 | 1250.30 |      20.21 |
| Intersection repeated |           1 |  83.39 |  391.98 |       4.60 |
| Intersection repeated |           4 |  89.65 |  935.60 |      12.80 |
| Intersection repeated |          16 | 344.41 | 1216.54 |      15.49 |

Whole-query observations were mixed: concurrency-four medians improved in both candidate runs, concurrency-one tails improved, but concurrency-sixteen median latency regressed. Native CPU evidence establishes the targeted traversal gain independently of this acquisition/network noise; it does not establish a uniform whole-search gain. A separate general rare/selective/common/filter load completed 96 exact responses at the same sequence, for 384 verified whole-query responses across four complete loads. Its latest values are in the README. Native peak-memory proof, exercised expired-acquisition recovery and fully indexed Turbopuffer parity remain outstanding.

## Manifest acquisition size and compact-filter exploration

The native million-document corpus has 200 segments and a 5,448,863-byte Schema-encoded manifest at sequence 2,000. The authenticated metadata response now includes `segments` and `manifestEncodedBytes`, computed from its current view. The local compaction regression checks eight segments becoming one, a smaller encoded view with the same sequence, and equality between reported UTF-8 bytes and the actual canonical R2 object's size. The default gate passed 22 Rust and 118 Worker/tooling tests. This is diagnostic evidence of a substantial acquisition payload, not isolated attribution of whole-query tails to that payload.

A temporary local probe folded the existing sixteen-bit-per-key Bloom into half as many bytes by OR-ing corresponding halves. The existing native membership reader accepted those bitsets, and all inserted keys remained positive in six fixtures. Each fixture used ten thousand absent probes. Original false positives ranged from three to eight; folded counts ranged from 96 to 161. Simple halving therefore substantially increases potential false-positive directory acquisition, and was not applied to canonical manifests.

A separate temporary Rust project resolved [xorf 0.13.0](https://github.com/ayazhafiz/xorf) with only its binary-fuse feature, using the same 64-bit input hash and a BinaryFuse8 filter. It compiled on native and wasm32-unknown-unknown targets. All inserted keys remained positive in the six fixtures. Serialized size includes the native descriptor and fingerprint bytes; the table reports absent-probe results from this synthetic local experiment.

|  Keys | Prefix    | Existing Bloom bytes | Binary Fuse bytes | Binary Fuse false positives / 10000 |
| ----: | :-------- | -------------------: | ----------------: | ----------------------------------: |
|   500 | document- |                 1000 |               788 |                                  38 |
|   500 | unique    |                 1000 |               788 |                                  41 |
|  5000 | document- |                10000 |              6676 |                                  40 |
|  5000 | unique    |                10000 |              6676 |                                  47 |
| 10000 | document- |                20000 |             12820 |                                  49 |
| 10000 | unique    |                20000 |             12820 |                                  39 |

For 5,000/10,000 keys this prototype reduced filter bytes by 33–36%, with 0.38–0.49% observed false positives. These native-Rust synthetic membership results are not a WASM timing proof, a projected deployed-manifest size guarantee, or a demonstrated end-to-end latency gain. The existing Bloom format, capacity, readers, canonical R2 objects and product dependencies remain unchanged. Safe corrupt-descriptor handling, actual corpus false-positive acquisition cost, bounded construction, and a single explicit migration must be resolved before changing a persisted filter representation. All prototypes and reports remain outside the public tree.

## Checked compact-filter codec prototype

The temporary BinaryFuse8 prototype now frames its native descriptor and fingerprint buffer with magic, key count and CRC. The first corruption regression exposed an unprotected key-count header; CRC coverage was corrected to include that header as well as the payload. Reads check minimum/maximum frame size, empty-filter framing, CRC, exact descriptor length, nonzero power-of-two segment length, its matching mask, positive segment-aligned count length, checked total fingerprint length and equality with the actual buffer. These geometry checks bound the native reader's three indices before creating its borrowed filter handle. The library's raw descriptor constructor does not provide this validation itself.

Four native release tests passed, including 10,000 arbitrary descriptor mutations with recomputed CRC, empty/single/small/large sets, truncation and corrupt framing. Actual WASM execution in Bun/V8 rejected all 804 truncations of the 500-key frame and eight invalid geometries with valid CRC, processed 10,000 arbitrary descriptors without a runtime trap, preserved all 500 inserted memberships, and remained usable afterward. This is bounded test coverage, not a proof over every possible malformed input or deployed workerd evidence.

A fair local WASM comparison calls the existing batched Bloom reader and the compact batched reader with the same 10,000 absent string probes. Both parse the input JSON, hash the strings and encode selected values; the compact reader validates framing/CRC once per batch. Ten warmup pairs precede one hundred alternating measured pairs. Frame bytes include the compact codec's sixteen-byte envelope, in addition to the native descriptor/fingerprints.

|  Keys | Prefix    | Bloom bytes | Compact frame bytes | Bloom p50 ms | Compact p50 ms | Bloom p95 ms | Compact p95 ms |
| ----: | :-------- | ----------: | ------------------: | -----------: | -------------: | -----------: | -------------: |
|   500 | document- |        1000 |                 804 |       1.4170 |         1.1031 |       1.6644 |         1.3432 |
|   500 | unique    |        1000 |                 804 |       1.3601 |         1.0418 |       2.0437 |         1.5314 |
|  5000 | document- |       10000 |                6692 |       1.4644 |         1.1504 |       1.8143 |         1.2981 |
|  5000 | unique    |       10000 |                6692 |       1.3765 |         1.0549 |       2.3328 |         1.4652 |
| 10000 | document- |       20000 |               12836 |       1.4264 |         1.1330 |       1.5343 |         1.1926 |
| 10000 | unique    |       20000 |               12836 |       1.3687 |         1.0672 |       2.3999 |         1.7878 |

The prototype improved local batched-query medians by 20–24% and retained the previously observed false-positive tradeoff. No inserted membership was lost. The product's Bloom implementation, dependencies, root format, readers and deployed data remain unchanged. The codec and all scratch tests/builds remain outside the tracked tree. A product adoption still requires a bounded constructor, batched multi-filter reader validation, an explicit one-step migration of canonical roots and pinned rebuild snapshots, native corpus acquisition-cost comparison, and independent live performance evidence. A smaller/faster synthetic membership filter does not by itself establish faster full search.

## Bounded compact-filter construction and copy conversion

The temporary constructor now rejects more than 250,000 input keys before allocating its hashed-key array. It sorts/deduplicates the 64-bit keys before native construction; a 10,000-element repeated-key input retained membership, and 250,001 inputs were rejected. A release binary with fifty-thousand, two-hundred-thousand and two-hundred-fifty-thousand key cases was measured independently of compilation. It sampled first/middle/last memberships for the large cases; earlier small-fixture tests still check every inserted membership.

|   Keys | Frame bytes | Native build ms |
| -----: | ----------: | --------------: |
|  50000 |       61476 |           17.00 |
| 200000 |      233508 |           66.11 |
| 250000 |      290852 |           81.10 |

The native process maximum RSS was 30,992 KiB across this sequential experiment, including input strings, allocator retention and process overhead. It is not a deployed Worker peak-memory measurement and does not prove the constructor fits alongside all production caches.

A local workerd-backed copy rehearsal seeded 2,000 documents in four segments, including vectors so an incomplete rebuild retained a pinned checkpoint. The test loaded immutable segment headers from R2, built document/term filters with the checked WASM codec, checked every inserted ID/term, and wrote converted root/checkpoint copies under a separate rehearsal prefix. It preserved canonical sequence and the checkpoint's ordered segment references. The copy's Schema-encoded root shrank from 12,408 to 10,280 bytes. Queries against the untouched original root remained identical. This does not validate querying a converted canonical root, cutover concurrency, migration resumption/CAS, expired or multiple checkpoints, or a real-data migration. No product dependency or persistent production format changed.

The proof leaves the actual adoption gate open: codec lookup must be integrated with batched filtering, construction must be checked in workerd under production memory pressure, and the single migration must update canonical and pinned views with retries that preserve concurrent committed writes and source identities. The copy rehearsal is preparation for that gate, not completion of it.

## Converted-filter queries in an isolated local Worker

A temporary copy of the engine integrated the checked compact codec with the existing build and batched membership entrypoints. Batched reads validate a filter once and reuse its borrowed native reader across prehashed candidates. No product source, dependency or deployed data changed. A separate Worker bundle used that WASM build; its fixture ran with native local workerd and persisted R2 storage.

The rehearsal seeded 2,000 documents across four segments, including 200 vector documents so an incomplete rebuild retained a checkpoint. It captured six query baselines covering any/all/phrase, attribute filtering, a rare term and a missing term. It converted the canonical local root and checkpoint filters from immutable headers, disposed the original runtime, and started the candidate runtime against the same persisted bucket. All six converted queries preserved complete rows/scores and sequence. The converted checkpoint resumed successfully and submitted another 100 vectors. Updating one document and deleting another through the candidate Worker succeeded; the obsolete term disappeared and the updated record was searchable.

The first program reached those operations but its report attempted to read an old R2 proxy after disposing that Miniflare runtime. That poisoned-stub error was corrected by retaining its scalar size before disposal, and the complete rehearsal was repeated successfully. The repeated fixture's manifest shrank from 12,642 to 10,514 encoded bytes. These are local operational checks of the converted reader and persisted fixture, not a production cutover, a resumed failed migration, or a native Cloudflare false-positive acquisition benchmark.

The adoption gate still requires a declared persisted representation/version, a single migration covering canonical and pinned views with bounded resumable work and CAS, source-identity preservation across concurrent writes, expiry/multiple-checkpoint cases, full strict lint/test integration, deployed memory evidence and same-corpus performance comparison. The temporary test bundle preserves the original public Root field shape for rehearsal only; it is not a compatibility strategy for the deliverable.

### Acquisition cost rejects the compact 8-bit filter

A separate local workerd comparison used 16,000 documents in 32 segments and 290 queries: 256 absent terms, 32 unique terms, a common-term query and an all-term query. All complete query results matched exactly after conversion. The manifest fell from 96,033 to 79,009 bytes, but term requests rose from 39 to 74 and range bytes from 807,719 to 5,125,686. The compact 8-bit filter is rejected: its higher false-positive rate increases acquisition cost in this workload. These are local fixture measurements, not production corpus measurements.

### Reusing Bloom positions within equal-sized batches

The Rust reader retains the existing Bloom bytes and hashes. It computes both hashes in one traversal and reuses the seven bit positions across consecutive equal-sized filters within a batch. The temporary position table is request-local and retains only one filter size. Empty filters and varying sizes retain their original behavior.

An alternating local WASM comparison used 64 filters, 64 values, 50 warmup pairs and 500 measured pairs per case. With equal-sized filters, median batch time improved by 27–50% for present values with short or Unicode prefixes and 42–49% for absent values. Variable-sized controls were approximately unchanged for short and Unicode prefixes. Every encoded filter and selected-value result matched the previous WASM. These local measurements include JSON and WASM boundary costs. Native measurements below assess Worker CPU and end-to-end behavior separately.

The native Cloudflare probe completed 208 successful executions, alternating variants over eight cases with 256 batch evaluations per execution. Tail-reported CPU was compared after three warmup pairs; fixture preparation was excluded (9–10 retained samples per variant/case). Equal-sized batches reduced median CPU by 36.4% for absent short values, 37.5% for absent Unicode values, 9.2% for present short values and 12.0% for present Unicode values. Variable-sized controls had unchanged short-value medians and 2.4–4.0% lower Unicode medians. All membership results matched exactly. The probe reads prepared in-memory filters, not R2.

The production deployment passed its Vectorize migration. Three native load runs against the owned million-document corpus completed 288 exact-result comparisons: baseline, first candidate and repeated candidate. At concurrency 1/4/16, baseline medians were 104.49/103.71/305.29 ms, first candidate medians 76.52/79.95/658.55 ms and repeated candidate medians 129.57/113.10/606.60 ms. End-to-end latency is mixed; these runs do not establish an overall latency improvement. The retained optimization has native kernel CPU evidence and unchanged persisted bytes, not a claim of Turbopuffer parity.

### Rejecting ineligible cached manifests before body decoding

Snapshot Cache API entries now carry validated observation-time and sequence headers. A missing/invalid header, age outside the original one-second contract or insufficient sequence discards the body before JSON decoding. Eligible bodies retain full Schema decoding and body-derived age/sequence validation. Tests cover expired and future headers, sequence barriers and fresh headers attached to an expired body.

A local workerd comparison seeded identical expired snapshot bodies of 5,243,635 characters in separate baseline/candidate Workers. Thirteen alternating pairs included three warmup pairs and ten measured samples per variant. Median request time fell from 31.90 to 24.37 ms (23.6%); maximum sample time fell from 49.06 to 46.22 ms. Every result remained exact. Each measured baseline decoded the expired body once; each candidate rejected it without decoding. This fixture isolates the rejection path and does not represent an ordinary corpus latency percentile. The full gate passed 22 Rust and 120 Bun/workerd tests.

The native production deployment and its Vectorize migration passed. Baseline, first candidate and repeated candidate load runs completed 288 exact-result comparisons on the owned million-document corpus. The first candidate observed 16 per-request header rejections and the repeated candidate observed 6, confirming this path executes in Cloudflare. At concurrency 1/4/16, baseline medians were 96.67/97.29/584.06 ms, first candidate medians 80.89/114.34/509.08 ms and repeated candidate medians 111.71/125.13/191.32 ms. End-to-end results remain mixed; the reliable evidence is eliminated decoding of ineligible cached bodies, exact ranking and the controlled local improvement.

### Conditional R2 revalidation of unchanged manifests

Warm snapshots retain the ETag supplied with their original R2 body. Native conditional gets reuse that decoded manifest only when R2 confirms the matching ETag without returning a body. The new timestamp is measured before the conditional request; unchanged content does not bypass the one-second age or minimum-sequence checks. Cache API rehydration does not establish an R2 ETag. Expired LRU entries remain bounded candidates for revalidation and cannot serve as fresh snapshots without canonical confirmation.

A local workerd comparison used identical canonical manifests of 5,243,589 bytes, eight alternating pairs and two warmup pairs. Each variant first populated its memory snapshot, waited 1,100 ms and evicted the Cache API entry. In all six measured pairs, the baseline read the complete body again and the candidate transferred zero body bytes, with exact query results. Median request time fell from 27.32 to 18.65 ms (31.7%); maximum samples were 53.96 and 51.13 ms. This small controlled sample measures revalidation, not ordinary corpus latency. The full gate passed 22 Rust and 121 Bun/workerd tests, including changed content, deletion, future sequence barriers and canonical corruption.

The native deployment passed its Vectorize migration. Baseline, first candidate and repeated candidate loads completed 288 exact-result comparisons against the owned million-document corpus. Foreground responses confirmed 10 conditional revalidations in the first candidate and 3 in the repeat. Four further native requests required sequence 2001 while the corpus remained at 2000; all four revalidated, fell back to the coordinator and returned 409. At concurrency 1/4/16, baseline medians were 76.55/94.14/319.56 ms, first candidate medians 141.70/241.48/490.18 ms and repeated candidate medians 129.44/94.51/262.88 ms. Overall latency remains mixed. The retained change has verified transfer savings and preserves sequence barriers; these runs do not prove a general latency improvement.

### Memory-only revalidation is rejected

A temporary Worker skipped Snapshot encoding and Cache API publication after an unchanged ETag, updating only its existing LRU entry. In six measured local workerd pairs with a 5 MiB manifest, median warm revalidation fell from 30.87 to 16.41 ms; every result matched and both variants transferred zero R2 body bytes. The shared-cache tradeoff prevents adoption. In a separate restart rehearsal, the published snapshot was 405 ms old after restarting the baseline Worker, while the candidate retained a 1,615 ms snapshot and rejected it before decoding. Cold query elapsed time was 55.24 versus 75.45 ms in that single comparison. Both variants also observed a full R2 body acquisition; the baseline can refresh in the background after selecting its eligible Cache API snapshot. These isolated measurements do not establish traffic-wide latency, but show why avoiding publication can penalize a cold reader. Production retains shared snapshot publication.

A local baseline with 40 equal-score documents in one segment returned the first ten IDs exactly and required 12 immutable range requests for 6,338 bytes. This fixture exposed request overhead despite a small payload and motivated the bounded acquisition described below.

### Bounded acquisition of contiguous result-document pages

Text results now use a Rust projection of byte ranges instead of complete header document records. Selected consecutive rows from the same segment may share a read bounded to four pages and 1 MiB. Each page is copied into its own charged memory-cache buffer and independently decoded/CRC checked. Nonconsecutive rows and partially cached batches keep individual reads; a query-local semaphore preserves four concurrent I/O operations. Result order, attributes, revisions and scores remain unchanged.

The final local workerd comparison used 80 documents per fixture, three query shapes, thirteen alternating pairs and three warmup pairs. All 78 complete results matched exactly. In each of the ten measured contiguous pairs, ranges fell from 12 to 5 while transferred range bytes stayed at 12,158. Median latency fell from 54.72 to 41.53 ms (24.1%). Sparse and descending-score controls retained 12 reads and identical byte counts; their medians changed from 45.04 to 46.24 ms and 42.44 to 43.70 ms. These small samples establish acquisition behavior, not general latency percentiles. The full gate passed 22 Rust and 123 Bun/workerd tests.

A native Cloudflare fixture confirmed five ranges for 12,158 bytes with exact results. After discarding process caches, a one-result query still returned the same row and score, using three ranges and two native Worker-cache hits. Individual-page reuse is proven in memory; merged shared-cache entries do not establish reuse of a smaller subrange. An experimental page publisher returned successful Cache API writes and immediate readback but failed to demonstrate a later native page hit. It was removed rather than retaining extra publication calls with unproven benefit. All native fixture documents were deleted through their owning namespace; canonical retention and collection rules still govern historical artifacts.

The retained deployment passed its Vectorize migration. Baseline, final candidate and repeated final candidate loads completed 288 exact-result comparisons on the owned million-document corpus. At concurrency 1/4/16, baseline medians were 68.93/70.93/221.61 ms, final candidate medians 80.81/91.99/179.58 ms and repeated medians 114.18/96.85/435.40 ms. These mixed runs do not prove an overall latency improvement. The retained evidence is lower acquisition request count for contiguous pages, unchanged range bytes and exact ranking across local/native checks.

### Native CPU attribution and request-level load observations

Alchemy's native `logs --tail` was used against the Search resource while a 96-request concurrent load retained every strong-baseline result. The captured query events numbered 65, with median CPU 92 ms and maximum CPU 1,145 ms; median event wall time was 467 ms and maximum 1,829 ms. Capture coverage is partial and does not support population percentiles. Tail accounting can include background work, so these durations are not interchangeable with client response latency or the elapsed Server-Timing phases.

A further sequential series ran sixteen requests for each of the four query cases and preserved all 64 results. Only 19 query events fell within the measured case windows; this is insufficient to rank cases reliably by CPU. The tail session was closed after measurement. No runtime optimization is justified solely by these partial correlations.

`tooling/load.ts` now preserves each request's case index, client start/end timestamps, Cloudflare ray ID and Server-Timing alongside its measured latency. Existing aggregate samples/timings remain available. The changed driver completed 48 native exact-result comparisons across concurrency 1/4/16; every observation carried a ray ID, coherent timestamps and the expected case index. These records support correlation with provider telemetry without adding application debug paths. The full local gate passed 22 Rust and 123 Bun/workerd tests.

### Isolated snapshot serialization CPU

A separate synthetic manifest used 200 segment records and encoded to 5,374,752 UTF-8 bytes. The candidate frame writes a small timestamp/sequence envelope ahead of retained manifest bytes; canonical R2 JSON is unaffected. A local alternating comparison included ten warmup pairs and fifty measured pairs. Complete construction/body materialization fell from median 5.92 to 1.52 ms, with an exact decoded roundtrip. Construction-only medians were 4.11 and 0.74 ms.

A temporary native Worker performed sixteen complete constructions/materializations per execution. Interactive tail coverage was incomplete, so an authenticated Tail Worker persisted sanitized per-execution CPU receipts to an owned temporary R2 bucket. All 46 receipts were recovered. After excluding three warmup pairs, twenty samples per variant remained: median CPU per construction was 39.41 ms for the JSON Snapshot and 24.28 ms for the retained-byte frame (38.4% lower); p95 values were 50.88 and 32.38 ms. Every execution completed successfully. These are isolated synthetic codec measurements, not query latency, Cache API publication, memory-limit proof or native frame-decoding validation. Both temporary Workers and their bucket were destroyed successfully. The integrated frame described below adds version identification, bounded metadata and cache-reader validation; the isolated CPU result is not a measurement of that complete query path.

The preceding load-observation commit's CI reached the vector rebuild recovery integration test but exceeded Bun's implicit five-second test budget. Its isolated local run completed in 1.35 seconds with all nine assertions. The test now has an explicit fifteen-second integration deadline, preserving the provider-failure, cursor-resumption and intervening mutation checks. This changes the harness budget, not a runtime performance guarantee.

### Retained manifest bytes in shared snapshots

The Worker now publishes a versioned binary snapshot frame, reusing manifest bytes when a native conditional R2 read confirms an unchanged ETag. The R2 Root remains version 1. Cache readers reject truncation, invalid magic, invalid metadata lengths and mismatched sequences, while retaining the existing body age and minimum-sequence checks. An invalid cache body recovers through canonical R2. The new Cache API namespace replaces the JSON snapshot namespace in one cutover. Retained backing buffers are charged within the 24 MiB snapshot LRU; charge counters are not a total peak-heap measurement.

A controlled local workerd comparison used eight alternating pairs with a 5 MiB canonical manifest, excluding two warmup pairs. Both variants revalidated the same ETag and transferred zero R2 body bytes after expiry and Cache API eviction. Median complete query time fell from 22.36 to 13.57 ms (39.3%); maxima were 26.08 and 23.72 ms. All twelve measured results matched. This isolates warm revalidation and shared publication, not ordinary corpus percentiles.

The full local gate passed 22 Rust and 126 Bun/workerd tests, with 1,364 Bun assertions. Native Alchemy deployment and the Vectorize migration completed successfully. An observed production isolate decoded two shared snapshot frames and retained a 5,448,863-byte manifest payload with 21,795,676 charged snapshot bytes. Four queries requesting uncommitted sequence 2001 against canonical sequence 2000 returned 409 with coordinator fallback; three also confirmed native unchanged-ETag revalidation.

Baseline, first candidate and repeated candidate runs completed 288 exact-result comparisons on the million-document corpus. Each run used 32 requests at each concurrency and compared rows, scores and sequence with its strong baseline. Values below are client milliseconds; cache warmth, isolate placement and network conditions were uncontrolled.

| Concurrency | Baseline p50 / p95 | Candidate p50 / p95 | Repeated candidate p50 / p95 |
| ----------- | ------------------ | ------------------- | ---------------------------- |
| 1           | 76.09 / 812.59     | 70.98 / 305.77      | 137.06 / 406.26              |
| 4           | 86.16 / 1311.62    | 77.17 / 1240.70     | 108.29 / 531.86              |
| 16          | 308.16 / 1775.63   | 310.77 / 1745.65    | 242.35 / 1159.89             |

The candidate runs observed ten request-local unchanged-ETag markers. The measurements preserve exact ranking and demonstrate the new native cache path, but remain mixed for median latency and do not establish Turbopuffer parity or a traffic-wide speedup.

### Monotonic block-bound cursors in Rust

After filling text top-k, the scorer previously scanned a term's block-bound list from its beginning for each candidate. The scorer now retains one query-local bound cursor per term and searches its remaining suffix only when the posting row leaves the current block. Segment parsing validates strictly ordered, nonoverlapping block row intervals. Score arithmetic, term accumulation order, pruning tolerance and tie order are unchanged; the segment wire format remains version 1.

A local Bun/WASM differential comparison covered 54 fixtures: 128/2,048/10,000 documents, three posting-density patterns, any/all/phrase and filters on/off. Fifteen alternating pairs ran 64 finishes each, excluding three warmup pairs for timing. All 103,680 repeated ranking results matched the previous engine's serialized rows and scores exactly. A further 18-fixture repetition at 10,000 documents ran after the local test gate finished and preserved another 34,560 results.

In that repetition, unfiltered any medians fell by 39.9–44.5% and filtered any by 63.5–69.8%. Dense all and phrase medians fell by 37.4–46.0%; sparse nonempty intersections improved by 28.2–31.4%. Nearly empty filtered intersection controls changed by -3.6% to +5.2%, below one microsecond in absolute median difference. One disjoint phrase control changed by +1.2% (0.3523 to 0.3565 ms). These are isolated local ranking timings, not native CPU or client-query percentiles. A binary-search-only precursor regressed sparse any and was replaced before deployment. In the broader run, single-block fixtures changed by -1.2% to +7.2%, with median change +1.5%; 2,048-document fixtures had median change -7.1%. That broader run overlapped the local check and is weaker timing evidence than the isolated repetition.

The full gate passed 23 Rust and 126 Bun/workerd tests. A new corrupt-header test recomputes the CRC after reordering or overlapping block intervals and verifies explicit rejection. Existing exhaustive scoring, exact tie, phrase, tombstone and concurrent workerd coverage passed.

Native Alchemy deployment and its Vectorize metadata migration succeeded. The million-document before/after/repeated load retained all 288 exact-result comparisons, including scores and sequence. Client latency remains mixed: the first candidate improved medians at all three concurrencies but worsened p95 at concurrency 4/16; the repetition improved concurrency 1/4 medians and worsened concurrency 16 median. Cache warmth, isolate placement and network conditions were uncontrolled. These runs do not prove a general end-to-end speedup or Turbopuffer parity.

| Concurrency | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Repeated candidate p50 / p95 ms |
| ----------- | --------------------- | ---------------------- | ------------------------------- |
| 1           | 134.59 / 429.60       | 99.52 / 437.53         | 66.07 / 147.49                  |
| 4           | 94.21 / 334.02        | 84.38 / 1081.87        | 71.82 / 827.70                  |
| 16          | 214.79 / 962.64       | 182.96 / 2037.30       | 294.33 / 958.46                 |

A separate post-deploy all/phrase load completed 96 further exact-result comparisons at concurrency 1/4/16. Its p50 values were 84.17/105.53/428.99 ms and p95 values 226.13/978.30/1441.83 ms. This validates native intersection/phrase behavior after the cursor change; it has no paired pre-change timing baseline.

### Eligible posting acquisition and decode

Rust now projects posting spans from the ranker's existing filter/tombstone mask before Worker acquisition. A block is omitted only when every row in its interval is excluded. This may retain blocks containing gaps in their actual postings, but cannot discard an eligible match. Complete immutable catalogs still own live global document frequencies and score bounds. Selected pages retain their independent CRC/position checks; score arithmetic and term order are unchanged.

An initial implementation split at every excluded block. On a 1,000-document workerd fixture with two eligible intervals, this saved only 1,041 total acquired bytes while increasing range reads from 13 to 15; median query time worsened from 48.03 to 54.53 ms. That version was rejected. The retained implementation bridges individual excluded gaps up to 4 KiB, decodes only selected pages and splits at larger gaps. The Worker validates gap, order and total span limits before fetching.

Nine alternating local workerd pairs per pattern included three warmups and six measured samples per variant. All 72 complete query results matched. Unfiltered and interleaved fixtures retained the same reads/bytes. The clustered fixture retained 13 reads and 147,713 bytes, with medians 50.97 to 49.29 ms; its p95 worsened from 57.72 to 79.12 ms. The interleaved median worsened from 50.12 to 52.84 ms. Tombstones retained 12 reads but cut bytes from 2,436 to 1,232, with medians 39.51 to 38.42 ms. The small local samples are mixed, not a traffic-wide latency claim.

A separate local Bun/WASM comparison measured projection, ranker creation, posting decoding and finishing together on 10,000-document fixtures. Twelve cases covered unfiltered/clustered/interleaved/tombstoned data and any/all/phrase. Fifteen alternating pairs ran sixteen complete pipelines each, with three warmups excluded from timing; all 5,760 outputs matched serialized rows and scores. Clustered filtering reduced decoded pages from 158 to 6 and median pipeline time by 95.7–96.0%; tombstones reduced pages to 4 and medians by 90.4–90.8%. Unfiltered/interleaved controls retained 158 pages and improved by 3.8–6.8%. Decoded page bytes are not necessarily transferred bytes because short excluded gaps remain in acquired spans. These are local pipeline timings, not native CPU receipts.

The final gate passed 25 Rust and 126 Bun/workerd tests, including full-versus-selected any/all/phrase results across excluded intervals, tombstones and the 4,096/4,097-byte gap boundary. Native deployment and its Vectorize metadata migration succeeded. Three strong queries on the same owned 1,000-document fixture preserved the pre-deploy rows, scores and sequence. The first post-deploy query reused a cached immutable header, so its 2,435 acquired bytes cannot be compared with the pre-deploy cold 147,713 bytes as a pruning gain. All fixture documents were deleted through the owning write operation and metadata confirmed zero live documents; normal R2 history retention still applies.

The million-document before/after/repeated load retained 288 exact-result comparisons. A separate post-deploy all/phrase load retained another 96, with p50 83.60/87.69/374.28 ms at concurrency 1/4/16. The ordinary workload below still has mixed client latency and does not establish native CPU savings, a general speedup or Turbopuffer parity. Cache/isolate/network conditions were uncontrolled.

| Concurrency | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Repeated candidate p50 / p95 ms |
| ----------- | --------------------- | ---------------------- | ------------------------------- |
| 1           | 81.22 / 167.03        | 71.05 / 480.54         | 81.10 / 249.57                  |
| 4           | 98.29 / 848.86        | 76.19 / 1274.24        | 108.13 / 917.43                 |
| 16          | 397.77 / 1635.68      | 182.45 / 1261.73       | 236.20 / 999.20                 |

### Materializing adjacent pages in ranking order

The bounded document reader now sorts at most four page references to determine physical contiguity, then decodes and returns documents in the original requested order. Text batches accept consecutive physical rows in any ranking order. Vector materialization uses the same bounded reader while preserving provider order and scores. Sparse/mixed-segment windows remain individual acquisitions; partly cached or oversized spans retain the existing fallback. One query-local semaphore bounds materialization to four I/O operations.

A local workerd comparison covered contiguous, sparse and reverse-ranked fixtures with 80 documents. Thirteen alternating pairs per shape included three warmups and ten measured samples; all 78 complete query results matched rows and scores exactly. The isolated repetition retained 5 reads/12,158 bytes for contiguous results and 12 reads/12,158 bytes for sparse results. Reverse ranking fell from 12 to 5 reads while retaining 12,401 bytes; median query time fell from 42.17 to 22.74 ms (46.1%). Contiguous medians were 24.84 to 23.98 ms and sparse medians 44.25 to 44.79 ms. These are controlled local timings, not native population percentiles.

The full gate passed 25 Rust and 128 Bun/workerd tests. New workerd tests verify reverse text order, single-result cache reuse and vector provider score order while materializing ten vector results in three page reads. Existing sparse, partial-cache, eviction, corrupt-page, stale-vector and residual-filter checks passed.

Native Alchemy deployment and the Vectorize metadata migration succeeded. An owned 80-document fixture established actual Vectorize visibility, then cleared only its process caches before each pre/post-deploy query. Text, vector and hybrid responses preserved rows, scores and canonical sequence exactly. Native range acquisitions fell from 12 to 5 for text (12,672 bytes both), 11 to 4 for vector (12,356 bytes both), and 18 to 6 for hybrid (24,418 to 23,806 bytes). Single-query client times were 275.76 to 470.30 ms, 332.18 to 1,024.31 ms and 201.80 to 206.26 ms respectively. These small measurements confirm acquisition and correctness, while explicitly failing to demonstrate lower client latency. The fixture's documents were deleted, vector deletion submission drained, and metadata confirmed zero live documents and zero pending vector jobs. This does not independently prove asynchronous provider deletion visibility or remove retained canonical history.

The million-document before/after/repeated load retained all 288 strong-baseline result/score/sequence comparisons. Client latency remains mixed: the first candidate worsened concurrency 1/4 medians, the repetition improved concurrency 4/16 medians, and concurrency 16 p95 worsened in both candidate runs. Cache/isolate/network conditions were uncontrolled. Acquisition reduction and the controlled local reverse-order result do not establish a traffic-wide latency improvement or Turbopuffer parity.

| Concurrency | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Repeated candidate p50 / p95 ms |
| ----------- | --------------------- | ---------------------- | ------------------------------- |
| 1           | 74.01 / 122.12        | 100.87 / 470.88        | 75.19 / 146.19                  |
| 4           | 78.60 / 1087.62       | 89.48 / 1142.58        | 67.92 / 273.19                  |
| 16          | 324.58 / 1160.45      | 146.43 / 1294.95       | 173.10 / 1378.46                |

### Sharing pending immutable range bodies

Native Workers Cache collapses cache acquisition, but separate process calls to the range boundary could still each consume the same returned body. A direct cold workerd fixture demonstrated 32 simultaneous callers of one 1 MiB interval consuming 32 bodies/32 MiB. The range boundary now shares only its pending native acquisition by physical bucket, immutable key, offset and length. The owning call consumes and validates the body before resolving bytes. Success/failure remove the promise; the map tracks at most 64 acquisitions and bypasses tracking at capacity. Existing immutable LRU behavior remains unchanged.

Fifteen alternating pairs at one and 32 consumers included three warmups and twelve measured samples per variant. Every caller returned the expected length. At 32 consumers, response-body acquisitions fell from 32 to 1 and consumed bytes from 33,554,432 to 1,048,576; median complete local request time fell from 51.63 to 3.04 ms. At one consumer, both retained one body and medians were 4.29 and 3.46 ms. These are local boundary timings. Consumed response bytes do not establish R2 origin transfer or native billed CPU, because native cache collapsing may already avoid duplicate origin fetches.

The full gate passed 25 Rust and 130 Bun/workerd tests. A separate workerd fixture checks that 32 callers receive one decoded byte-buffer identity, and that eight callers of a missing object share one failed acquisition before a canonical retry succeeds. Existing concurrent query, directory lifetime, immutable cache isolation and ranking checks passed. The fixture runs in its own generated temporary bundle and never adds a public application route.

Native Alchemy deployment and its Vectorize metadata migration succeeded. Baseline, first candidate and repeated candidate loads retained 288 exact-result/score/sequence comparisons on the million-document corpus at concurrency 1/4/16. The repeated candidate improved concurrency 4 median/p95 but worsened concurrency 1 median/p95 and concurrency 16 median. Cache/isolate/network conditions were uncontrolled. This proves native concurrent query behavior, not the isolated 32-consumer timing, native peak heap or a general latency improvement.

| Concurrency | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Repeated candidate p50 / p95 ms |
| ----------- | --------------------- | ---------------------- | ------------------------------- |
| 1           | 103.44 / 409.22       | 95.92 / 526.06         | 115.88 / 687.58                 |
| 4           | 114.34 / 912.33       | 100.35 / 853.64        | 90.82 / 427.38                  |
| 16          | 169.13 / 1184.05      | 166.43 / 1231.61       | 193.69 / 1116.75                |

### Rejected individual-page Cache API probe

A temporary candidate checked up to four private individual-page Cache API entries before acquiring a cold merged document span. Complete hits decoded/CRC-checked pages in result order; partial hits and cache errors fell back to the existing merged acquisition. Memory-resident pages and merged buffers bypassed the probe. Canonical R2 format and query contracts were unaffected.

A local workerd comparison used four cache states with 40 documents and eleven alternating pairs per state, excluding three warmups. All 88 complete query results preserved rows and scores. With every individual page present, range acquisitions fell from 5 to 2 and medians from 23.11 to 21.81 ms. Empty-cache medians worsened from 29.80 to 38.06 ms, partial-cache medians from 19.94 to 30.46 ms and an already cached merged span from 9.91 to 25.26 ms; these controls retained the same acquired ranges/bytes. Direct lookup overhead outweighed the narrow benefit. The prototype's 25 Rust and 130 Bun/workerd tests passed, but it was removed before any native deployment. Production retains direct merged acquisition and the existing individual memory-cache fallback. The measurements do not establish native Cache API namespace visibility or origin-transfer savings.

### Removing a temporary allocation from posting decoding

Rust previously allocated a temporary vector of positional vectors for every posting, then popped body/title fields. The decoder now reads title and body directly through one checked positional-field decoder. Posting order, score arithmetic, CRC/decoded-length validation and the persisted segment format are unchanged.

A local Bun/WASM comparison measured projection, ranker creation, decoding and finishing on 10,000-document fixtures. Twelve cases covered unfiltered/clustered/interleaved/tombstoned data and any/all/phrase. Fifteen alternating pairs ran sixteen complete pipelines each, with three warmups excluded from timing. The first comparison and isolated repetition preserved all 11,520 serialized row/score outputs. In the repetition, unfiltered medians improved 3.7–6.3%, clustered filters 6.1–6.7%, interleaved filters 4.5–4.9% and tombstones 2.9–3.3%. These are local pipeline timings, not native CPU or client latency measurements.

The full gate passed 26 Rust and 130 Bun/workerd tests. A new decoder test frames malformed positional data with a valid CRC and checks duplicate title/body positions, empty postings, invalid counts, truncated/overflowing varints, cumulative position overflow, trailing bytes, duplicate rows and excessive row count. Existing exhaustive ranking, phrases, tombstones and concurrent cache tests passed.

Native Alchemy deployment and its Vectorize metadata migration succeeded. The million-document before/after/repeated load preserved all 288 exact-result/score/sequence comparisons. Client latency remains mixed: the first candidate improved concurrency 1/16 medians but worsened all p95 values, while the repetition worsened concurrency 1/4 medians and improved concurrency 16 median. Cache/isolate/network conditions were uncontrolled. The local allocation/pipeline result does not establish native billed CPU, peak memory or a traffic-wide latency gain.

| Concurrency | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Repeated candidate p50 / p95 ms |
| ----------- | --------------------- | ---------------------- | ------------------------------- |
| 1           | 72.59 / 299.87        | 68.88 / 380.68         | 99.22 / 734.14                  |
| 4           | 76.14 / 801.14        | 84.18 / 1320.56        | 110.96 / 464.95                 |
| 16          | 185.91 / 1145.02      | 116.86 / 2250.96       | 177.22 / 1087.18                |

A separate post-deploy all/phrase load retained another 96 exact-result comparisons at concurrency 1/4/16. Its p50 values were 117.33/115.00/179.04 ms and p95 values 206.09/1191.83/1401.90 ms. This validates native phrase/intersection behavior after the decoder change, without a paired pre-change timing baseline.

### Compact frequency lists for any/all

Any/all queries previously retained every token-position vector after decoding, although scoring needed only title/body frequencies. Rust now stores a 12-byte row/title-count/body-count record per posting for these modes. Phrase queries retain their complete positional representation. A shared checked decoder still scans every positional varint, rejects malformed counts/duplicates/overflow/trailing bytes and validates last positions against header document lengths. CRC and decompression limits remain unchanged. The cursor/scoring implementation is monomorphized for both representations, without dynamic dispatch or score-arithmetic changes. The persisted segment/HTTP formats are unchanged; the Rust `Search.lists` implementation field is now private.

Two local Bun/WASM comparisons each covered twelve 10,000-document cases: unfiltered/clustered/interleaved/tombstoned data and any/all/phrase. Fifteen alternating pairs ran sixteen projection/decode/ranking pipelines each, excluding three warmups from timing. All 11,520 serialized row/score outputs matched. In the isolated repetition, unfiltered any/all medians improved 19.8–22.9% and interleaved any/all 22.1–22.4%. Clustered any/all improved 4.2–4.6%, tombstoned any/all 2.1–3.1%, and phrase controls 1.2–3.8%. These are local pipeline timings, not native CPU or traffic-wide latency measurements.

The full gate covers low/high token frequency, filters, tombstones and exact score equality against positional lists. Retained list/vector capacity is less than half the positional reference in the low-frequency fixture and less than one tenth in the high-frequency fixture. This counts Rust container capacities, excluding allocator overhead, directories, JavaScript values and other caches; it is not a Worker peak-memory proof. Malformed posting fixtures run through both decoder variants and preserve their declared errors. Position/doc-length mismatch rejection is checked in all three match modes.

The full local gate passed 28 Rust and 130 Bun/workerd tests. Native Alchemy deployment and its Vectorize metadata migration succeeded. Baseline, first candidate and repeated candidate loads preserved 288 exact-result/score/sequence comparisons on the million-document corpus. A separate post-deploy all/phrase load retained another 96 results, with p50 83.77/123.00/351.23 ms at concurrency 1/4/16. Client latency remains mixed: the first candidate worsened all medians, while the repetition improved concurrency 1/4 medians and worsened concurrency 16 median. Cache/isolate/network conditions were uncontrolled. The local throughput/capacity result does not establish native CPU savings, Worker peak heap or Turbopuffer parity.

| Concurrency | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Repeated candidate p50 / p95 ms |
| ----------- | --------------------- | ---------------------- | ------------------------------- |
| 1           | 74.44 / 295.67        | 77.61 / 250.15         | 68.70 / 176.05                  |
| 4           | 78.49 / 859.15        | 85.36 / 1036.65        | 74.58 / 463.37                  |
| 16          | 222.59 / 1116.62      | 316.44 / 1345.81       | 359.61 / 1186.33                |

The original SciFact archive matched its recorded SHA-256. Both the prior positional engine and the compact engine ran all 300 judged queries over 5,183 documents through local workerd/R2. Complete report bytes, per-query identifiers and metrics were identical. Independent metric recomputation agreed within 1e-12: NDCG@10 0.6730619695232347, Recall@10 0.7956666666666666 and MRR@10 0.641808201058201. This is a local scientific-retrieval regression gate, not native ranking-quality or vector-recall proof.

### Discarding excluded postings after validation

The ranker now validates every decoded posting before retaining only rows allowed by filters/tombstones. It separately tracks the last decoded row per requested term, so an excluded final row cannot hide an overlapping or reversed next block. CRC, varints, document-position bounds and ordering checks still apply to discarded data. Full term catalogs continue to supply global document frequencies and conservative bounds. Physical acquisition and persisted formats are unchanged.

Two local Bun/WASM comparisons each covered twelve 10,000-document cases with unfiltered/clustered/interleaved/tombstoned any/all/phrase. Fifteen alternating pairs ran sixteen pipelines each, with three warmups excluded from timing; all 11,520 serialized row/score outputs matched. In the isolated repetition, interleaved any/all/phrase medians improved 7.5/2.6/6.7%; clustered any/all improved 6.9/2.3%; tombstoned any/all improved 4.0/4.8%. Unfiltered any changed +0.7%, all -0.8%, and phrase -12.1%; the first run's unfiltered phrase change was -6.1%, showing timing variability. These are local pipeline measurements, not native CPU or broad latency guarantees.

The full gate passed 30 Rust and 130 Bun/workerd tests. A direct all-mode comparison retained 58 eligible postings versus a 512-posting full-list reference, preserving every score and the last-decoded-row map. Separate tests verify that an entirely excluded block still establishes order for the next block and still rejects out-of-document positions. This demonstrates reduced list retention in that fixture, not total Worker peak memory.

Native Alchemy deployment and its Vectorize metadata migration succeeded. The million-document baseline/first-candidate/repeated-candidate load retained all 288 exact-result/score/sequence comparisons. A post-deploy all/phrase load retained another 96 results, with p50 92.17/122.73/340.42 ms and p95 274.40/677.76/2237.78 ms at concurrency 1/4/16. Native client tails worsened in the ordinary candidate loads, despite smaller retained lists and controlled local improvements. Cache/isolate/network conditions were uncontrolled; this is not a native latency improvement claim.

| Concurrency | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Repeated candidate p50 / p95 ms |
| ----------- | --------------------- | ---------------------- | ------------------------------- |
| 1           | 75.92 / 327.77        | 75.36 / 435.47         | 71.34 / 127.84                  |
| 4           | 214.67 / 1306.71      | 72.48 / 1801.39        | 85.32 / 968.52                  |
| 16          | 296.74 / 1278.82      | 319.72 / 3615.63       | 303.44 / 2523.25                |

Worst concurrency-16 candidate requests reported text_rank intervals around 2.7–3.6 seconds. That phase includes posting acquisition and elapsed asynchronous scheduling; it is not a pure Rust CPU measurement. Native clocks freeze during uninterrupted CPU work, so zero-valued median phases cannot establish absence of work. These observations leave acquisition/tail attribution unresolved.

The complete 300-query SciFact evaluation was repeated over the verified original dataset. Its full report was byte-identical to the preceding compact-frequency evaluation, retaining every returned identifier and metric. This preserves the local retrieval-quality gate; native quality, peak Worker memory and Turbopuffer parity remain unproven.

### Request-local posting phase attribution

Server-Timing now separates directory/ranker preparation, posting acquisition windows, Rust block decoding and scorer finalization while retaining text_rank as the enclosing phase. Descriptions report logical spans/bytes, decoded blocks and scored segments. These counts include memory/shared reuse and do not equal R2 origin requests or transfer. The values are elapsed native-clock intervals; uninterrupted CPU can produce zero durations and remains attributable only through provider CPU telemetry or controlled CPU experiments.

The full gate passed 30 Rust and 131 Bun/workerd tests, including twelve concurrent edge queries with independent one/two-term counts. Native deployment and its Vectorize metadata migration succeeded. An initial 96-response exact-result load exposed unaccounted text_rank intervals, prompting the added preparation interval. A second 96-response load preserved rows/scores/sequence and returned all four metrics in every response.

Among the second run's slowest observations, preparation ranged from 64 to 483 ms and posting acquisition from 50 to 137 ms. A common-term request reported 604 ms in text_rank: 483 ms preparation and 121 ms posting acquisition, while decode/scoring clocks stayed zero. Five slow concurrency-16 responses reported snapshot-selection intervals of 1,059–1,225 ms. Selection elapsed includes work before canonical observation and is not equivalent to snapshot age. These observations direct further investigation toward directory/ranker preparation, posting acquisition and snapshot selection; they do not show that Rust consumes no CPU. Native client p95 at concurrency 1/4/16 was 1,594.57/1,708.51/2,139.34 ms in the second run. This instrumentation is diagnostic evidence, not a latency optimization or Turbopuffer parity claim.

### Mixed catalog acquisition experiment

A rejected prototype overlapped the three independent missing-catalog classes within each sixteen-segment window, using one query-local semaphore to retain the existing ceiling of eight in-flight acquisitions. A three-segment fixture exercises dictionary-only, filter-minimum-only and complete misses together. The retained regression verifies three acquisitions, correct eligible IDs, exact warm-cache results and no repeated catalog requests.

Two local workerd comparisons used twenty alternating baseline/candidate pairs each, excluding the first four pairs from medians. All eighty measured queries preserved complete rows and scores. Baseline/candidate medians were 21.66/20.85 ms in the first comparison and 18.92/20.08 ms in the repetition. The initial 3.7% improvement reversed into a 6.1% regression. The prototype was removed before deployment; this experiment does not establish a native latency improvement. The final full gate passed 30 Rust and 132 Bun/workerd tests. Request-local preparation/posting timing remains the guide for further acquisition work.

### Validated selective attribute decoding

New filter masks previously materialized every attribute value into a complete map before evaluating the filter. They now retain only named fields. Overview projections with up to eight named fields reuse this reader. Unused values traverse a validating serde visitor without building value trees. Numeric overflow, invalid Unicode, nested structure, trailing data and recursion limits remain rejected; duplicate-key behavior remains equivalent to the complete-map parser. Existing filter-mask admission, tombstone handling, persisted bytes and scoring arithmetic are unchanged.

Two local WASM comparisons used three 1,000-document fixtures, twenty distinct filter values, ten alternating baseline/candidate pairs and two excluded warmup pairs. Cycling twenty values exceeds the sixteen-entry filter-mask cache, so preparation measures new masks. The repeated comparison reports per-filter medians below. Preparation includes ranker construction and a cached minimum lookup; overview measurement includes framing/decompression and projection.

| Attributes                 | Preparation before ms | Preparation after ms | Overview before ms | Overview after ms |
| :------------------------- | --------------------: | -------------------: | -----------------: | ----------------: |
| One field                  |                 0.364 |                0.347 |              0.053 |             0.060 |
| Forty unused string fields |                15.089 |                5.479 |              0.356 |             0.307 |
| Forty unused nested fields |                48.919 |               22.936 |              1.053 |             0.708 |

Preparation improved 63.7% for unused strings and 53.1% for unused nested values in the repetition. The first comparison showed 62.6% and 56.4% improvements. The one-field overview control varied by approximately six microseconds and does not establish a speedup. The nested fixture exercises the Rust JSON reader; public HTTP attributes remain scalar values. Full baseline/candidate ranking returned 1,200 identical rows/scores across the three fixtures. The full gate passed 31 Rust and 132 Bun/workerd tests, including differential validation against complete-map decoding. This is evidence for selective decoding with large unused attributes, not a whole-query latency, provider CPU, peak-memory or Turbopuffer parity claim.

Native deployment and the Vectorize metadata migration succeeded. A public-contract fixture used one hundred documents with forty unused scalar string fields. Twelve native queries covered any/all/phrase with eq, gte, in and missing-field exists filters; all 120 returned IDs/scores were identical to the previous WASM engine. Cleanup acknowledged deletion and metadata confirmed zero live documents. Canonical retention remains unchanged.

Three million-document edge loads completed 288 exact strong-baseline comparisons at the same acknowledged sequence. Client p50/p95 observations were:

| Run            | Concurrency | p50 ms |  p95 ms |
| :------------- | ----------: | -----: | ------: |
| Before         |           1 | 105.10 |  198.89 |
| Before         |           4 |  97.17 |  940.94 |
| Before         |          16 | 283.72 | 1129.22 |
| After          |           1 |  80.37 |  820.60 |
| After          |           4 |  76.67 | 1145.48 |
| After          |          16 | 967.61 | 2090.13 |
| Repeated after |           1 |  78.20 |  221.17 |
| Repeated after |           4 |  81.44 |  304.39 |
| Repeated after |          16 | 339.15 | 1449.17 |

These whole-query observations remain mixed, especially at concurrency sixteen. The first after-deploy load's slow requests included snapshot fallback/selection and preparation waits; native clocks do not isolate CPU. The repeated load ran after fixture cleanup. The controlled WASM gain applies to new filters with large unused attributes; native peak-memory and stable whole-query latency remain outstanding.

### Shared Cache API snapshot acquisition

R2 snapshot acquisition was already shared, but simultaneous callers could independently match and decode the same Cache API frame. Pending-only sharing now covers the cache lookup, body consumption and decoded frame, keyed by physical bucket/namespace and minimumSequence. Admission is capped at 64 pending identities, with independent acquisition above the cap. Completion/failure removes the entry. Every caller still enforces the original one-second age and its sequence barrier after acquisition; incompatible barriers do not share cached-body admission. Memory TTL, cache format, R2 ownership and strong reads are unchanged.

Two local workerd comparisons used sixteen simultaneous queries, ten alternating baseline/candidate pairs per state and two excluded warmup pairs. States were a small frame, a roughly 5 MiB frame and a cache miss. The large fixture pads a valid all-positive document Bloom in an otherwise canonical one-document root; it is synthetic acquisition evidence. Each comparison completed 960 queries. The repetition compared complete returned rows/scores across both versions.

| State              | First baseline/candidate median ms | Repeated baseline/candidate median ms |
| :----------------- | ---------------------------------: | ------------------------------------: |
| Small cached frame |                      63.81 / 59.16 |                         56.76 / 58.74 |
| Large cached frame |                      76.47 / 63.31 |                         58.57 / 64.00 |
| Cache miss         |                      55.35 / 55.57 |                         52.44 / 57.40 |

Large-frame decode counts across eight measured batches fell from 26 to 8 in the first run and 11 to 8 in the repetition. The previous path decoded up to seven copies in a batch; the shared path decoded one in every batch. The gain is eliminated duplicate work, not a consistent median latency improvement: when the baseline rarely duplicated decoding, candidate medians were worse. Decoded input volume is not origin transfer, provider CPU or peak-memory proof. The full gate passed 31 Rust and 133 Bun/workerd tests, including overlapping cached reads with independent future sequence barriers. Existing expired/future headers, stale bodies, malformed frames, canonical recovery and authentication tests remain active.

Native deployment and the Vectorize metadata migration succeeded. Before/after/repeated edge loads on the million-document corpus completed 288 exact strong-baseline comparisons at sequence 2,000. Four future barriers requesting sequence 2,001 returned 409 through canonical fallback. A native health observation retained 5,448,863 payload bytes under a 21,795,676-byte snapshot charge, within the unchanged 24 MiB charged limit; this is not actual peak-heap telemetry.

| Run            | Concurrency | p50 ms |  p95 ms |
| :------------- | ----------: | -----: | ------: |
| Before         |           1 |  80.58 |  746.28 |
| Before         |           4 |  83.93 | 1175.20 |
| Before         |          16 | 298.75 | 1105.47 |
| After          |           1 |  71.61 |  533.47 |
| After          |           4 | 118.49 | 1367.80 |
| After          |          16 | 157.45 | 1885.44 |
| Repeated after |           1 | 130.13 |  438.97 |
| Repeated after |           4 |  99.42 | 1303.63 |
| Repeated after |          16 | 349.91 | 1393.29 |

The initial after-deploy load overlapped the future-barrier probe; the repetition ran after that probe completed. These observations do not establish a uniform native latency improvement. Pending-only sharing is retained for the demonstrated reduction in duplicate cache lookup/body decoding. Stable whole-query latency, actual peak memory and controlled indexed Turbopuffer comparison remain delivery gates.

### Bounded top-k heap updates

The Rust scorer previously pushed every positive candidate into the heap and popped its worst hit when size exceeded top-k. It now reserves top-k capacity and replaces the current worst hit only when the candidate wins the existing total score/row ordering. Score accumulation, bounds, phrase checks and the UTF-16 row ordering are unchanged. The heap never inserts a transient k-plus-one candidate.

Local WASM comparisons exercised 5,000-document fixtures with ascending scores, descending scores, equal-score ties and loose conservative block bounds. Each ran any/all/phrase at top-k 1/10/100, for 36 cases. Scoring used twelve alternating pairs of eight repetitions, excluding three warmup pairs. A repetition also measured nine alternating pairs of four complete ranker/posting-decode/finish pipelines, excluding three warmup pairs. Every repeated result matched baseline serialized rows and scores bit for bit.

At top-k ten, repeated scoring improved 27.7–28.6% with ascending scores and 31.0–34.2% with loose bounds. Complete pipelines improved 4.1–5.5% and 8.0–10.9%, respectively. At top-k one hundred, loose-bound scoring improved 43.3–44.7% and complete pipelines 14.9–16.2%. Descending-score and tie controls were mostly near neutral; the largest repeated tie-pipeline regression was 6.7% for phrase/top-k one hundred. This is targeted local evidence, not a uniform whole-query speedup. The full gate passed 31 Rust and 133 Bun/workerd tests. Exhaustive ranking and equal-score tests now cover top-k 1/4/8/10/64/100.

A separate pre-deploy native diagnostic used two primers before each sixteen-query burst in six query cases: rare, common, filtered, all, phrase and absent-filter matches. All 192 results matched strong baselines at the acknowledged sequence. Snapshot-selection native-clock medians still ranged from 105 to 179 ms, while many ranking intervals stayed zero. Native clocks freeze during uninterrupted CPU, so zero intervals are not zero CPU evidence. A second diagnostic overlapped the deployment and is excluded from latency comparison. Native tail observations timestamped before deployment included 175 query events with rounded provider CPU values from 1 to 1,335 ms. These are partial event observations, include gateway/coordinator/background lifetimes and are not one-to-one request percentiles or isolated scorer CPU measurements.

Native deployment and the Vectorize metadata migration succeeded. The complete 300-query SciFact report remained byte-identical to the earlier validated baseline, preserving 0.673062 nDCG@10, 0.795667 recall@10 and 0.641808 MRR@10. The post-deploy warmed diagnostic completed 192 exact query results. A partial native tail captured 172 query events with rounded CPU values from 1 to 1,192 ms; this does not isolate heap/scorer work or establish a CPU population improvement.

| Warmed query case | Pre-deploy p50 ms | Post-deploy p50 ms | Pre-deploy p95 ms | Post-deploy p95 ms |
| :---------------- | ----------------: | -----------------: | ----------------: | -----------------: |
| Rare              |            308.43 |             546.18 |            861.44 |            1318.96 |
| Common any        |            353.50 |             626.43 |           1098.89 |            1219.21 |
| Filtered any      |            398.44 |             714.78 |           1272.63 |            1751.76 |
| Common all        |            292.25 |             404.00 |            985.93 |            1041.48 |
| Common phrase     |            308.31 |             382.85 |           1005.36 |            2073.09 |
| Absent filter     |            396.57 |             565.98 |           1028.49 |            1453.25 |

Every warmed case's client latency worsened in this post-deploy observation, including the absent-filter case where no heap scoring occurs. Placement/cache state was uncontrolled, and the data does not establish an isolated heap-induced regression or a whole-query gain. The local scorer/pipeline improvements remain distinct evidence. A subsequent standard rare/selective/common/filtered load completed 96 exact responses at concurrency 1/4/16: p50 94.71/76.49/366.60 ms, p95 384.56/1121.28/1523.95 ms and throughput 4.75/12.50/16.99 requests/s. Those latest standard values appear in the README. Stable native whole-query latency and actual peak-memory attribution remain outstanding; snapshot/Bloom acquisition and lifecycle work remain important investigation targets.

### Retained Rust Bloom batches

The earlier path cached decoded bitsets in JavaScript but repacked them and transferred their bytes into WASM on every query. Immutable BloomBatch handles now own packed bytes/offsets inside Rust. The same membership reader, hashes, offset checks and false-positive behavior apply. A charged 4 MiB LRU includes retained bytes, native layout, cache-key/prefix strings and entry overhead. Physical bucket, field and ordered immutable segment keys identify each batch. Manifest replacement does not lose unchanged-segment reuse; eviction/rebuild frees handles. Oversized batches use scoped temporary ownership. Canonical R2 and private snapshot formats are unchanged.

The initial manifest-object-identity prototype was rejected: a reused large bitmap across new manifests incurred a 362.41 ms first-query median versus 35.14 ms for the prior content cache. The retained implementation uses immutable segment identity instead. Document lookup now walks aligned sixty-four-segment windows newest first, preserving per-window reverse order and partial newest-window handling. The final gate passed 31 Rust and 136 Bun/workerd tests, including retained byte ownership/invalid framing, root updates/rebuild and replacement/deletion across 130 segments.

A local WASM comparison used six fixtures: 1/64 bitsets at 8/10,000/40,000 bytes each, twenty-five alternating pairs of forty repetitions and five excluded warmup pairs. Membership output was identical in every repetition. With 64 ten-thousand-byte bitsets, repeated-call median fell from 0.08466 to 0.02635 ms; with 64 forty-thousand-byte bitsets it fell from 0.22344 to 0.02185 ms. These measurements exclude cold construction and demonstrate avoided host transfer, not whole-query or native CPU savings.

Two local workerd comparisons exercised small and 2 MiB synthetic bitmaps with ten alternating baseline/candidate pairs, two excluded warmup pairs and sixteen-query bursts after rehydrating the same canonical point-in-time manifest through Cache API. Large fixtures varied their final bitmap byte across pairs to ensure true initial misses; selected document membership stayed positive. The frame rehydration preserves original observation-age enforcement and creates new decoded manifest objects. All 1,440 queries preserved complete rows/scores and acknowledged sequence, and charged Bloom memory stayed within 4 MiB.

| Fixture | First before/after burst ms | Repeated before/after burst ms | First before/after initial query ms | Repeated before/after initial query ms |
| :------ | --------------------------: | -----------------------------: | ----------------------------------: | -------------------------------------: |
| Small   |               59.05 / 53.64 |                  55.08 / 57.17 |                       28.88 / 24.53 |                          39.84 / 31.09 |
| Large   |               53.21 / 40.52 |                  52.70 / 37.11 |                     305.84 / 284.04 |                        283.49 / 284.29 |

The large rehydrated-burst gain repeated at 23.9% and 29.6%; its initial-query repetition was near neutral. The small burst regressed 3.8% in the repetition. This is scoped local evidence, not a uniform latency improvement or actual peak-memory proof.

Native deployment and the Vectorize metadata migration succeeded. The 300-query SciFact report remained byte-identical to the prior validated report. Before/after/repeated native loads completed 288 exact strong-baseline comparisons on the million-document corpus at sequence 2,000.

| Run            | Concurrency | p50 ms |  p95 ms | Requests/s |
| :------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 |  76.84 |  306.54 |       5.48 |
| Before         |           4 | 101.67 | 1504.83 |       9.97 |
| Before         |          16 | 346.19 | 1323.97 |      13.37 |
| After          |           1 | 109.64 |  535.03 |       4.88 |
| After          |           4 |  88.68 |  944.95 |      15.23 |
| After          |          16 | 130.32 | 1558.23 |      16.66 |
| Repeated after |           1 |  86.44 |  193.78 |       9.80 |
| Repeated after |           4 |  87.74 |  908.45 |      14.17 |
| Repeated after |          16 | 223.05 | 1708.32 |      15.69 |

Concurrency-four medians/tails and concurrency-sixteen medians improved in both candidate loads, but concurrency-one medians and concurrency-sixteen tails regressed. Placement/cache state was uncontrolled. The retained implementation removes demonstrated transfer/repacking work; it does not establish a universal native latency improvement. A native health observation charged 2,146,752 Bloom bytes and 21,795,676 snapshot bytes, with 5,448,863 retained snapshot payload bytes. These are separate bounded cache charges, not actual peak memory.

An additional native Vectorize fixture wrote 130 documents individually, with three identical vectors. It did not observe all expected identifiers within forty visibility probes; cleanup acknowledged deletion and metadata confirmed zero live documents. Native compaction reduced this namespace to 32 segments, so it does not establish native 130-segment boundary coverage. A separate three-document fixture used distinct cosine vectors and explicit synchronization, then verified the three expected identifiers and each group filter against real Vectorize. Unfiltered readiness occurred at probe nineteen, and filtered readiness required retries. All temporary documents were removed and zero live documents confirmed. The API documents [asynchronous Vectorize upserts](https://developers.cloudflare.com/vectorize/reference/client-api/); these observations establish neither a general visibility deadline nor ANN recall. The local 130-segment test separately covers exact revision/deletion boundaries.

### Request-local prepared ranking input

Each selected segment previously re-encoded the complete RankingInput in TypeScript and reparsed/normalized it in Rust. A lazy PreparedQuery now parses and validates common input once per request. The existing RankingInput Schema remains the boundary contract; shared tombstones must be empty, with actual segment tombstones passed separately. Filters, live global statistics, phrase word order and ranking arithmetic remain unchanged. Rankers own their cloned words/statistics, and DisposableStack releases the request-local plan on completion/error. Queries pruned before scoring never construct a plan. Canonical storage and HTTP contracts are unchanged.

Local WASM comparisons used short two-term and long sixty-four-term Unicode queries in any/all/phrase modes. Each comparison performed twenty alternating pairs of thirty-two ranker constructions and excluded four warmup pairs. Candidate timing included one plan constructor per thirty-two rankers. Complete postings/spans/rows/scores matched the former WASM engine for three tombstone masks per case. Repeated preparation medians ranged from 0.01256–0.02009 to 0.00445–0.00839 ms per short-query ranker, and from 0.43372–0.93111 to 0.02746–0.03424 ms per long-query ranker. These isolate preparation and include JavaScript serialization; they do not establish whole-query latency.

A local workerd comparison seeded thirty-two one-document segments, used top-k one hundred to visit all segments, and included full acquisition, decoding and materialization. Twelve alternating pairs of five queries excluded three warmup pairs. Its first 240-query run preserved complete rows/scores: short-query median 22.10→19.48 ms and long-query median 108.29→96.56 ms. An attempted repetition terminated with a client ECONNRESET and is excluded; the workers were disposed before restarting the isolated read comparison. The full gate passed 31 Rust and 138 Bun/workerd tests, including query budgets, per-segment tombstones/filters, any/all/phrase equivalence and ranker validity after freeing the plan.

The completed repeat preserved another 240 responses: short-query median 18.77→16.89 ms and long-query median 91.25→80.37 ms. Thus the full local path improved approximately 10.0–11.9% in the repeat, with all 480 completed comparisons exact. The existing text_rank_prepare interval continues to measure per-segment directory/ranker acquisition; shared plan preparation is included in its enclosing text_rank phase. No native CPU or uniform latency gain follows from these local results alone.

Native deployment and the Vectorize metadata migration succeeded. The complete 300-query SciFact report stayed byte-identical to the earlier validated report. The first post-deploy standard load completed 96 exact results at the acknowledged sequence. Native DisposableStack lifetime ran successfully, independently of local workerd coverage. Before/after p50 at concurrency 1/4/16 was 78.35/68.37/320.58 versus 73.34/98.06/303.94 ms; p95 was 513.71/1426.98/1687.96 versus 387.81/1065.50/1313.61 ms. Placement/cache state was uncontrolled; lower tails in one run do not establish an isolated preparation effect.

The repeated native load preserved another 96 exact responses, bringing before/after/repeat coverage to 288. Repeated p50 at concurrency 1/4/16 was 61.92/76.02/226.05 ms, p95 231.01/1001.88/1246.32 ms and throughput 8.38/12.04/22.37 requests/s. All three p95 values improved against this reference in both candidate loads, while concurrency-four medians remained worse. These are uncontrolled native observations, not a causal or universal speedup claim. The latest repeated values are shown in the README. Stable tail latency, actual peak memory and indexed Turbopuffer parity remain unverified.

### Retained decoded frequency pages

Repeated any/all queries previously decompressed and scanned every position varint again. Immutable FrequencyPage handles now retain checked row/frequency/final-position data for pages whose conservative title/body frequency bound exceeds one. Phrase and single-occurrence pages retain the original decoder. Every attachment validates current header position bounds, row order, filters and tombstones. Raw bytes and decoded pages share the existing 12 MiB LRU; eviction frees native handles. The cache does not skip compressed range acquisition or cache query results.

Two alternating local workerd comparisons each checked 420 complete rows/scores over 5,000-document fixtures, fourteen pairs of three queries with three warmup pairs excluded. With 128 repeated occurrences, any medians changed 8.20→6.97 ms and 7.75→6.24 ms; all changed 9.19→8.53 ms and 7.31→5.40 ms. Low-frequency any controls changed 8.73→8.75 ms and 7.41→9.82 ms; all changed 5.98→6.22 ms and 10.23→10.13 ms. Unchanged phrase controls also moved, so these results establish a scoped repeated-decoding benefit rather than uniform whole-query improvement. The initial prototype cached single-occurrence pages too and was rejected after a 9.5% low-frequency any regression.

The separate warm WASM pipeline comparison included fresh ranker construction, filters, tombstones and scoring, with sixteen alternating pairs of four operations and four warmup pairs excluded. Across eighty retained pages, high-frequency any/all medians changed 12.36/12.21→0.173/0.170 ms initially and 16.44/12.19→0.214/0.168 ms on repetition. Page payload charge was 283,200 bytes, excluding JavaScript cache metadata added by the storage owner. Candidate timings exclude cold page construction; they do not establish native CPU savings.

The full gate passed 31 Rust and 141 Bun/workerd tests. Coverage includes any/all equivalence across filters/tombstones, phrase rejection, reversed blocks, invalid positions on excluded rows, CRC failures, namespace rebuild and a full 12 MiB raw range evicting decoded handles within the shared budget. Charged cache bytes do not establish actual peak heap.

Native Alchemy deployment and its unconditional Vectorize metadata migration succeeded. The complete 300-query SciFact report was byte-identical to the preceding baseline, retaining every reported identifier and quality metric. Before/after/repeated loads preserved 288 exact strong-baseline rows/scores/sequence checks on the million-document namespace at sequence 2,000.

| Run            | Concurrency | p50 ms |  p95 ms | Requests/s |
| :------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 |  88.15 |  169.62 |       9.99 |
| Before         |           4 | 129.17 |  906.42 |      12.81 |
| Before         |          16 | 313.52 | 1717.18 |      13.36 |
| After          |           1 | 102.14 |  787.23 |       5.16 |
| After          |           4 |  86.89 | 1128.65 |      13.67 |
| After          |          16 | 237.99 | 1535.30 |      20.17 |
| Repeated after |           1 |  70.05 |  253.75 |       8.43 |
| Repeated after |           4 |  75.54 |  852.19 |      16.34 |
| Repeated after |          16 | 252.17 | 1316.89 |      14.23 |

Concurrency-four/sixteen medians improved in both candidate loads, while concurrency-one tails worsened. Cache/isolate/network placement was uncontrolled; this is not causal evidence of a general native speedup. A separate health request returned the new postingCacheBytes diagnostic but landed in an empty isolate, with zero cached bytes; it does not prove native cache residency or peak memory. The README shows the repeated load. Stable native tail latency, actual peak heap and indexed Turbopuffer parity remain outstanding.

### Rejected all-cached posting acquisition bypass

A local prototype scanned every requested any/all page before attaching any handle. If all immutable decoded pages were retained, it attached them synchronously without compressed range acquisition; a miss preserved the original path without partially mutating the ranker. Per-page position/order validation, span bounds, filters and tombstones remained in force. Phrase queries kept their original path. The gate passed 31 Rust and 141 Bun/workerd tests; a targeted partial-cache seed additionally covered a retained first term with a missing second term.

Two comparisons checked 420 exact full-result rows/scores each on the same 5,000-document low/high-frequency fixtures, using fourteen alternating pairs of three queries and excluding three warmup pairs. The first overlapped the test gate, so its timing is provisional; the repetition ran after the gate and targeted tests finished. High-frequency any changed 7.23→6.21 ms initially but 5.74→5.93 ms on repetition. High-frequency all regressed 5.98→7.22 ms and 7.44→8.93 ms, approximately 20% in both. Repeated low-frequency any/all controls were 7.20→7.12 and 9.10→8.79 ms; the unchanged phrase control was 10.38→10.61 ms. The prototype was removed before deployment. Production retains the prior frequency-page cache and acquisition policy; avoiding an acquisition alone did not establish a speedup. The additional partial-cache lifecycle test remains.

### Retain validated R2 manifest bytes

Fresh edge snapshot acquisition previously decoded the R2 JSON through Root Schema, encoded the entire Root back to JSON and encoded that string into UTF-8 for the cache frame. It now validates the same R2 body and retains its original UTF-8 bytes. Cache rehydration still validates framing, metadata, Root, matching sequence and age; conditional ETag reuse and the 24 MiB charged budget are unchanged. Strong reads do not use snapshot caches. The test seeds a valid Unicode manifest with surrounding whitespace and verifies both exact cached payload bytes and the decoded Root.

Two full workerd comparisons used fourteen alternating baseline/candidate pairs per size, excluding three warmup pairs, with a fresh namespace/R2 observation per query. All 168 results preserved complete rows/scores and sequence. The second run's initial setup overlapped the short lint/typecheck commands, which completed before its larger fixtures. These synthetic fixtures expand a valid document Bloom string while retaining a one-document text result; they measure cold acquisition rather than a million-document ranking workload.

| Manifest bytes | First before/after ms | Repeated before/after ms |
| -------------: | --------------------: | -----------------------: |
|            666 |         35.99 / 33.26 |            34.92 / 36.16 |
|      2,097,830 |         45.37 / 36.25 |            41.00 / 40.70 |
|      4,194,982 |         42.64 / 40.24 |            49.75 / 48.15 |

A separate Bun pipeline measurement used a Schema-generated 5,438,950-byte manifest with 200 segment records, eighteen alternating pairs of four validations/retentions, excluding four warmup pairs. Median fell from 8.661 to 3.230 ms. It includes common UTF-8 decoding and Root validation, plus full encoding on the former path; it excludes R2, snapshot framing, ranking and native Worker CPU telemetry. The repeated full-path gain is much smaller than this isolated result, and the small-manifest control regressed. Avoided serialization does not establish uniform latency, actual peak heap or Turbopuffer parity.

The final gate passed 31 Rust and 142 Bun/workerd tests, including corrupt canonical input/recovery, conditional ETag reuse, expired/future snapshot rejection, minimum-sequence barriers and the exact Unicode payload test. Strict lint/typecheck, both Clippy targets and secret scanning passed. Native deployment and the unconditional Vectorize metadata migration succeeded. Before/after/repeated million-document loads completed 288 exact strong-baseline rows/scores/sequence checks.

| Run            | Concurrency | p50 ms |  p95 ms | Requests/s |
| :------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 |  80.53 |  152.94 |       9.99 |
| Before         |           4 |  91.94 |  220.95 |      35.04 |
| Before         |          16 | 139.93 | 1106.26 |      23.13 |
| After          |           1 |  87.59 |  489.09 |       6.30 |
| After          |           4 | 110.46 | 1241.77 |      10.18 |
| After          |          16 | 221.28 | 1483.59 |      18.91 |
| Repeated after |           1 |  70.26 |  190.20 |      12.17 |
| Repeated after |           4 |  87.83 |  383.04 |      22.63 |
| Repeated after |          16 | 198.96 | 1567.23 |      18.20 |

All initial candidate phases worsened against this baseline. Repetition improved concurrency-one/four medians but all p95 values remained worse, as did concurrency-sixteen median. The retained change removes demonstrated serialization work, but these uncontrolled native results do not establish a whole-query speedup. The README shows the repeated load. No snapshot fallback occurred in these 288 observations. In the repeated concurrency-sixteen phase, snapshot selection reached 977 ms and ranking reached 585 ms in separate observations; gateway elapsed reached 1,378 ms. These include I/O and concurrent scheduling, and native clocks freeze during uninterrupted CPU, so zero phase timings are not zero CPU evidence. Cache placement, actual peak heap and stable tail latency remain unresolved; no new ranking-quality or vector-recall claim is made by this snapshot-only change.

### Rejected scoring specialization for phrase state

An uncommitted Rust prototype specialized finish_lists by a compile-time phrase flag, removing the positional selection vector from any/all scoring. The first variant appended phrase selections and regressed the 64-term all scorer by 26.9% initially and 15.2% on repetition. A second variant retained phrase's original indexed selection/fill, with an empty selection for any/all. Both variants passed the strict gate with 31 Rust and 142 Bun/workerd tests, including independent exhaustive scoring and compact/positional equivalence. No ranking arithmetic, bounds, filters, tombstones or tie order changed.

The WASM comparison used 5,000 documents, 2/16/64 terms, any/all/phrase, top-k 100, excluded rows and group filters. Scoring used eighteen alternating pairs of four finish calls, excluding four warmup pairs; complete ranker/decode/score pipelines used ten pairs of two calls, excluding three warmup pairs. All serialized rows/scores matched. The second variant improved some 16-term cases but its repeated 64-term pipeline medians regressed: any 66.17→70.86 ms, all 68.24→68.95 ms and phrase 83.91→91.51 ms. Its WASM binary grew from 695,480 to 705,061 bytes.

A full workerd comparison seeded ten 500-document segments, exercised the same term counts/modes at top-k 100 and group filtering, and checked 756 exact responses over fourteen alternating pairs of three queries, excluding three warmup pairs. Every candidate median regressed:

| Terms | Mode   | Before ms | Candidate ms |
| ----: | :----- | --------: | -----------: |
|     2 | any    |    146.62 |       188.47 |
|     2 | all    |    159.04 |       183.25 |
|     2 | phrase |    157.89 |       177.55 |
|    16 | any    |    153.77 |       183.87 |
|    16 | all    |    156.40 |       183.25 |
|    16 | phrase |    177.32 |       185.95 |
|    64 | any    |    171.14 |       202.15 |
|    64 | all    |    166.16 |       192.29 |
|    64 | phrase |    176.03 |       218.37 |

The experiment was removed before any native deployment. These observations reject this implementation; they do not identify whether code layout, compilation or another runtime effect caused the regression. Removing source-level bookkeeping did not establish faster execution. Production retains the preceding scorer, and snapshot/manifest behavior is unchanged. Rebuilding the restored source reproduced the baseline WASM byte for byte.

### Segment fragmentation and compaction trade-off

Two isolated local workerd runs ingested the same deterministic 50,000-document corpus in 100 writes of 500 documents, with queue consumption disabled. Each run measured the initial 100-segment layout, manually compacted toward 32 (reaching 30), then toward eight. Each layout ran rare/selective/common/filtered queries in strong and edge-eventual modes, five warmups and twenty timed requests per case. All 1,200 responses across both runs retained complete rows/scores and acknowledged sequence 100. Layouts were sequential within each run rather than alternating; cache placement/warmth and runtime scheduling remain limitations. These are local observations, not a native compaction latency claim.

| Query / consistency | First p50 at 100 / 30 / 8 segments, ms | Repeated p50 at 100 / 30 / 8 segments, ms |
| :------------------ | -------------------------------------: | ----------------------------------------: |
| Rare / strong       |                     3.67 / 4.25 / 2.78 |                        6.09 / 2.54 / 2.48 |
| Selective / strong  |                    11.23 / 4.79 / 4.85 |                       10.28 / 6.59 / 4.32 |
| Common / strong     |                  12.42 / 12.03 / 12.86 |                      7.61 / 14.83 / 13.89 |
| Filtered / strong   |                   9.36 / 10.24 / 11.14 |                       7.93 / 9.62 / 10.64 |
| Rare / edge         |                     2.61 / 3.44 / 3.12 |                        3.12 / 4.12 / 2.93 |
| Selective / edge    |                     6.64 / 7.73 / 5.75 |                        7.86 / 7.45 / 6.67 |
| Common / edge       |                   6.50 / 15.25 / 18.15 |                      8.55 / 14.36 / 21.75 |
| Filtered / edge     |                    7.36 / 5.81 / 13.93 |                      10.31 / 9.84 / 13.60 |

In the repeated run's first measured common query, scoring visited three/two/two segments but acquired 24/128/284 posting blocks and 804/4,372/9,758 compressed bytes at the three layouts. Those counters include memory cache acquisitions; they are not R2-origin request or billing counts. The existing scorer still fetches/decompresses selected pages before its finish-time block pruning. Larger competitive segments can therefore increase posting work despite reducing catalog/segment count. This is evidence to investigate earlier safe block pruning, not proof that all latency changes came from that mechanism.

Reaching 30 segments required ten compactions, reindexing 40,000 document versions into 20,992,712 newly written segment bytes plus 3,012,413 manifest bytes. Reaching eight required six additional compactions, reindexing another 42,000 versions into 22,009,851 segment bytes plus 1,644,530 manifest bytes. Repeated elapsed compaction totals were 11.24 and 10.92 seconds. These counts exclude ingestion, caches, retained old segments and collection; they do not estimate a Cloudflare bill. Manifest size decreased only from 322,722 to 283,639 to 271,443 bytes, since Bloom payloads still represent the corpus.

The automatic compaction policy remains unchanged: the measured selective-query gains did not justify claiming that a lower segment threshold uniformly speeds search or lowers cost. Only disposable local namespaces were modified; the owned native million-document corpus and deployed runtime were untouched by this experiment.

### Global-cutoff posting page pruning before acquisition

Once prior segments fill global top-k, Rust now bounds each requested posting page before acquisition. It sums, in sorted term order, the maximum conservative score of every term block overlapping the candidate row interval. Non-negative term scoring makes this an upper bound on complete rows, including any-mode rows that match only some terms. A page is omitted only below the existing strict-score tolerance, or on exact score equality when its first filter/tombstone-eligible UTF-16 identifier cannot beat the cutoff. Competitive rows retain all contributing pages; incomplete loser scores cannot outrank that global cutoff. Phrase matching, live global statistics, score arithmetic and final merging are unchanged. No cut is available for the first scored segment.

The shared span builder still bounds excluded byte gaps to 4 KiB and acquisitions to the segment/16 MiB limit, with windows of four. New gaps may split spans. A retained span can still include bounded skipped bytes, so omission does not imply every skipped byte avoids acquisition. All loaded pages keep their CRC, varint, position and row-order checks. No cache budget, canonical format or public HTTP input changes.

Two complete workerd comparisons used the same deterministic 50,000 documents at 100/30/8 segments, fourteen alternating pairs of two requests per case and three excluded warmup pairs. The repeat created the candidate Worker first to vary runtime creation order; reported columns remain baseline/candidate. All 1,344 responses retained complete rows/scores and acknowledged sequence across layouts and variants.

| Segments | Case            | First before/after ms | Repeated before/after ms |
| -------: | :-------------- | --------------------: | -----------------------: |
|      100 | Rare strong     |           4.44 / 4.88 |              3.83 / 3.88 |
|      100 | Common strong   |         14.74 / 13.56 |            16.74 / 13.83 |
|      100 | Filtered strong |         11.75 / 11.37 |            13.13 / 15.26 |
|      100 | Common edge     |         11.68 / 12.27 |            20.71 / 20.08 |
|       30 | Rare strong     |           5.90 / 4.80 |              4.06 / 3.70 |
|       30 | Common strong   |         14.89 / 13.09 |             12.51 / 9.96 |
|       30 | Filtered strong |         10.25 / 11.99 |              7.71 / 8.37 |
|       30 | Common edge     |         15.47 / 13.38 |             10.26 / 9.86 |
|        8 | Rare strong     |           4.65 / 3.23 |              3.49 / 3.49 |
|        8 | Common strong   |         13.26 / 10.80 |            15.08 / 11.15 |
|        8 | Filtered strong |         10.09 / 11.48 |            11.36 / 10.84 |
|        8 | Common edge     |         13.98 / 12.99 |            13.94 / 12.28 |

Common queries at 30 segments acquired 74 rather than 128 blocks and 2,519 rather than 4,372 compressed bytes; at eight segments they acquired 168 rather than 284 blocks and 5,764 rather than 9,758 bytes. The 100-segment common and filtered cases retained their original block counts. These counters include cache hits and are not an R2 billing meter. The repeated large-segment strong common gains were approximately 20–26%, while filtered controls included regressions. Placement/scheduling and changed WASM code layout also affect timing; this establishes scoped page-work reduction rather than a uniform latency improvement.

The complete gate passed 32 Rust and 145 Bun/workerd tests (177 total), with strict lint/typecheck and both Clippy targets. Differential WASM tests compare every competitive returned hit across modes, repeated words, masks, tombstones and Unicode identifiers; a uniform-score fixture exercises exact UTF-16 equality cuts and both sides of the score tolerance. A native Rust fixture verifies new gap splitting at 4,096/4,097 bytes. The workerd regression returns the same winners in any/all/phrase while acquiring twelve instead of twenty-four posting pages. The complete 300-query SciFact report was byte-identical to the validated baseline, retaining every identifier and quality metric. Secret scanning passed. Native Alchemy deployment and the unconditional Vectorize metadata migration succeeded.

Before/after/repeated native loads on the million-document corpus completed 288 exact strong-baseline rows/scores/sequence checks at sequence 2,000. Every common-case observation acquired 178 instead of 378 blocks and 6,097 instead of 12,990 compressed bytes: approximately 53% less measured page acquisition work. Filtered queries retained 188 blocks and 6,377 bytes. Counts include cache hits; span count remained six/three respectively, so no reduction in origin requests, billing or native CPU is inferred from them.

| Run            | Concurrency | p50 ms |  p95 ms | Requests/s |
| :------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 |  83.82 |  325.78 |       6.17 |
| Before         |           4 |  84.12 |  936.43 |      16.82 |
| Before         |          16 | 197.49 | 1489.25 |      18.73 |
| After          |           1 |  80.29 |  315.98 |       6.71 |
| After          |           4 |  88.74 |  989.54 |      13.57 |
| After          |          16 | 157.04 | 1498.73 |      16.17 |
| Repeated after |           1 |  69.38 |  256.27 |       8.52 |
| Repeated after |           4 |  57.59 |  234.16 |      32.39 |
| Repeated after |          16 | 140.26 | 1066.76 |      22.33 |

The repeated load improved all medians/tails against this reference, but the initial candidate worsened concurrency-four median/tail and concurrency-sixteen tail. Cache/isolate/network placement was uncontrolled; stable native latency and causal CPU attribution remain unproved. Page acquisition reduction is separately observed in every phase. The README shows the repeated values. Peak Worker heap, fully indexed Turbopuffer parity and general ANN/hybrid recall remain separate outstanding gates.

### Dense-term lower cutoff before the first posting read

When no global cutoff is available, the first ranker may derive one from terms whose physical segment df equals its document count. Any-mode eligibility is guaranteed by at least one such term; all requires every distinct requested term to be dense. Phrase does not use this seed. For each currently filter/tombstone-eligible document, Rust sums conservative one-occurrence BM25 contributions, choosing the cheaper possible nonempty field. Other terms contribute zero. Non-negative scoring makes these lower scores no greater than complete scores. A bounded top-k heap supplies a threshold only when k positive eligible rows exist.

The seeded threshold includes its own kth identifier on exact score equality, preserving the supporting rows that have not yet been materialized. The existing global threshold remains exclusive because its supporting rows already belong to prior segments. Both paths share page upper bounds and span grouping. No probe posting reads, query-result cache, persisted metadata or public input are added. A header scan has a cost even when its lower bound cannot prune a page.

The gate passed 33 Rust and 147 Bun/workerd tests (180 total). A field-assignment unit test checks the minimum-score bound against every tested nonempty title/body assignment. Differential WASM matrices cover any/all/phrase, dense and missing terms, mixed fields, multiplicity, masks, tombstones and top-k 1/10/100. A sparse eligible-row fixture checks a kth row at the start of a page, including insufficient-row fallback. An existing workerd fixture now acquires eight pages for any/all, rather than twelve; phrase remains twelve, with the same winners.

Two full workerd comparisons used 50,000 documents at 100/30/8 segments, fourteen alternating pairs of two requests and three excluded warmup pairs. The repeat reversed worker creation order. Every one of the 2,016 responses retained complete rows/scores and sequence.

| Segments | Case            | First before/after ms | Repeated before/after ms |
| -------: | :-------------- | --------------------: | -----------------------: |
|      100 | Rare strong     |           3.90 / 4.75 |              5.68 / 4.80 |
|      100 | Common strong   |         13.15 / 13.05 |            13.00 / 12.72 |
|      100 | Filtered strong |         10.94 / 11.04 |            11.76 / 11.56 |
|      100 | Common edge     |          10.40 / 9.85 |            12.44 / 13.04 |
|      100 | All strong      |         12.63 / 12.81 |            13.95 / 13.57 |
|      100 | Phrase strong   |         13.73 / 13.81 |            12.60 / 12.24 |
|       30 | Rare strong     |           7.38 / 7.56 |              5.15 / 4.34 |
|       30 | Common strong   |         23.36 / 17.73 |             10.53 / 9.23 |
|       30 | Filtered strong |         16.93 / 14.05 |            11.08 / 10.58 |
|       30 | Common edge     |         17.69 / 14.08 |            11.79 / 10.47 |
|       30 | All strong      |         17.79 / 17.06 |            10.45 / 10.58 |
|       30 | Phrase strong   |         15.93 / 16.19 |            12.14 / 10.69 |
|        8 | Rare strong     |         12.45 / 12.45 |              3.75 / 3.09 |
|        8 | Common strong   |         29.79 / 20.85 |             11.92 / 9.46 |
|        8 | Filtered strong |         22.79 / 22.21 |            12.35 / 12.88 |
|        8 | Common edge     |         25.02 / 18.12 |            12.53 / 10.92 |
|        8 | All strong      |         30.32 / 21.74 |            12.95 / 11.08 |
|        8 | Phrase strong   |         26.23 / 28.77 |            15.39 / 15.52 |

Common/all acquisition changed from 24 to 18 blocks at 100 segments, 74 to twelve at thirty, and 168 to twelve at eight. At the two compacted layouts it acquired 398 compressed bytes, versus 2,519/5,764. Filtered and phrase block counts stayed unchanged. Repeated eight-segment any/all medians improved about 21%/14%; thirty-segment all and hundred-segment edge controls regressed slightly. The first phrase regression did not repeat at the same magnitude. Changed code layout, cache placement and scheduling also affect these local timings. The measured page reduction is separate from uniform latency, native CPU, peak-memory or billing claims.

The complete 300-query SciFact report remained byte-identical to the validated baseline. Formatting, strict lint/typecheck, both Clippy targets and secret scanning passed. Native Alchemy deployment and the unconditional Vectorize metadata migration succeeded. The WASM artifact grew from 699,557 to 703,966 bytes; source-level avoided work alone is not a cold-start or peak-memory measurement.

Before/after/repeated native loads on the million-document corpus completed 288 exact strong-baseline rows/scores/sequence checks at sequence 2,000. Common acquisition consistently fell from 178 to 22 blocks and 6,097 to 731 compressed bytes, approximately 88% less page acquisition work relative to global-cutoff-only pruning. The earlier pre-pruning reference used 378 blocks; the two changes together reduce that to 22 on this workload. Six spans remain, so origin requests and billing cannot be inferred from these cache-inclusive counters. Filtered queries still use 188 blocks and 6,377 bytes.

| Run            | Concurrency | p50 ms |  p95 ms | Requests/s |
| :------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 |  61.69 |  297.35 |       9.22 |
| Before         |           4 |  69.62 |  219.89 |      31.55 |
| Before         |          16 | 176.86 |  994.77 |      20.66 |
| After          |           1 |  72.03 |  683.39 |       6.75 |
| After          |           4 |  70.01 |  864.24 |      22.58 |
| After          |          16 | 114.35 | 1015.58 |      27.03 |
| Repeated after |           1 |  75.19 |  164.37 |      10.91 |
| Repeated after |           4 |  75.67 |  246.55 |      29.10 |
| Repeated after |          16 | 190.62 | 1319.52 |      21.84 |

The first concurrency-sixteen median improvement did not repeat. Every repeated median was worse than the reference, while concurrency-one p95 improved. Cache/isolate/network placement was uncontrolled, and each phase has only 32 requests. These data do not establish an overall native latency gain. The repeated page counts are the distinct verified reduction; the README includes the latest latency values and limitations. Stable native tail latency, actual peak heap and fully indexed Turbopuffer parity remain outstanding.

### Eligible field lengths in per-block score bounds

Per-block upper bounds previously used physical minimum title/body lengths even when filters or tombstones excluded those shortest documents. Bounds now use eligible row minima within each term's row interval, clamped upward against the original physical minima. Both remain lower bounds on lengths of eligible postings; larger normalizing lengths cannot raise the conservative score bound. The clamp also preserves the original bound when eligible non-posting rows have shorter fields. A completely excluded interval contributes zero. Unrestricted masks retain physical bounds. The query-local result is used before page acquisition and during finish-time pruning; no canonical format, cache budget or persistent filter metadata changes.

The native unit property verifies each bound remains above every tested eligible posting's actual score and below its original physical bound, across mixed fields, sparse terms, filters and tombstones. A sparse eligible-row WASM fixture retains the same top-k at 1/4/10/100 while selecting 2/8/20/32 pages from an original thirty-two. Existing independent scoring and revision/Unicode regressions passed.

An initial gate and recovery run hit pre-existing five-second collection/catalog/Bloom test deadlines under host load exceeding 38 on 28 available CPUs. Timed-out callbacks also contaminated subsequent shared counters. No limits or assertions were relaxed. A separate alternating baseline/candidate collection diagnostic preserved all mark/delete counts and completed in 1.8–2.2 seconds after load subsided. The clean standard gate then passed 34 Rust and 148 Bun/workerd tests (182 total). The initial failed runs are not passing evidence or performance comparisons.

Two complete workerd comparisons used 50,000 documents at 100/30/8 segments, fourteen alternating pairs of two queries and three excluded warmup pairs. The repeat reversed worker creation order. All 2,688 responses retained complete rows/scores and acknowledged sequence. Tests finished before these timing runs.

| Segments | Case            | First before/after ms | Repeated before/after ms |
| -------: | :-------------- | --------------------: | -----------------------: |
|      100 | rare            |           5.95 / 3.93 |              4.35 / 4.02 |
|      100 | common          |         12.01 / 10.28 |              9.77 / 9.13 |
|      100 | filtered        |           9.14 / 9.45 |              9.33 / 8.24 |
|      100 | edge-common     |         10.20 / 10.43 |              8.24 / 8.70 |
|      100 | all             |           9.09 / 9.58 |              7.16 / 7.27 |
|      100 | phrase          |         11.84 / 11.28 |              8.59 / 9.50 |
|      100 | filtered-all    |         13.33 / 13.77 |            10.47 / 10.70 |
|      100 | filtered-phrase |          11.07 / 9.83 |            10.83 / 10.42 |
|       30 | rare            |           5.51 / 3.71 |              3.32 / 4.02 |
|       30 | common          |           8.24 / 7.86 |              7.15 / 8.26 |
|       30 | filtered        |           7.99 / 7.08 |             9.75 / 10.28 |
|       30 | edge-common     |         10.38 / 10.92 |              8.42 / 7.93 |
|       30 | all             |         10.74 / 10.83 |              8.21 / 9.16 |
|       30 | phrase          |          9.47 / 10.49 |             10.88 / 9.01 |
|       30 | filtered-all    |           9.07 / 7.02 |            11.09 / 11.85 |
|       30 | filtered-phrase |           8.79 / 7.63 |            13.33 / 12.50 |
|        8 | rare            |           2.63 / 3.95 |              4.76 / 2.83 |
|        8 | common          |           9.48 / 9.99 |              8.57 / 8.90 |
|        8 | filtered        |          21.03 / 9.60 |              9.63 / 8.70 |
|        8 | edge-common     |           8.70 / 9.30 |              8.19 / 8.23 |
|        8 | all             |         18.04 / 15.53 |              8.25 / 7.87 |
|        8 | phrase          |         16.99 / 17.47 |            13.27 / 13.64 |
|        8 | filtered-all    |         27.54 / 12.39 |            13.95 / 13.08 |
|        8 | filtered-phrase |         24.61 / 21.54 |            16.69 / 15.97 |

Filtered acquisitions changed 23→18 blocks at 100 segments, 62→20 at thirty and 141→39 at eight; corresponding all-mode counts were 46→36, 124→40 and 282→78. Filtered phrase counts were 46→36, 124→84 and 282→216. At eight segments, filtered any/all acquired 2,062/4,169 compressed bytes instead of 4,782/9,689; phrase acquired 8,516 instead of 9,689. Gap coalescing can still acquire skipped bytes. All counters include cache hits and do not establish fewer origin requests or a billing reduction.

The large-layout filtered any/all median gains repeated at about 10%/6%, much less than the initial approximately 54%/55%. Thirty-segment any/all regressed about 5%/7% on repetition despite fewer pages. Unfiltered controls also varied. The repeat supports scoped page-work reduction; it does not prove uniform latency or native CPU gains. WASM grew from 703,966 to 704,730 bytes.

The 5,183-document/300-query SciFact report remained byte-identical to the reference (SHA-256 `9dbe36ba7a85f61312f089c631c4b0dc134e6e876796921ae8206e270415cb28`). The Alchemy production deployment and unconditional Vectorize metadata migration completed successfully. Native before/after/repeated-after runs each checked 96 edge responses against strong rows/scores and acknowledged sequence 2,000 in the same read-only million-document, 200-segment corpus. All 288 responses matched.

Filtered acquisition fell from 188 blocks/6,377 compressed bytes to 41 blocks/2,090 bytes in both after runs at every concurrency. Common acquisition remained 22 blocks/731 bytes. These are cache-inclusive acquired blocks/bytes, not origin-request or billing measurements.

| Phase          | Concurrency | p50 ms |  p95 ms | Requests/s |
| :------------- | ----------: | -----: | ------: | ---------: |
| Before         |           1 |  67.89 |  209.41 |       9.63 |
| Before         |           4 |  59.94 |  696.60 |      21.81 |
| Before         |          16 | 160.03 | 1149.12 |      19.35 |
| After          |           1 |  81.56 |  333.45 |       6.58 |
| After          |           4 |  73.54 |  824.00 |      19.44 |
| After          |          16 | 124.65 | 1229.83 |      20.64 |
| Repeated after |           1 |  61.63 |  188.82 |      13.23 |
| Repeated after |           4 |  68.48 |  448.31 |      23.03 |
| Repeated after |          16 |  76.07 | 1466.11 |      19.99 |

The repeated concurrency-sixteen median improved, while its p95 worsened to 1,466 ms. The first after run regressed concurrency-one/four medians. Placement, cache state and network conditions were uncontrolled, and each phase has only 32 samples. The reduced filtered page acquisition repeated; stable native tail-latency improvement, actual peak Worker memory and fully indexed Turbopuffer parity remain unproved. The README reports the latest repeated run.

### Snapshot acquisition stage timings

Authenticated edge queries now distinguish Cache API acquisition (`edge_snapshot_cache`), R2 response acquisition (`edge_snapshot_r2`) and manifest body consumption, validation and frame preparation (`edge_snapshot_body`) in Server-Timing. Cache time includes opening/matching the internal cache and consuming/validating a selected frame, or waiting for that shared operation. R2/body durations describe the shared acquisition as a whole; a caller joining an existing acquisition may wait less than those reported durations. They are not additive per-request CPU measurements. Warm-memory hits omit these acquisition fields. Native Worker clocks may remain frozen during uninterrupted CPU, so zero does not establish zero processing cost. Cache policy, original observation-age enforcement, sequence barriers and ranking are unchanged.

The complete local gate passed 34 Rust and 148 Bun/workerd tests with 2,565 Bun assertions. The Alchemy production deployment and metadata migration completed. A diagnostic native run increased each concurrency phase to 128 requests; all 384 responses retained strong rows/scores and sequence 2,000 in the unchanged million-document corpus. This diagnostic has no paired baseline and does not establish a performance improvement.

| Concurrency | p50 ms | p95 ms | Requests/s | Cache acquisitions | Foreground R2 results |
| ----------: | -----: | -----: | ---------: | -----------------: | --------------------: |
|           1 |  50.02 |  76.85 |      17.27 |                  1 |                     1 |
|           4 |  60.85 | 603.97 |      28.25 |                 14 |                     0 |
|          16 |  78.51 | 992.01 |      50.74 |                 27 |                     2 |

The first foreground R2 acquisition reported 169 ms until the response and 25 ms for body consumption/validation/framing, preceded by 13 ms in cache acquisition. Concurrency sixteen had two R2 timing observations, each reporting 166 ms acquisition and 53 ms body preparation; shared operations can return the same timings to multiple callers, so these are not two proven distinct origin reads. Most foreground cache acquisitions returned without a subsequent R2 result. At concurrency sixteen, cache acquisition reached 432 ms and directory/ranker preparation reached 532 ms. These intervals include asynchronous waiting and scheduling and do not isolate Rust CPU. This narrows the next investigation to cold snapshot/directory acquisition and ranker preparation; it does not attribute all tail latency to R2. Client/network effects remain material: the slowest response took 1,492 ms while its reported gateway interval was 462 ms.

### Shared immutable prepared-query data

Prepared queries already avoided reparsing common input for each segment, but every ranker still deep-cloned normalized words and the live frequency map. Rust rankers now retain `Rc` references to immutable words/statistics. The plan releases its original text and validated empty shared tombstone vector after construction. Filters still create segment-local eligibility masks, tombstones still apply to query-local copies, and posting lists remain private. Releasing a plan before its rankers remains valid; the existing cross-segment any/all/phrase regression explicitly exercises that lifetime. Persisted formats, query limits, scoring arithmetic and cache budgets are unchanged.

Two alternating WASM comparisons measured creation/release of 64 rankers per prepared query over identical 128-document directories. Each case used six excluded warmup pairs and 28 measured pairs. Short queries have two normalized terms; long queries have 64 terms with long Unicode input. Filters select alternating groups; tombstones alternate independently. Plan construction/release is included, while directory parsing, posting acquisition and scoring are outside the timed interval. Each run separately compared complete selected spans and final rows/scores for three tombstone states in all twelve cases. These microsecond measurements do not establish end-to-end gains.

| Query | Mode   | Filtered | First before/after µs | Repeated before/after µs |
| :---- | :----- | :------- | --------------------: | -----------------------: |
| short | any    | false    |           2.45 / 1.90 |              2.10 / 1.63 |
| short | any    | true     |           2.52 / 2.02 |              2.07 / 1.90 |
| short | all    | false    |           1.66 / 1.38 |              1.29 / 1.04 |
| short | all    | true     |           2.64 / 2.27 |              1.40 / 1.19 |
| short | phrase | false    |           1.49 / 1.11 |              1.15 / 0.89 |
| short | phrase | true     |           1.73 / 1.32 |              1.36 / 1.08 |
| long  | any    | false    |          13.93 / 5.27 |             11.25 / 4.15 |
| long  | any    | true     |          14.14 / 5.22 |             11.54 / 4.35 |
| long  | all    | false    |          11.30 / 4.00 |             11.29 / 3.93 |
| long  | all    | true     |          11.52 / 4.31 |             13.85 / 5.04 |
| long  | phrase | false    |          12.42 / 4.21 |             13.60 / 4.82 |
| long  | phrase | true     |          13.39 / 4.79 |             13.88 / 5.13 |

The repeated preparation reductions ranged from 8–23% for short queries and 62–65% for long queries. The absolute saving is small per segment and does not remove cold snapshot or directory I/O. WASM decreased from 704,730 to 704,098 bytes.

Two workerd comparisons used 32 segments and top-k 100 so both short and long cases scored every segment. Twelve alternating pairs of five queries excluded three warmup pairs per case; the repeat reversed worker creation order. All 480 complete responses retained identical rows and scores.

| Query | First before/after ms | Repeated before/after ms |
| :---- | --------------------: | -----------------------: |
| short |         17.08 / 18.62 |            18.61 / 16.24 |
| long  |         91.74 / 83.82 |            85.56 / 84.53 |

The short case regressed 9.0% initially and improved 12.7% on repetition; the long case improved 8.6% initially and 1.2% on repetition. The full path does not repeat the large percentage seen in isolated preparation. Sharing eliminates per-ranker deep copies, but these measurements do not establish a uniform end-to-end improvement. The full gate passed 34 Rust and 148 Bun/workerd tests (182 total), with 2,565 Bun assertions, strict TypeScript/Effect/tsgo and native/WASM Clippy.

The 5,183-document, 300-query SciFact report remained byte-identical to the reference (SHA-256 `9dbe36ba7a85f61312f089c631c4b0dc134e6e876796921ae8206e270415cb28`). No ranking-quality change was observed.

Alchemy production deployment and the unconditional metadata migration completed successfully. Native before/after/repeated-after runs used 128 requests at each concurrency in the unchanged million-document, 200-segment corpus. All 1,152 edge responses matched strong rows/scores and acknowledged sequence 2,000. Common/filtered page acquisition remained 22/41 blocks and 731/2,090 compressed bytes.

| Phase          | Concurrency | p50 ms | p95 ms | Requests/s |
| :------------- | ----------: | -----: | -----: | ---------: |
| Before         |           1 |  71.75 | 154.18 |      10.07 |
| Before         |           4 |  63.66 | 241.67 |      34.55 |
| Before         |          16 |  78.53 | 452.54 |      74.43 |
| After          |           1 |  52.87 | 182.91 |      11.49 |
| After          |           4 |  61.28 | 226.43 |      34.29 |
| After          |          16 |  66.59 | 863.88 |      62.35 |
| Repeated after |           1 |  50.70 |  69.57 |      17.06 |
| Repeated after |           4 |  54.89 | 389.72 |      33.48 |
| Repeated after |          16 |  68.07 | 550.12 |      57.48 |

Repeated medians improved relative to the before run, while concurrency-four/sixteen p95 and throughput worsened. Cache/isolate/network placement was uncontrolled; the before run also overlapped a separate local SciFact process on the client host. These are operational observations, not proof that the Rust change caused a native latency improvement. The repeated preparation microbenchmark demonstrates the scoped gain. Stable native tails, actual peak Worker heap and fully indexed Turbopuffer parity remain outstanding. The README reports the latest 128-request repeated phases.

### UTF-8 validation before directory JSON parsing

Cold directory construction now validates the header UTF-8 once and passes the borrowed string to the installed serde_json string reader, replacing its byte-slice reader. Framing, CRC, document ordering, version/count checks, document frequencies and posting interval validation remain active. No header format, cache key/budget, scoring arithmetic or storage ownership changes. Invalid UTF-8 is rejected even with a valid CRC; the new WASM test also verifies a valid Unicode attribute filter. The clean full gate passed 34 Rust and 149 Bun/workerd tests (183 total), with 2,569 Bun assertions and all strict lint/typecheck targets.

Two alternating WASM constructor comparisons used 128/5,000-document dense/sparse/Unicode fixtures, six excluded warmup pairs and thirty measured pairs. Only directory construction is timed; release occurs afterward. Both variants retained the same charged heap estimates, term summaries, eligible minima, posting spans and final rows/scores. Low-level fixtures include nested attributes accepted by the engine. These are parsing measurements without R2/network acquisition.

| Documents | Fixture | Header bytes | First before/after ms | Repeated before/after ms |
| --------: | :------ | -----------: | --------------------: | -----------------------: |
|       128 | dense   |        21778 |         0.263 / 0.255 |            0.259 / 0.261 |
|       128 | sparse  |        61096 |         0.577 / 0.515 |            0.583 / 0.542 |
|       128 | unicode |        64934 |         0.577 / 0.521 |            0.576 / 0.523 |
|      5000 | dense   |       852007 |         5.409 / 4.689 |            5.542 / 4.770 |
|      5000 | sparse  |      1760174 |       13.185 / 11.910 |          13.285 / 12.135 |
|      5000 | unicode |      1905486 |       14.510 / 12.816 |          14.738 / 13.091 |

Repeated 5,000-document construction improved approximately 9–14%. The small dense control regressed 0.8%; small sparse/Unicode cases improved 7–9%. WASM increased from 704,098 to 704,753 bytes. Equal charged heap estimates are not measured peak-memory proof.

Two complete workerd comparisons used 5,000 documents compacted into one segment, scalar attributes matching the public API, fourteen alternating pairs and four excluded warmup pairs. Namespace rebuild clears decoded directories before every timed query; immutable Worker/Cache API storage may remain warm. Rebuild/ingestion/compaction are outside timing. The corrected runs checked all 336 complete responses for identical rows/scores and sequence five. The repeat reversed worker creation order.

| Fixture | Filtered | First before/after ms | Repeated before/after ms |
| :------ | :------- | --------------------: | -----------------------: |
| dense   | false    |         29.18 / 28.32 |            28.44 / 26.42 |
| dense   | true     |         38.43 / 36.95 |            39.36 / 38.98 |
| sparse  | false    |         33.28 / 33.36 |            38.67 / 34.84 |
| sparse  | true     |         42.01 / 48.21 |            50.81 / 45.81 |
| unicode | false    |         36.18 / 32.46 |            31.44 / 29.26 |
| unicode | true     |         40.76 / 42.96 |            41.84 / 43.13 |

Five repeated cases improved 1–10%; Unicode filtered regressed 3.1% after a 5.4% initial regression. Initial sparse filtered also regressed 14.7%, then improved 9.9% on repetition. The consistent scoped result is faster construction for large tested directories; these full-path results do not prove a gain for every query or native Worker CPU. Cold snapshot/directory I/O and native tail stability remain separate work.

The 5,183-document, 300-query SciFact report remained byte-identical to the reference (SHA-256 `9dbe36ba7a85f61312f089c631c4b0dc134e6e876796921ae8206e270415cb28`).

Alchemy production deployment and the unconditional Vectorize metadata migration completed successfully. Three native runs used 128 requests per concurrency in the same read-only million-document, 200-segment corpus. All 1,152 edge responses matched their strong rows/scores and acknowledged sequence 2,000. Common/filtered acquisitions stayed at 22/41 blocks and 731/2,090 compressed bytes.

| Phase          | Concurrency | p50 ms | p95 ms | Requests/s |
| :------------- | ----------: | -----: | -----: | ---------: |
| Before         |           1 |  64.60 | 271.14 |       8.64 |
| Before         |           4 |  65.20 | 286.59 |      32.23 |
| Before         |          16 |  76.62 | 710.12 |      61.27 |
| After          |           1 |  58.16 |  92.62 |      13.85 |
| After          |           4 |  70.12 | 624.88 |      25.03 |
| After          |          16 |  68.88 | 907.86 |      51.69 |
| Repeated after |           1 |  63.61 | 161.42 |      11.83 |
| Repeated after |           4 |  62.53 | 172.98 |      30.80 |
| Repeated after |          16 |  78.21 | 992.29 |      48.08 |

The repeated concurrency-sixteen p95 worsened to 992 ms from 710 ms before deployment; throughput also worsened. Concurrency-four p95 improved on repetition after regressing in the first after run. Placement, cache/isolate state and network conditions were uncontrolled. These data do not establish a native latency gain from the parser change. The accepted scoped result is faster large-directory construction in the tested WASM fixtures, with the full-path regressions recorded above. Stable native tails, measured peak Worker heap and fully indexed Turbopuffer parity remain outstanding. The README reports the latest repeated operational phases.

### Rejected snapshot payload and stream publication experiments

Revalidation currently republishes the complete point-in-time frame, including when R2 returns unchanged content. Three local workerd experiments tested reducing frame construction costs while preserving canonical R2 ownership, cache frequency, the original observation timestamp, sequence barriers and the existing binary format. None was retained or deployed. The previous runtime was restored.

Retaining a native Blob instead of the original validated byte array did not improve batched frame construction: the large fixture measured 1.82→1.85 ms per frame without consumption and 3.26→3.28 ms with consumption. A plain ReadableStream Response reduced large frame construction 1.73→0.16 ms, and construction plus consumption 3.33→2.76 ms, but that isolated result did not survive the full Cache API path. These private batched fixtures used eight frames per request, twenty-eight alternating pairs and four excluded warmup pairs in small/large and construction/consumption cases (224 requests per experiment). They do not measure provider CPU, peak memory or billing.

The full-path fixture retained a valid small or roughly 5 MiB synthetic manifest whose all-positive document Bloom enlarges the body. Each variant first queried its acknowledged sequence, then used twenty-eight sequential future-sequence requests to force unchanged-ETag revalidation. Each response retained the expected 409 sequence barrier; every variant had twenty-eight R2 reads/revalidations and zero transferred R2 body bytes. Cached payload bytes, including surrounding whitespace, remained exact. Four warmup pairs were excluded, leaving twenty-four measured alternating pairs per size. Each experiment completed 112 future-barrier responses plus four successful primers.

| Prototype                       | Small before/after ms | Large before/after ms |
| :------------------------------ | --------------------: | --------------------: |
| Retained Blob                   |           7.88 / 8.28 |         22.02 / 23.97 |
| Plain stream Response           |           6.87 / 7.80 |         22.98 / 87.67 |
| Fixed-length stream publication |           7.93 / 8.32 |         20.49 / 18.92 |

The fixed-length variant used the installed native FixedLengthStream and cancellation-aware producer lifetime. Cloudflare documents its [known-length transport contract](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/); that contract does not promise faster caching. The small path still regressed approximately 5%, while the large request-only median improved 7.6%. Those request intervals do not guarantee the background cache write has finished.

A follow-up probe attempted to include observable publication completion by reading the cache observation header after each request. It emitted results but terminated with `ERR_INVALID_STATE: Writer is not bound to a WritableStream` and connection resets during cleanup. That run is excluded from passing performance evidence; it did not establish completed-publication savings or classify a production defect. All writes were to disposable local fixtures. No native deployment or production mutation occurred in these experiments.

The retained implementation remains the original validated byte payload plus Blob frame. The next publication investigation should address how often the full manifest body must be republished, rather than infer complete-path gains from cheaper frame construction alone. Freshness and minimumSequence remain mandatory; no cache lease was extended.

### Grouped publication of unchanged snapshots

The retained Blob framing now groups Cache API publication attempts for unchanged R2 ETags within 500 ms. Revalidation itself is unchanged: every acquisition still checks canonical R2, updates only the memory snapshot with its original before-read observation, and enforces the reader's one-second age and minimumSequence. Changed content, the first attempt and clock rollback publish immediately. A small framed header determines the same byte charge; skipped attempts avoid constructing the full payload Blob. The last-attempt timestamp shares the existing bounded warm entry and disappears on eviction. No canonical format or cache namespace changes.

An older cached frame retains its original observation time; skipping publication does not extend its lease. Cache eviction, unavailability or a failed attempt may cause another isolate to miss and fetch from R2 before the next attempt. This is a tradeoff in publication frequency, not guaranteed savings for every cold-reader workload. New health fields count attempts, frame bytes offered and skips per isolate; they are not confirmed stores, network transfer or billing measurements.

The clean full gate passed 34 Rust and 150 Bun/workerd tests (184 total), with 2,587 Bun assertions. A regression checks grouped unchanged revalidations, continued future-sequence rejection, unchanged-body transfer avoidance, cache eviction/republication and immediate changed-content publication. Existing expired/future ages, body/metadata mismatches, canonical recovery, authentication and independent sequence-barrier tests remain active. Rust/WASM is byte-identical to the previous runtime, SHA-256 `511392d1524482d2f37922d4715123e6c500be9e80da0a9fe6daa37a15b69c9c`; no new ranking implementation or quality result is claimed.

Two local workerd comparisons used small and roughly 5 MiB valid synthetic manifests. Each variant had 28 forced unchanged-ETag acquisitions per size; all 224 total future-barrier responses remained 409, with acknowledged primers retaining exact rows/scores. Original cached payload bytes remained exact. Four warmup pairs were excluded from 28 alternating pairs; the repeat reversed worker creation order. Both variants made 28 R2 reads/revalidations per size and transferred zero R2 body bytes. The baseline adds only publication counters to the previous source.

| Payload | First before/after ms | Repeated before/after ms | First puts before/after | Repeated puts before/after |
| :------ | --------------------: | -----------------------: | ----------------------: | -------------------------: |
| small   |          10.74 / 9.87 |              7.16 / 5.37 |                  28 / 1 |                     28 / 0 |
| large   |         20.14 / 15.38 |            20.50 / 14.01 |                  28 / 2 |                     28 / 1 |

Large-frame bytes offered fell from 146,822,648 to 10,487,332 in the first run and 5,243,666 in the repeat. These probes force invalid future barriers to isolate revalidation; their median improvements do not establish general search latency gains.

Two further comparisons issued eight concurrent acknowledged-sequence queries per variant, 24 alternating burst pairs per size, four excluded warmup pairs and 125 ms cadence outside timing. Both completed 1,536 total queries with exact rows/scores and sequence one. The repeat reversed worker creation order.

| Payload | First burst before/after ms | Repeated burst before/after ms | First puts before/after | Repeated puts before/after |
| :------ | --------------------------: | -----------------------------: | ----------------------: | -------------------------: |
| small   |               32.30 / 32.61 |                  31.98 / 32.75 |                  13 / 6 |                     13 / 6 |
| large   |               32.49 / 31.81 |                  28.43 / 26.42 |                  13 / 5 |                     13 / 5 |

Both steady large-frame runs offered 26,218,330 bytes instead of 68,167,658. Candidate revalidations were eleven versus thirteen reference revalidations due to timing/cadence, not a changed R2-read policy; five of those eleven candidate acquisitions published. The small control regressed about 1% initially and 2% on repetition. Large burst medians improved about 2% initially and 7% on repetition. The repeated result is fewer full-frame publications; it does not prove uniform query gains, native CPU/billing savings or measured peak heap.

Alchemy production deployment and the unconditional Vectorize metadata migration completed. Three native runs used 128 requests at each concurrency in the unchanged read-only million-document, 200-segment corpus. All 1,152 edge responses matched strong rows/scores and acknowledged sequence 2,000. Common/filtered acquisitions remained 22/41 blocks and 731/2,090 compressed bytes.

| Phase          | Concurrency | p50 ms | p95 ms | Requests/s |
| :------------- | ----------: | -----: | -----: | ---------: |
| Before         |           1 |  61.08 | 261.60 |      11.22 |
| Before         |           4 |  63.59 | 546.12 |      27.53 |
| Before         |          16 |  68.75 | 910.88 |      58.24 |
| After          |           1 |  51.09 | 101.20 |      14.97 |
| After          |           4 |  51.82 | 163.52 |      39.92 |
| After          |          16 |  62.80 | 939.05 |      54.03 |
| Repeated after |           1 |  49.74 | 232.31 |      11.99 |
| Repeated after |           4 |  58.80 | 306.03 |      37.64 |
| Repeated after |          16 |  64.76 | 675.37 |      72.12 |

Repeated medians and p95 improved against the reference, but the first after concurrency-sixteen p95 worsened slightly. Placement, cache/isolate state and client/network conditions were uncontrolled; these operational observations do not establish causal native latency gains. A sampled GRU isolate after the first after run reported 39 R2 acquisitions, 37 revalidations, 21 publication attempts, 18 skips and 114,427,299 offered frame bytes, with a 5,448,863-byte retained payload and 21,795,676 charged bytes. This proves the suppression path executed natively in that isolate; it is not aggregate usage or a before/after billing comparison. Stable native tails, actual peak Worker heap and fully indexed Turbopuffer parity remain outstanding. The README reports the latest repeated phases.

### Retaining R2 provenance across identical cache rehydration

Cache rehydration previously discarded a retained R2-sourced ETag even when its validated body was byte-identical to the known origin payload. The next refresh consequently fetched and decoded the whole root again. It now retains that ETag and the publication-attempt timestamp only after matching sequence, byte length and every byte with the native [equal-buffer operation](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal). The length guard runs before the native call. No digest, Node compatibility layer or new cache metadata is introduced. Native type augmentation inherits the installed Cloudflare signature instead of hand-copying the API over the host ambient types.

The cached frame still supplies its original observation time and undergoes framing, Root Schema, sequence and age validation. Known ETags come exclusively from prior R2 reads under the same bucket/namespace key. Cold hydration without prior origin, changed payloads and equal-sequence changes still discard provenance. The next conditional R2 read must confirm the preserved tag before establishing a new observation. Strong reads, the one-second lease, canonical formats, cache budgets and ranking remain unchanged.

A regression failed against the old behavior and passed after the change, verifying that identical rehydration retains conditional reads and transfers zero origin-body bytes. Additional cases use different bytes of equal length at the same sequence and different-length whitespace; both still force a full R2 body read. The clean full gate passed 34 Rust and 152 Bun/workerd tests (186 total), with 2,607 Bun assertions and all strict lint/typecheck targets.

Two controlled workerd comparisons used small and approximately 5 MiB valid synthetic manifests, 24 alternating pairs and four excluded warmup pairs. The repeat reversed worker creation order. Private fixture-only hooks expire the memory observation and disable background refresh in both variants to isolate cached hydration followed by a foreground future-sequence probe. Setup/cache seeding is outside timing. These hooks are absent from the production bundle. Initial uncontrolled attempts had extra background acquisitions and are excluded from these isolated measurements.

All 192 hydrated responses across the two runs retained exact rows/scores and sequence one; all 192 future probes remained 409. Each variant decoded 24 cached frames and made 24 foreground R2 acquisitions per size/run. Reference acquisitions transferred the full body with zero revalidations; the candidate made 24 revalidations and transferred zero body bytes. Each large reference transferred 125,846,520 bytes; both candidates transferred zero.

| Payload | First before/after ms | Repeated before/after ms |
| :------ | --------------------: | -----------------------: |
| small   |         18.04 / 14.62 |            13.95 / 12.43 |
| large   |         38.94 / 27.16 |            39.40 / 30.25 |

A further controlled run covered equal-length changed payloads and missing origin provenance. All 192 hydrated queries and 192 future barriers retained their expected results; both variants made 24 full-body R2 reads per size/mode.

| Payload | Control   | Before/after ms |
| :------ | :-------- | --------------: |
| small   | different |   20.36 / 20.89 |
| small   | unknown   |   18.73 / 19.80 |
| large   | different |   39.66 / 40.86 |
| large   | unknown   |   37.64 / 38.86 |

Control medians regressed approximately 3–6%; the identity path improves the targeted cycle, not every query. The controlled fixtures do not establish native latency, provider CPU/billing savings or actual peak heap. Rust/WASM remains byte-identical to the prior runtime; no new ranking-quality result is claimed.

Alchemy production deployment and the unconditional Vectorize metadata migration completed. The deployed bundle excludes the private expiry/background controls. Three native runs used 128 requests per concurrency in the unchanged read-only million-document, 200-segment corpus. All 1,152 edge responses matched strong rows/scores and acknowledged sequence 2,000. Common/filtered acquisitions remained 22/41 blocks and 731/2,090 compressed bytes.

| Phase          | Concurrency | p50 ms | p95 ms | Requests/s |
| :------------- | ----------: | -----: | -----: | ---------: |
| Before         |           1 |  50.88 |  69.09 |      16.09 |
| Before         |           4 |  54.23 | 158.60 |      51.46 |
| Before         |          16 |  60.81 | 563.54 |      71.90 |
| After          |           1 |  63.29 |  94.23 |      12.90 |
| After          |           4 |  57.81 | 210.07 |      42.51 |
| After          |          16 |  68.26 | 925.82 |      50.76 |
| Repeated after |           1 |  49.07 | 146.42 |      13.54 |
| Repeated after |           4 |  52.70 | 526.45 |      30.69 |
| Repeated after |          16 |  67.64 | 844.30 |      65.40 |

Both after-run p95 sets were worse than the reference. Repeated concurrency-one/four medians improved slightly, while concurrency-sixteen worsened. Cache/isolate placement, warmup and network conditions were uncontrolled, so these data neither establish a general native latency improvement nor isolate the cause of the tail regressions. The verified improvement is avoided R2 body acquisition in the controlled identical-rehydration path. Native peak heap, stable tails and fully indexed Turbopuffer parity remain unproved.

## Reusing native Schema adapters

Query and immutable-segment adapters now retain Effect's compiled parser identity across requests. Two local alternating comparisons against the preceding bundle used 50,000 documents, eight query shapes and 100/30/8 segment layouts, reversing Worker creation order in the second run. All 2,688 responses retained exact rows, scores and sequence. Rare-query medians improved 8–28% and common-query medians 2–18%; individual filtered/phrase cells regressed up to 18%. These are local results, not production guarantees. The full gate passed 34 Rust and 152 Worker/Bun tests, with 2,607 Bun assertions, strict lint and type checks.

Alchemy deployment and the unconditional metadata migration completed. A subsequent native read-only run against the unchanged million-document corpus verified all 384 edge responses against strong rows/scores at sequence 2,000:

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  60.25 |  95.78 |      13.22 |
|           4 |  63.56 | 563.98 |      35.61 |
|          16 |  66.80 | 864.85 |      58.16 |

The README reports this latest operational run. It does not establish a native latency improvement: concurrency-one/four medians were slower than the preceding repeated run, while concurrency-sixteen p95 remained above 800 ms. Placement, cache state and network were uncontrolled. Local workerd inspector access now returns V8 heap, embedder and backing-storage measurements, but the initial one-document probe is not representative and does not prove peak memory at scale. Rust/scoring was unchanged; no new quality or Turbopuffer parity result is claimed.

## Memory observations under indexing and reads

A local workerd inspector run indexed 100,000 deterministic documents in 200 writes of 500 documents, with queues disabled and 200 uncompacted segments. Measurements were taken at 25,000-document boundaries and after query batches. GC ran automatically; the explicit inspector collection command did not respond and was excluded from the completed runs. These are sampled observations, not peak memory or a production capacity limit.

| Observed phase                           | JS used heap MiB | ArrayBuffer/string backing MiB | WASM linear memory MiB |
| :--------------------------------------- | ---------------: | -----------------------------: | ---------------------: |
| After 75,000 indexed documents           |            87.54 |                          31.92 |                  21.38 |
| After 100,000 indexed documents          |             8.45 |                          13.59 |                  26.81 |
| After 84 queries in the indexing isolate |            29.18 |                          16.56 |                  26.81 |
| After restart and 252 queries            |            45.66 |                           3.54 |                   2.44 |

The 84 queries used concurrency 1/4/16, checked sequence 200 and expected row counts. After restarting against the same persisted R2 and derived-cache fixture, four strong baselines plus all 252 edge queries retained exact rows/scores and sequence. No index writes ran in the second process. The smaller WASM footprint after restart separates this read workload from the indexing-warmed allocation history; it does not prove a leak or justify shrinking directory caches. V8 used heap fell sharply during indexing, so allocated heap capacity alone is not evidence of live retention. The memory categories may overlap and must not be summed into a billed-memory estimate. Local native-service emulation, sparse sampling and different production GC/runtime limits prevent a claim that the million-document deployment fits a measured peak budget.

A new ten-second production CPU profile of the Schema-adapter deployment was source-mapped against a byte-identical build. It contained 9.22 seconds of weighted samples, including 1.03 seconds idle, from one selected isolate. Request-body reading callbacks were the largest mapped application frames; they need a targeted comparison before attributing them to copies, Effect orchestration or native stream work. The accompanying 2,400 concurrent edge queries against the million-document corpus all matched their strong baselines. This profile and traffic run establish the next investigation boundary, not an additional latency improvement.

## Rejected query-body clone removal

A candidate consumed the original query stream in the gateway, retained its bounded bytes and constructed a replacement Request only for coordinator forwarding. Two local alternating comparisons against the deployed implementation used 50,000 documents, eight query shapes and 100/8 segment layouts, reversing Worker creation order in the second run. All 1,792 responses retained exact rows, scores and sequence. The median candidate/baseline ratios across workload cells were 1.032 and 1.008, with mixed individual gains and regressions. Removing the clone did not establish a general latency improvement and was reverted without deployment. A mapped CPU frame identifies a boundary to investigate; it does not prove that removing a particular operation will make that boundary faster.

Transport coverage now checks streamed UTF-8 queries in both consistency modes and the exact 1,900,000-byte body boundary with multibyte text. One extra byte returns 413; an accepted strong query must still reach its coordinator with the same content and return the expected rows/sequence. The existing coordinator, snapshot fallback and validation behavior remains in place.

## Sharing Rust term preparation between segment rankers

PreparedQuery now retains sorted unique term indices, BM25 scorers and repeated-token phrase order alongside the existing immutable words/statistics. Rankers share that preparation through reference counting; filters, tombstones, postings and block bounds remain segment-local. The original term order and sorted-term score addition are preserved. No storage, HTTP or WASM method contract changed.

Two alternating direct-WASM comparisons exercised one query plan across 32 rankers over a 500-document directory. Each ranker selected posting spans and finalized empty posting lists; the first ranker used local cutoff seeding and later rankers used a supplied cutoff. Plan construction was included and amortized across the 32 rankers. The second run reversed module initialization order. All 20,736 rankers retained identical serialized spans and empty results. Median amortized microseconds per ranker:

| Terms | Mode   |  Before / after | Repeated before / after |
| ----: | :----- | --------------: | ----------------------: |
|     2 | any    |   29.96 / 27.24 |           17.93 / 17.50 |
|     2 | all    |   26.40 / 24.53 |           15.71 / 14.83 |
|     2 | phrase |   24.71 / 23.34 |           14.56 / 13.71 |
|    16 | any    |   75.00 / 65.50 |           92.61 / 83.37 |
|    16 | all    |   69.91 / 61.29 |           71.94 / 66.15 |
|    16 | phrase |   65.03 / 61.36 |           70.16 / 65.92 |
|    64 | any    | 470.04 / 421.66 |         483.54 / 434.22 |
|    64 | all    | 443.06 / 438.64 |         448.18 / 418.02 |
|    64 | phrase | 431.50 / 396.10 |         445.38 / 424.56 |

These 1–13% improvements concern preparation/span selection, excluding I/O, posting ingestion and scoring populated lists. Two complete workerd comparisons used 50,000 documents, ten query shapes and 100/8 segment layouts, reversing Worker creation order in the second run. All 2,240 responses retained exact rows, scores and sequence. Median candidate/baseline ratios across workload cells were 0.992 and 1.008, with substantial individual regressions as well as gains; one common-query cell more than doubled. This does not establish a general query-latency improvement.

The full local gate passed 34 Rust and 154 Worker/Bun tests with 2,648 assertions, strict lint and native/WASM Clippy. Prepared-query lifetime tests now include reversed and repeated terms in any/all/phrase modes. SciFact retained every evaluated row/order and metric from the prior directory-decoder result on the same 5,183-document corpus and 300 judgments: nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201. The complete evaluated-array SHA-256 is `ca9bc9bd6ba7a68bb90d25b69582eda335b74d72fa45d5bbbac62e905c61bcac`. Native verification remains separate; the existing production deployment was retained while the million-document comparator was running.

## Reusing BM25 scorers during catalog-bound evaluation

The at-most-64-catalog WASM call now builds each encountered term's scorer once and reuses it across catalogs and block-bound tuples. The temporary map borrows term keys from the decoded catalogs and is released with the call. Bounds retain the same global frequencies, segment-specific eligible length minima, sorted-term sum and floating-point arithmetic. A per-catalog alternative was also measured; sharing within the complete batch was faster in eight of nine paired workload cells.

Two alternating direct-WASM runs evaluated 2/8/64 terms with 1/8/32 block tuples per term across 64 catalogs. All 96,768 returned bounds were identical to the preceding engine. The 64-term/32-block cell improved from 35.76 to 29.05 ms initially and from 27.78 to 25.30 ms on repetition. Small cells were mixed: the two-term/eight-block cell regressed 7.9% initially and improved 9.7% on repetition; the eight-term/one-block cell changed by -1.4% and +0.9%. These timings include JSON parsing and result transfer, excluding storage I/O.

Two complete workerd comparisons used 50,000 documents and verified all 448 responses for exact rows, scores and acknowledged sequence. Worker creation order was reversed in the second run. Median milliseconds:

| Segments | Query            |  Before / after | Repeated before / after |
| -------: | :--------------- | --------------: | ----------------------: |
|      100 | Eight terms      |   88.33 / 87.98 |           87.82 / 86.86 |
|      100 | Four-term phrase | 116.10 / 112.93 |         112.93 / 110.74 |
|        8 | Eight terms      |   56.79 / 54.10 |           59.45 / 62.35 |
|        8 | Four-term phrase |   92.50 / 84.94 |           93.81 / 92.92 |

Seven of eight cells improved; the repeated eight-segment/eight-term case regressed 4.9%. This establishes a bounded local improvement, not a general native latency guarantee. The full gate passed 155 Worker/Bun and 34 Rust tests with 2,650 assertions and strict lint/Clippy/type checks. Golden bounds cover missing/zero/out-of-range frequencies, filtered length clamps, absent eligibility and an empty namespace. The 300-query SciFact evaluated array and metrics remained identical to the preceding term-preparation result. Both Rust optimizations still awaited native verification during the operational measurement below.

## Million-document operational comparison with a remaining WAL tail

A separate read-only comparison reused the existing million-document Kannin corpus at sequence 2,000 and the million-document temporary Turbopuffer namespace owned by the ongoing strict benchmark. It ran on 2026-10-15 from 06:08:21 to 06:09:27 UTC, with six warmups and fifty measured sequential queries per case, top-k 10 and concurrency one. Every iteration ran Kannin strong, Kannin edge and Turbopuffer strong. Kannin responses came through GRU; Turbopuffer used aws-sa-east-1. No data or deployment changed. The confirmed active Kannin version was `9147bbc6-c7e6-4734-8b45-13a6b78bf659`, preceding both local Rust optimizations above.

| Query     | Kannin strong p50 / p95 ms | Kannin edge p50 / p95 ms | Turbopuffer strong p50 / p95 ms |
| :-------- | -------------------------: | -----------------------: | ------------------------------: |
| Rare      |            159.23 / 170.42 |            39.80 / 70.60 |                   59.55 / 60.91 |
| Selective |            163.56 / 176.43 |            43.07 / 68.48 |                   58.93 / 60.14 |
| Common    |            173.06 / 181.16 |            54.98 / 87.11 |                   80.67 / 81.82 |
| Filtered  |            168.42 / 173.50 |            49.67 / 79.42 |                   76.36 / 77.35 |

All 448 Kannin responses, including warmups, matched exact strong rows/scores and sequence. Edge still uses snapshots younger than one second at selection and an acknowledged sequence barrier; its consistency contract differs from strong reads. Turbopuffer metadata reported one million rows and an up-to-date index, while every measured query reported 14,500 unindexed WAL rows, or 1.45% of the corpus. Its native explanation showed FetchBM25 with unindexed WAL identifiers excluded from that indexed branch. The strict driver's approximately-five-second readiness probes continued during this operational run. These conditions and limited samples prevent a fully indexed or general parity claim; the operational data do not satisfy or replace the strict driver's zero-unindexed gate. Ranking checks compare Kannin edge with Kannin strong; Turbopuffer contributes separate latency and telemetry. The strong-hop cost and variable tails remain material limits.

## Native Rust deployment and dense-query limit

The strict million-document comparator terminated after 360 readiness probes with 14,500 unindexed WAL rows still reported. Its temporary namespace deletion was confirmed. No fully indexed comparison was produced. Alchemy subsequently deployed both Rust scorer-sharing optimizations and completed the unconditional metadata migration; the confirmed active version was `6e9bef6d-1c25-4a55-9791-f7bef8433df4`.

The standard read-only million-document workload passed all 384 edge/strong row, score and sequence checks, with 128 requests at each concurrency:

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  51.27 |  80.69 |      16.23 |
|           4 |  53.60 | 145.97 |      42.28 |
|          16 |  62.62 | 758.61 |      80.21 |

These operational values update the README's standard-workload table. They do not isolate the Rust change from placement, cache state or network variation, and the concurrency-sixteen tail remains large.

A separate dense eight-term/phrase load failed before its concurrency phases: its first strong baseline returned 503 after approximately 132 seconds. Native telemetry showed a normal application outcome, approximately 2,516 ms coordinator CPU and an application rejection at immutable range acquisition. The original diagnostic discarded the upstream response status, so the underlying service failure remains unclassified. Two subsequent strong probes returned correct results at sequence 2,000:

| Query            | Elapsed ms | Directory/ranker preparation ms | Posting acquisition ms | Selected spans | Selected blocks | Posting bytes |
| :--------------- | ---------: | ------------------------------: | ---------------------: | -------------: | --------------: | ------------: |
| Eight terms      |     61,650 |                          13,482 |                 47,274 |          1,600 |          54,653 |     3,335,715 |
| Four-term phrase |     36,932 |                           9,992 |                 26,142 |            800 |          31,792 |     2,565,337 |

Each probe scored all 200 segments. These elapsed intervals include I/O; frozen native timers do not measure scorer CPU. The successful probes do not establish dense-query stability. A separate tiny native fixture confirmed identical-body strong queries and metadata reflected successive writes at sequences one and two; deleting both fixture records returned sequence three and zero rows. This tested freshness without a minimumSequence barrier and left no searchable fixture documents.

## Grouping nearby posting spans

The query reader now groups neighboring requested spans before its four-way acquisition windows. Each merged range is at most 1 MiB, with at most 4 KiB of additional gap bytes across the complete group. Larger existing single spans retain their previous limit. Only requested block slices enter Rust, preserving their original per-term order and CRC/row/position validation. Server-Timing retains logical spans/blocks and additionally reports grouped ranges; its byte count includes admitted gaps. Failed range responses now retain the upstream HTTP status and Ray ID in server-side rejection diagnostics, while the public error body remains unchanged.

A deterministic 5,000-document segment matching the million-document layout demonstrated why zero-gap merging was insufficient: the eight-term query retained eight ranges. A 4 KiB total-gap budget reduced it to one range, increasing posting bytes from 16,519 to 20,382. The phrase geometry reduced four ranges to two, increasing bytes from 12,661 to 16,307. This is a bounded transfer/request tradeoff, not fewer transferred bytes.

Red/green native-workerd regressions reduced a six-term fixture from ten total range acquisitions to five, including header and result-document reads. Tests separately cover nearby pruned spans, gaps beyond the budget, crossing the old four-term window, any/all/phrase equality and warm reuse. Seven existing exact I/O assertions were reduced by one without changing row/score assertions. The full gate passed 157 Worker/Bun and 34 Rust tests with 2,663 assertions. The snapshot-provenance fixture now always changes its selected hexadecimal digit, eliminating a one-in-sixteen chance of substituting the same byte.

Two alternating complete local comparisons over 50,000 documents retained all 448 exact rows/scores/sequence responses. Worker creation order was reversed on repetition. Median milliseconds:

| Segments | Query            |  Before / after | Repeated before / after |
| -------: | :--------------- | --------------: | ----------------------: |
|      100 | Eight terms      | 105.93 / 101.51 |           95.04 / 86.14 |
|      100 | Four-term phrase | 130.31 / 124.94 |         121.44 / 119.38 |
|        8 | Eight terms      | 134.16 / 143.81 |           61.25 / 59.14 |
|        8 | Four-term phrase | 114.33 / 113.52 |           93.30 / 89.68 |

Seven cells improved; one regressed 7.2%. Acquisition counts in representative after responses fell from 800 logical spans to 100 grouped ranges and from 64 spans to nine ranges. SciFact retained the complete prior 300-query evaluated array and metrics. Native verification after deployment returned exact strong rows/scores at sequence 2,000 in 40,118 ms for eight terms and 33,736 ms for the phrase. Grouped acquisitions fell to 221 and 402 ranges, with 4,116,967 and 3,296,896 posting bytes respectively. These individual probes improved on the preceding 61,650/36,932 ms observations but were not controlled latency comparisons. Both edge probes still returned 504 at the existing 30-second deadline. Grouping therefore did not resolve dense-query latency.

## Overlapping dense segment acquisition

Ranking evaluates the first four prioritized segments sequentially to establish the cutoff, then evaluates windows of at most four eligible segments against the cutoff at the start of each window. Immutable header acquisition and posting ranges share four query-local permits. Each ranker still validates its own postings and applies its own tombstones/filters; the window merges exact segment top-k results before selecting the next. A cutoff that has not yet incorporated another result from the same window can admit extra work but cannot exclude a winning row. Preparation and acquisition counters now sum overlapping segment intervals; `text_rank` remains elapsed wall time.

A 432-document regression compares ten-segment and compacted layouts with identical mutation histories across 36 combinations of phrase order, any/all/phrase mode and top-k 1/17/100. Rows, scores, revisions and sequence remain exact after updates/deletes. The existing equal-score priority and posting-pruning I/O assertions also pass unchanged.

An initial prototype used a one-segment sequential prefix. Its alternating 50,000-document workerd comparison retained all 224 exact row/score/sequence responses. Median before/after milliseconds were 82.05/82.52 for eight terms across 100 segments, 113.02/111.16 for the corresponding phrase, 56.42/57.16 for eight terms across eight segments and 90.25/103.40 for the eight-segment phrase. These local values show overhead, including a 14.6% regression in the last cell, rather than a general latency improvement. The optimization targets the separately observed native I/O waits. The complete gate passed 158 Worker/tooling and 34 Rust tests with 2,700 Worker assertions, strict type-aware lint, native/WASM Clippy and Effect compiler checks.

The one-segment-prefix prototype was deployed as version `2a3b9e3d-f189-4be7-9860-89a85ba56200`. Four native million-document probes retained the exact prior row digests, scores and sequence 2,000. Eight terms took 9,826 ms strong and 21,930 ms edge; the phrase took 10,279 ms strong and 22,973 ms edge. Both edge probes completed within the unchanged 30-second deadline. These observations do not isolate the implementation from cache variation: the strong eight-term query recorded 632 Worker Cache hits and one miss, versus 408 hits and 225 misses in the preceding grouped-span probe. Native dense-query stability and controlled speedup remain unproven. All 300 SciFact evaluated rankings and metrics remained identical.

The same prototype's standard 384-response native load remained exact, but common queries acquired 102 blocks across four segments instead of the earlier 22-block acquisition. The standard p50/p95 was 55.87/537.11 ms at concurrency one, 59.64/173.64 ms at four and 62.03/783.35 ms at sixteen. This exposed excess speculative work before a tighter cutoff became available. The final four-segment sequential prefix addresses this: a deterministic 10,000-document/20-segment regression retains two scored segments, ten blocks and the exact top ten IDs. Dense queries retain parallel windows after that bounded prefix. The following native measurements cover this adjustment.

The four-segment-prefix revision passed the full gate: 159 Worker/tooling tests, 34 Rust tests and 2,725 Worker assertions. A second alternating local comparison, with reversed Worker creation order, retained all 224 exact responses. Before/after medians were 84.73/91.65 ms for eight terms across 100 segments, 115.41/115.57 ms for the phrase, 114.58/102.17 ms for eight terms across eight segments and 157.41/117.49 ms for the eight-segment phrase. These mixed timings remain insufficient to claim a local latency win.

Alchemy deployed that revision as `8f89b7aa-7e7c-42f8-9ae8-def88032fcf1`. The four native probes again retained exact rows, scores and sequence 2,000: eight terms took 9,695 ms strong and 6,975 ms edge; the phrase took 8,902 ms strong and 6,437 ms edge. All returned HTTP 200. Regional cache warming differs across these observations and the preceding deployment; these are operational observations, not a controlled speedup. Both implementations retain the same grouped range geometry and posting bytes. The coordinator counter after initialization and the strong eight-term probe reported 713,195,952 total range bytes, including 4,116,967 posting bytes, through 633 acquisitions. That probe lacked a before-query counter and therefore did not isolate query-only acquisition. These counters include internal Worker Cache responses and do not count billed R2 origin reads. Large full-directory transfers remain a major unresolved cost; parallelism does not reduce those bytes. Cold dense failures and larger concurrent dense loads remain unproven.

The final revision's first standard native load completed the 128-request concurrency-one and concurrency-four phases with exact results (p50/p95 59.91/246.60 ms and 57.49/317.96 ms). Its concurrency-sixteen phase failed on a common `cloudflare rust` query with HTTP 504 at the unchanged 30-second edge deadline. Telemetry showed a normal application outcome, 30,213 ms wall time and 118 ms CPU, without a memory/CPU-limit outcome. The trace contained the gateway invocation and its application deadline log but did not identify the stalled internal acquisition. This is an unresolved I/O-wait observation, not a classified provider defect.

One complete repetition passed all 384 strong-baseline row/score/sequence checks. The first failed run remains part of the result; the repetition does not establish concurrent reliability. The sequential prefix restored native common/filtered acquisition to 22/41 blocks and 731/2,090 posting bytes. The README reports the latest complete run:

| Concurrency | p50 ms | p95 ms | Requests/s |
| ----------: | -----: | -----: | ---------: |
|           1 |  49.34 |  85.28 |      15.28 |
|           4 |  53.07 | 216.97 |      41.20 |
|          16 |  63.78 | 831.54 |      58.43 |

The final revision's SciFact run also retained the complete prior evaluated array and all metrics for 5,183 documents and 300 queries. Native controlled A/B latency, dense-query concurrency, peak memory, the common-query timeout and general Turbopuffer parity remain unresolved. No GitHub push was retried during the reported GitHub outage.

## Compressed immutable directory acquisition

Directory reads use a versioned compressed representation in the existing internal Segments entrypoint and immutable caches. Canonical R2 segment bytes, row metadata, term dictionaries and posting/document offsets remain unchanged. The Rust frame records decoded length and CRC, bounds inflation to the manifest's expected header size and 16 MiB, and validates the original canonical header after decompression. Raw document/posting range identities remain unchanged; a format suffix separates compressed headers while preserving namespace invalidation and pending-acquisition sharing. Encoded buffers share the existing 12 MiB range/frequency budget; decoded directory charge remains capped at 40 MiB.

A representative 5,000-document/5,107-term segment had a 1,747,057-byte canonical header. Its Rust/WASM representation used 125,983 bytes, a 92.8% reduction. A single cold codec probe took 36.5 ms to validate/compress; this excludes remote I/O and does not establish typical compression CPU. The native Rust roundtrip retains the complete header. Regression cases reject truncation at every encoded length, changed magic/length/checksum/compressed bytes, oversized or mismatched lengths, inflation beyond the declared bound and a valid outer checksum around a corrupt canonical header. The workerd cache regression confirms the cached compressed frame and unchanged R2 magic; external access remains denied. Existing range counts and ranking assertions pass unchanged.

The full gate passed 159 Worker/tooling tests and 36 Rust tests with 2,730 Worker assertions, strict type-aware Effect lint, Effect compiler checks and native/WASM Clippy. One alternating 50,000-document workerd comparison retained all 224 exact row/score/sequence responses. Median before/after milliseconds were 85.70/82.03 for eight terms across 100 segments, 113.88/110.82 for the phrase, 59.87/59.83 for eight terms across eight segments and 99.12/97.14 for the eight-segment phrase. These local observations do not establish native latency or parity. A separate regression accepts a directory larger than the independent 2 MiB mutation-log budget. SciFact retained all 300 evaluated rankings and metrics for 5,183 documents, with the same evaluated-array digest as the preceding revision. Native verification and the unresolved concurrent timeout remain separate gates.

Alchemy deployed the compressed-directory revision as `9c034291-7a73-403d-bc4f-e4b70cf6391c`. Both rounds of four native million-document probes returned HTTP 200 with exact prior row digests, scores and sequence 2,000:

| Query            | First strong / edge ms | Repeated strong / edge ms |
| :--------------- | ---------------------: | ------------------------: |
| Eight terms      |         5,884 / 24,377 |             6,001 / 9,356 |
| Four-term phrase |          5,828 / 4,983 |             5,630 / 7,892 |

These cache states were not controlled. The first edge observation remains close to the unchanged 30-second deadline; neither warm latency nor dense concurrency is established. The new probe records coordinator counters before each strong query. Initialization had already acquired 200 ranges and 26,539,390 encoded bytes. The eight-term query's delta was 433 acquisitions and 31,026,960 bytes in both runs; the phrase delta was 612 acquisitions and 29,837,807 bytes. The counter after initialization and the first eight-term query was 57,566,350 bytes across 633 acquisitions, versus 713,195,952 bytes across 633 in the preceding raw-directory deployment: 91.9% fewer acquired payload bytes at that aggregate checkpoint. The older checkpoint lacked a before-query counter, so 713 MB was not an isolated query transfer. These counters include internal Worker Cache responses, exclude other transports and do not identify billed origin operations or actual physical network bytes.

Two standard native loads completed all 768 row/score/sequence checks, without reproducing the preceding revision's concurrency-sixteen timeout. The original failure remains unresolved; this repetition is not a stability guarantee. Median/p95 milliseconds and requests per second:

| Concurrency | First p50 / p95 ms | First requests/s | Repeated p50 / p95 ms | Repeated requests/s |
| ----------: | -----------------: | ---------------: | --------------------: | ------------------: |
|           1 |     57.65 / 173.88 |            12.37 |         49.51 / 73.90 |               17.62 |
|           4 |     58.30 / 187.47 |            45.61 |        52.66 / 210.53 |               48.39 |
|          16 |     55.66 / 707.73 |            62.78 |        69.39 / 685.70 |               67.69 |

The README reports the repeated run and both its preceding failure context and dense-probe spread. No controlled native speedup, peak-memory capacity, concurrent dense-query guarantee or Turbopuffer parity is claimed. The complete compressed namespace exceeds the current shared twelve-MiB range/frequency LRU, so repeated header acquisition remains a candidate for further measured optimization.

An additional provider-backed vector/hybrid recheck created three synthetic vector documents in a separate owned namespace. The native synchronization accepted three submissions, but the unfiltered vector query remained empty through sixty visibility attempts; the filtered/hybrid checks therefore did not execute. This does not classify the underlying cause or validate current provider visibility. Cleanup wrote the three deletions and synchronized their vector jobs. A separate persisted-state read confirmed sequence four, zero live documents and zero vector-outbox entries. Historical R2 logs/receipts remain retained by contract. No benchmark-corpus records changed. Earlier native vector evidence remains historical; the README now identifies current provider-backed validation as pending.

## Protecting encoded directories from posting pressure

The initial 28/20/4 MiB split for encoded directories, decoded admission and ranges/frequency pages was rejected. Although it preserved the 52 MiB sum, a paired local comparison regressed the 100-segment eight-term median from 84.60 to 241.85 ms and the eight-segment equivalent from 115.02 to 238.28 ms. Four MiB was insufficient for the converted frequency-page working set.

The selected policy retains twelve MiB for raw ranges/frequency pages and twenty MiB for decoded admission. Its twenty-MiB encoded pool reserves one MiB for access history and nineteen MiB for charged frames. At capacity, a candidate replaces residents only when its count exceeds all required victims; otherwise acquisition still returns the canonical frame without admission. Counters saturate at 255 and age every 4,096 lookups, while their own LRU byte cap bounds history. Namespace invalidation removes history and frames. This avoids admitting every member of an oversized scan and repeatedly evicting the next header needed. The individual decoded-directory validation ceiling remains forty MiB; entries above admission remain usable through their scoped handle. Raw buffers now charge key/entry overhead, with payload bytes reported separately.

Red/green workerd regressions demonstrate zero extra header acquisitions after sixteen MiB of raw-range pressure (previously one), and retention of a hot subset across three oversized scans (plain LRU reacquired all ten objects despite retaining nine). Further cases verify aging removes cold history without extra acquisitions, full uncached sixteen-MiB raw reads, and valid decoded directories above twenty MiB. The gate passed 164 Worker/tooling and 36 Rust tests with 2,763 Worker assertions, strict Effect/Oxlint, Effect compiler checks and native/WASM Clippy. All 300 SciFact evaluated rankings and metrics remained identical.

A final alternating local comparison retained all 224 exact rows/scores/sequence responses. Median before/after milliseconds were 93.33/100.23 for eight terms across 100 segments, 125.97/132.87 for the phrase, 59.07/62.52 for eight terms across eight segments and 115.65/118.87 for the eight-segment phrase. These 2.8–7.4% regressions are retained in the record. No general latency improvement is inferred from cache-hit counters or unchanged quotas.

Runtime `68bd17c` deployed as native version `c9233250-2725-449b-b4b8-37231644c22d`. A standard million-document run verified all 384 edge responses against strong baselines at sequence 2,000. Concurrency 1/4/16 p50 was 49.09/54.09/66.81 ms, p95 was 105.57/722.42/706.64 ms and throughput was 16.06/26.87/59.82 requests/s. Compared with the preceding compressed-directory repeat, concurrency-four p95 rose from 210.53 to 722.42 ms and throughput fell from 48.39 to 26.87 requests/s. Native cache state, placement and network variation were uncontrolled.

Two immediately consecutive rounds each queried eight terms and a phrase under strong and edge consistency. All eight responses preserved exact rows, scores and sequence. Strong eight-term latency was 5,852.18 then 5,217.79 ms; strong phrase latency was 5,147.95 then 6,382.38 ms. Edge latencies ranged from 5,494.56 to 6,141.42 ms. Coordinator counter snapshots around each strong query showed eight-term acquisitions falling from 431 / 30,657,870 bytes to 295 / 10,934,111 bytes, while phrase acquisitions remained 476 / 10,114,048 bytes in both rounds. The encoded cache retained 136 entries. These counters include acquired cached bodies, not independently measured origin or billed bytes. Retention reduced repeated acquisition without resolving multi-second dense ranking.

Two earlier independent four-query runs also returned exact results, but each began with empty coordinator caches; they are not warm-repeat evidence. Their strong latencies ranged from 4,892.00 to 5,793.12 ms and edge latencies from 7,356.26 to 9,278.15 ms. The continuous rounds above avoid interpreting an idle coordinator's empty cache as an admission-policy failure. These samples do not establish concurrent dense-query reliability, peak memory or Turbopuffer parity. Current native Vectorize visibility validation remains pending as described above.

## Learned conservative segment score bounds

Dense repeated selections now retain a bounded score upper bound per immutable segment. The key includes physical bucket, immutable object/header identity, exact tombstones and a SHA-256 of the complete ranking selection and computed global statistics. Top-k is excluded by normalizing its encoded value to one. After each segment, the retained upper bound is the maximum of returned scores and the external cutoff that omitted posting pages. Using only returned scores would be unsafe: omitted rows may still score up to that cutoff. Later queries combine the learned bound with the catalog bound and preserve the original tolerance and ID tie ordering. They still acquire the current manifest and materialize current result rows. No HTTP result or root authority is memoized.

Admission applies only when more than four segments are candidates. Its one-MiB charged LRU comes from the encoded-directory budget, leaving eighteen MiB of encoded frames, one MiB of directory history, twenty MiB decoded and twelve MiB ranges/frequency pages: the same fifty-two-MiB cache quota sum. Namespace rebuild clears learned entries; process eviction loses them. Neither these quotas nor the measurements establish total Worker peak memory.

A red/green workerd case repeatedly ranked twelve segments before the change and one afterward with identical rows and scores. Other regressions compare top-k 1/10/100, filters, any/all/phrase, mutations and tombstones after a successful namespace cache rebuild. A separate 1,280-document reference uses three segments while the tested index uses eight, crossing posting-block boundaries; strong and edge results preserve IDs, scores, documents and each layout's expected revisions. Distinct selections fill and evict the bounded cache, then a successful rebuild verifies namespace removal.

A paired alternating comparison used 50,000 documents, first with 100 segments then eight. Fourteen pairs each ran two queries per variant, with the first three pairs excluded from medians. All 224 responses retained exact rows, scores and sequence. These are warmed repeated selections, not cold requests:

| Segments | Query       | Before median ms | After median ms |
| -------: | ----------- | ---------------: | --------------: |
|      100 | Eight terms |            87.31 |           19.10 |
|      100 | Phrase      |           120.13 |           17.87 |
|        8 | Eight terms |            57.97 |           26.75 |
|        8 | Phrase      |           105.95 |           36.37 |

The last measured 100-segment repetitions visited eight segments for eight terms and three for the phrase, versus all one hundred before. Eight-segment repetitions visited two segments for either query. This optimization does not establish improvement for new selections, expired processes, concurrent tails, native vector search or Turbopuffer parity.

The full gate passed 167 Worker/tooling tests and 36 Rust tests, including 3,199 Worker assertions, strict Effect/Oxlint, the Effect compiler and native/WASM Clippy. An independent SciFact run retained all 300 evaluated rankings and metrics exactly: nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201 over 5,183 documents.

Runtime `35fca48` deployed successfully as native version `bdf60166-0460-43b0-9c09-c04da81dd3f0`, including the unconditional Vectorize metadata migration. The first measured strong eight-term and phrase requests took 5,798.58 and 4,916.01 ms and ranked 200 segments. Their immediately repeated strong requests took 354.49 and 252.66 ms and ranked three segments, with exact pre-existing million-document IDs/scores at sequence 2,000. Strong eight-term acquired bodies fell from 394 / 22,999,568 bytes to 4 / 101,678 bytes; the phrase fell from 485 / 11,072,225 to zero acquisitions. The initial bound cache was empty; it retained 400 entries charging 423,496 bytes after both selections. Other initial cache states were uncontrolled. Acquisition counters include cached bodies rather than independently measured origin or billed traffic.

Five further sequential repetitions per query/consistency retained all twenty responses exactly. Together with the initial eight, all 28 probes passed. Strong eight-term median/min/max was 1,192.39 / 772.51 / 1,685.25 ms; phrase was 885.20 / 312.25 / 1,208.03 ms. Edge eight-term was 835.71 / 632.52 / 1,209.34 ms; phrase was 956.61 / 422.05 / 1,635.96 ms. Every repeated strong request still ranked only three segments with zero new range acquisitions. However, directory-stage durations reached 1,406 ms: strong queries missed 24–40 term catalogs despite 160–176 memory hits per query, keeping their roughly four-MiB term cache near capacity. Zero ranking duration in the native clock does not establish zero CPU. These observations identify catalog acquisition as the next warm-query bottleneck rather than proving uniform subsecond latency.

A subsequent standard native load verified all 384 responses against strong baselines. Concurrency 1/4/16 p50 was 50.81/53.60/62.77 ms, p95 was 69.54/139.96/843.27 ms and throughput was 17.32/51.49/60.05 requests/s. Against the immediately preceding admission run, concurrency-four p95 improved from 722.42 ms but concurrency-sixteen p95 regressed from 706.64 ms. Placement, cache state and network variation were uncontrolled; these runs do not prove concurrent dense-query reliability, cold-query improvement or general Turbopuffer parity. Current provider-backed Vectorize visibility remains unverified.

## Reusing compact text plans

Repeated dense queries had already fallen from 200 ranked segments to three, but five native strong repetitions still missed 24–40 term catalogs per query. Directory-stage acquisition took up to 1,406 ms even with zero new range acquisitions. A compact text plan now retains global statistics and per-segment eligibility/catalog bounds, bypassing those catalogs when the complete selection and scoring inputs remain unchanged.

The process LRU charges at most one MiB, borrowed from encoded directories. The cache quota sum remains fifty-two MiB: seventeen encoded frames, one directory history, one learned score bound, one text plan, twenty decoded directory and twelve range/frequency MiB. Plan identity includes the physical bucket, immutable selected segment keys/header lengths, exact tombstones/removed frequencies, text, mode, filters and current live document/title/body totals. It excludes top-k and includes segment content identity rather than relying on manifest sequence. A compaction can change segments without changing sequence; an unrelated document can change global scoring totals without joining the selected segments. Both must invalidate planning. Fresh manifest acquisition and minimumSequence checks precede lookup, and result rows still come from current canonical segments.

The gate passed 169 Worker/tooling and 36 Rust tests with 3,769 Worker assertions, strict Effect/Oxlint, the Effect compiler and native/WASM Clippy. Regressions cover same-sequence compaction, changes outside selected segments, filters/modes, tombstones, top-k changes and unmet sequence barriers. A 256-selection, 64-term workload forces actual eviction within the one-MiB charge and verifies exact recomputation of the oldest selection. Namespace rebuild removes plan entries. Existing first-use catalog-batch assertions remain; repeated queries now assert one plan hit, no catalog requests and no catalog-memory lookups.

The alternating 50,000-document comparison retained all 224 exact rows/scores/sequence responses. It used fourteen pairs with two repetitions per variant, discarding the first three pairs. Both implementations already have learned score bounds; only the new implementation retains compact plans. The small warmed local differences are not evidence for cold-query improvement:

| Segments | Query       | Before median ms | After median ms |
| -------: | ----------- | ---------------: | --------------: |
|      100 | Eight terms |            19.89 |           15.20 |
|      100 | Phrase      |            13.48 |           13.21 |
|        8 | Eight terms |            25.93 |           23.14 |
|        8 | Phrase      |            36.97 |           35.25 |

The independent SciFact evaluation retained all 300 evaluated rankings and metrics over 5,183 documents exactly: nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201.

Runtime `917af5e` deployed successfully as native version `ab9ed5e1-cc58-492c-97c0-37a95832a2df`; the unconditional Vectorize metadata migration also completed. The first measured eight-term/phrase strong selections took 6,087.58/5,360.56 ms and ranked 200 segments. First edge selections took 10,055.80/8,930.87 ms. Their immediate strong repetitions took 259.75/196.18 ms and ranked three segments; edge repetitions took 401.02/306.96 ms. These measurements do not demonstrate cold improvement.

Five further repetitions per case/consistency retained all twenty responses exactly. With the initial eight, all 28 dense responses preserved pre-existing million-document IDs/scores and sequence 2,000. Strong eight-term median/min/max was 200.45 / 186.94 / 227.16 ms; phrase was 209.91 / 203.52 / 297.30 ms. Every repeated strong query used one plan hit, zero catalog reads/requests and three ranked segments. The two retained plans charged 78,948 bytes. Compared with the preceding revision's five strong repetitions, medians fell from 1,192.39 and 885.20 ms. The separate deployments did not control placement, cache state or network variation.

Edge eight-term median/min/max was 263.32 / 76.35 / 9,776.58 ms; phrase was 287.57 / 128.98 / 8,570.74 ms. Three of ten edge repetitions ranked all 200 segments again rather than reusing learned pruning; another such phrase execution took 5,306.56 ms. These observations establish that retained score pruning did not apply on those requests. They do not independently establish whether text plans hit or why learned score bounds were unavailable. Process eviction, isolate selection and unrelated cache pressure were not independently classified. The process-only cache therefore does not establish uniformly fast edge repeats. New selections and lost retention remain priority bottlenecks; native zero-duration directory/ranking stages do not prove zero CPU.

A subsequent standard native load verified all 384 responses against strong baselines. Concurrency 1/4/16 p50 was 54.67/51.63/58.63 ms, p95 was 175.86/145.93/591.15 ms and throughput was 11.60/45.06/93.30 requests/s. The preceding revision measured p95 69.54/139.96/843.27 ms and throughput 17.32/51.49/60.05 requests/s: concurrency-sixteen improved, while concurrency-one tails and throughput regressed. These bounded runs do not prove concurrent dense-query reliability, peak memory, provider-backed vector visibility or general Turbopuffer parity.

## Sharing versioned conservative plans through Cache API

Compact process plans removed repeated catalog reads, but prior native edge samples returned to 200-segment ranking three times out of ten. Their underlying retention failure was not classified. The plan can now recover from Cloudflare Cache API, scoped by the complete current planning identity and the native Worker version metadata binding. After ranking, learned conservative maxima tighten aligned catalog bounds; pages omitted by an external cutoff remain covered by that cutoff. Current manifests, authorization, sequence barriers and canonical row materialization remain in their existing owners.

A plan is published only for a new selection or a strictly improved bound vector. Rust compression/checksum frames cap encoded JSON at one MiB and compressed data at 256 KiB; the Cache API lifetime is one hour. Readers verify bounded lengths, framing/CRC, the concrete Schema, selection identity, Worker version, segment count and live document/title/body totals. Malformed or unavailable entries fall back to the original catalog path. A successful put is awaited before returning; its timing is separate from ranking. Request-local Server-Timing identifies memory/shared/miss/bypass and learned-bound hits. No full response rows or root authority are cached.

The gate passed 170 Worker/tooling tests and 36 Rust tests with 3,815 Worker assertions. A persistent native workerd fixture proves a fresh process recovers the shared plan, issues zero catalog requests and ranks one segment rather than twelve. Before the change, the same restart fixture ranked twelve segments again after having ranked one while warm. CRC corruption, wrong identity/version, mismatched segment count/statistics and a negative bound all recover exact results through canonical acquisition. A new simulated deployed version misses the prior plan. Local restart tests use a stable version-shaped fixture; deployment uses Cloudflare's native version binding.

The alternating 50,000-document comparison preserved all 224 rows/scores/sequence responses exactly. Fourteen pairs ran two repetitions per variant, excluding the first three pairs from medians. Before/after medians were 16.35/15.10 ms for eight terms and 11.69/11.09 ms for a phrase across 100 segments; with eight segments they were 26.84/25.28 and 38.31/36.09 ms. These are small warmed local differences, not cold-process or native tail evidence. Independent old/new SciFact reports were identical, including all 300 evaluated identifier lists and metrics over 5,183 documents: nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201. Archive, corpus and judgment checksums matched the documented source dataset.

Runtime `bf576e9` deployed successfully as native version `1428a1fc-e322-4efa-9a3e-081b38fdda87`. Alchemy attached `CF_VERSION_METADATA`, and the unconditional Vectorize metadata migration completed. Before deployment, eight read-only probes against version `ab9ed5e1-cc58-492c-97c0-37a95832a2df` preserved known deterministic rows/scores at sequence 2,000 over one million documents. Their first strong eight-term/phrase times were 6,676.75/5,628.63 ms and first edge times were 7,122.26/5,638.18 ms. Warm strong times were 277.07/211.71 ms and warm edge times 333.22/93.10 ms. Full returned rows became the exact reference for subsequent runs.

After deployment, first strong selections took 6,254.28/5,251.60 ms and first edge selections 10,478.87/8,552.95 ms, each ranking 200 segments. Native plan publication completed in 8–9 ms. These first-use samples do not demonstrate cold improvement; the edge timings regressed. Their immediate repetitions ranked three segments. Five further repetitions per case/consistency retained all twenty exact responses: strong eight-term median/min/max was 202.57 / 179.08 / 275.34 ms, and phrase 202.11 / 200.89 / 210.55 ms. Edge eight-term was 138.61 / 93.48 / 1,464.19 ms, and phrase 121.69 / 95.70 / 394.98 ms. All twenty ranked three segments; none returned to 200 in this run.

Two edge repetitions explicitly reported shared-plan recovery with zero process score-bound hits. Their client times were 1,464.19 and 394.98 ms, and both ranked three segments with exact rows/scores. The slower shared recovery spent 579 ms selecting the edge snapshot, including 164 ms in snapshot-cache work and 355 ms in R2 work; text-directory and ranking intervals were 43 and 52 ms. Those intervals do not independently classify placement or CPU. Eighteen repetitions used process memory. This proves native cross-request recovery through Cache API in these samples, rather than inferring it from low latency alone.

A subsequent standard load retained all 384 exact strong-baseline comparisons. Concurrency 1/4/16 p50 was 52.09/52.88/61.13 ms, p95 was 89.35/148.09/715.18 ms and throughput was 13.92/39.57/74.17 requests/s. The preceding process-plan revision measured p95 175.86/145.93/591.15 ms and throughput 11.60/45.06/93.30 requests/s. Concurrency-one tails improved, while concurrency-sixteen tails and throughput regressed. Cache state, placement and network variation remain uncontrolled.

A separate mixed dense load issued sixteen queries at concurrency one and sixteen at four, alternating eight-term/phrase and strong/edge contracts. Every response matched the complete pre-deploy reference and sequence 2,000 and ranked exactly three segments. Concurrency-one p50/p95/max was 209.44/318.55/1,102.91 ms with 4.30 requests/s; concurrency-four was 206.88/307.33/541.23 ms with 17.29 requests/s. Six requests recovered shared plans and twenty-six used process memory. With the initial probes and standard load, these first 444 post-deploy checks passed. This small dense sample does not establish concurrent reliability, cold/new-query speed, peak memory, provider-backed vector visibility or Turbopuffer parity. First selections and edge snapshot selection remain performance bottlenecks.

An independent sixteen-request dense burst at concurrency sixteen also matched every reference row/score and sequence and ranked exactly three segments per response. Seven requests reported shared-plan recovery and nine used memory. Client p50/p95/max was 1,099.89/1,345.90/1,381.45 ms, with 11.53 requests/s. This used a fresh client process and connection pool, unlike the sequential one/four phases, and does not isolate the cause of the higher latency. One strong response reported zero native-clock directory/ranking intervals but a 336 ms coordinator total and 1,065 ms gateway total; zero intervals do not prove zero CPU or establish where time was spent. All 460 post-deploy checks passed, including 48 dense load responses and fifteen explicitly shared-plan recoveries across dense probes/loads. Cold selections and latency under simultaneous requests remain unresolved.

## Bounded strong-read concurrency

Runtime `4af7ba0` deployed as Cloudflare version `4c9c6fbf-be26-4780-96df-48d4a932c102`, verified through the native minutei profile. The unconditional metadata migration completed. Strong queries acquire one of four query slots, capture the immutable canonical root under the mutation semaphore, then release that semaphore before search I/O. Mutations stay serialized. In-flight roots pin their segments during collection; success and backend failure release the pins and query slots. A workerd test holds the vector provider at an actual HTTP barrier, verifies that a reset and subsequent strong text read complete, and confirms that collection preserves the original query's three segments until its response completes. A second test verifies the four-query limit, failure cleanup and later collection. The full gate passed 172 Worker/tooling tests, 36 Rust tests, 3,844 assertions, Effect/Oxlint, type checks and native/WASM Clippy. The existing roughly 300-request cutoff stress test now has a thirty-second budget; its five-second timeout previously allowed unfinished work to contaminate later cache counters. All ranking assertions remain.

Read-only native probes reused the unchanged million-document, 200-segment corpus at sequence 2,000. Eight post-deploy dense probes matched the complete prior rows, revisions and scores. The first eight-term/phrase selections took 6,988.75/6,116.80 ms strong and 6,976.95/5,836.05 ms edge, ranking 200 segments. Immediate repeats ranked three. These timings do not demonstrate cold improvement.

Before and after deployment, separate dense phases issued sixteen mixed strong/edge queries at each concurrency. Every response matched the existing complete reference.

| Concurrency | Before p50 / p95 ms | After p50 / p95 ms | Before / after requests/s |
| ----------: | ------------------: | -----------------: | ------------------------: |
|           1 |     193.52 / 275.72 |    194.79 / 334.23 |               4.78 / 4.77 |
|           4 |     197.58 / 630.48 |    196.04 / 760.91 |             15.22 / 13.95 |
|          16 | 1,255.93 / 1,558.25 |  454.63 / 1,047.45 |             10.20 / 14.02 |

The sixteen-concurrency bursts each used a fresh client process and connection pool after warmup. The after burst ran without another benchmark active. Its maximum was 1,135.73 ms, against 1,561.21 ms before. It recovered three shared plans and used thirteen memory plans; the before burst recovered seven shared plans and used nine memory plans. Different cache states and uncontrolled placement/network conditions prevent attributing the latency change entirely to the lock change. Concurrency-one/four tails regressed. Strong responses in the after burst reported admission/coordinator wait of 0–69 ms and root acquisition of 0–75 ms; native clock granularity means zero does not prove zero CPU. The controlled barrier test proves removal of query/write blocking independently of these latency observations.

A later isolated standard load checked 384 edge responses against strong references: concurrency 1/4/16 p50 was 46.06/47.23/54.15 ms, p95 69.65/131.95/563.59 ms and throughput 19.64/42.76/84.79 requests/s. The prior revision's separate run measured p95 89.35/148.09/715.18 ms. An additional 400 exact checks from overlapping standard/dense probes are excluded from the comparison because their workloads overlapped. Across all post-deploy probes, all 840 measured query responses matched their references, including 72 dense responses and 768 standard responses; each standard run also acquired four strong baselines. These bounded results do not establish long-term reliability, fully indexed Turbopuffer parity, peak memory, faster first selections or real Vectorize visibility.

## Rejected wider cold-query fanout

Cold-plan investigation compared the four-read implementation with wider ranking windows while retaining the sequential first-four-segment prefix. Two local workerd comparisons each indexed 50,000 documents in 100 segments, alternated implementation order over six repetitions, and verified all 24 query responses against the other implementation. Distinct whitespace preserved query meaning while bypassing text-plan and learned-score identities; these were new-plan selections with reusable immutable data, not fully cold storage. Discarding the first repetition, window eight with four read permits regressed eight-term/phrase medians from 110.56/122.98 ms to 256.77/295.51 ms. Window six with six permits was near neutral: 91.54/118.77 ms before and 91.94/120.61 ms after. The two comparisons had different emulator/cache conditions and must not be combined into one speedup claim.

The six-read candidate `3a64223` passed the full gate and deployed as `60cc5921-ee19-46dd-9af0-2b7846e5aa89`. Read-only native probes reused the unchanged million-document corpus at sequence 2,000. Three selections per shape used exactly the same inputs before and after deployment. All rows, revisions and scores matched the persisted reference. Every selection reported a plan miss, zero learned-bound hits and 200 ranked segments. Eight-term selections requested 221 posting ranges and 4,116,967 bytes; phrase selections requested 402 ranges and 3,296,896 bytes. These are logical acquisition counters, including cache hits, not billed R2 operations. Native durations include network and cache variation; cumulative intervals across parallel tasks are not CPU measurements.

| New-plan selection | Original four-read median ms | Six-read median ms | Restored four-read median ms |
| ------------------ | ---------------------------: | -----------------: | ---------------------------: |
| Eight terms        |                     6,264.06 |           5,764.69 |                     6,635.81 |
| Phrase             |                     6,012.74 |           5,797.88 |                     6,327.98 |

The candidate's first eight-term selection regressed from 7,423.66 to 7,836.04 ms. Restored first selections were 7,982.27/6,890.81 ms for eight terms/phrase. The small per-shape samples do not establish a reliable first-use improvement. A subsequent standard load checked all 384 edge responses against strong references. The six-read candidate's concurrency 1/4/16 p50 was 55.03/55.40/77.34 ms, p95 251.55/662.72/978.80 ms and throughput 10.99/27.43/54.24 requests/s. After restoring four reads, another 384-response load measured p50 54.26/53.09/69.45 ms, p95 192.22/156.02/750.37 ms and throughput 11.35/41.86/59.54 requests/s. Both loads preserved every result. The earlier four-read run recorded p95 69.65/131.95/563.59 ms; restoration did not recover those earlier timings. These runs do not isolate placement, cache or network effects. The modest cold-plan medians did not justify retaining the wider admission alongside worse observed load and increased retained-ranker capacity.

Runtime `a19785e` restored four reads and deployed as `1def7fe1-8a57-473e-9d9c-1bf5b5e6b034`, verified through the native minutei profile. Its unconditional migration completed, and its full gate passed 172 Worker/tooling tests, 36 Rust tests, 3,844 assertions, Effect/Oxlint, type checks and native/WASM Clippy. All eighteen dense probes across original/candidate/restored runtimes and all 768 measured standard-load responses matched their references. The expanded ranking test retains thirteen fragmented segments and one subsequent revision, crossing full and partial ranking windows while checking filters, tombstones, phrase order and top-k against compaction. The final application keeps a single four-read limit for both windows and I/O. No Rust scoring or format change shipped, and no new ranking-quality, vector-recall or Turbopuffer-parity claim follows. Reducing the sequential directory/posting acquisition chain remains the next cold-query investigation.

## Bounded wider posting groups

Runtime `d7d8485` deployed as Cloudflare version `17d68549-0218-4d74-b412-b33ab57abd63`, verified through the native minutei profile after the unconditional metadata migration. The reader's total additional-gap budget per merged group increased from 4 KiB to 16 KiB. Its 1 MiB grouping cap, existing larger-single-span validation, four-read semaphore, sequential ranking prefix and cache quotas remain. Only requested block slices enter Rust. The Rust span builder's independent 4 KiB gap validation is unchanged. A new red/green workerd fixture reads two selected pages across roughly 9 KiB of unrelated postings: two acquisitions before, one after, with any/all/phrase results preserved. Separate tests keep larger gaps split and verify that multiple individually small gaps share one total budget. The full gate passed 174 Worker/tooling tests, 36 Rust tests and 3,862 assertions, plus formatting, Effect/Oxlint, type checks and native/WASM Clippy. The WASM artifact is byte-identical to the reference; no new ranking-quality or vector-recall result is claimed.

Two alternating workerd comparisons each used 50,000 documents, first as 100 segments and then compacted to eight. Six repetitions ran both implementations and both query shapes, excluding the first repetition from medians. Worker creation order was reversed for the second comparison. All 96 responses retained exact rows, scores and sequence. Whitespace variations bypassed learned plans while retaining immutable caches; these are new-plan selections, not fully cold storage.

| Segments | Query       | First before / after median ms | Reversed before / after median ms |
| -------: | ----------- | -----------------------------: | --------------------------------: |
|      100 | Eight terms |                144.12 / 161.11 |                     95.05 / 92.22 |
|      100 | Phrase      |                232.10 / 234.32 |                   119.94 / 120.97 |
|        8 | Eight terms |                  71.30 / 60.08 |                     66.38 / 74.85 |
|        8 | Phrase      |                  97.81 / 92.65 |                   101.22 / 116.90 |

Local timings include regressions and do not establish a uniform speedup. At eight segments the phrase consistently changed from seventeen grouped acquisitions and 165,371 posting bytes to eight and 199,555 bytes; eight terms changed nine/208,823 to eight/212,683. The 100-segment layouts retained the same geometry. These counters include cache hits and do not establish origin or billed-byte savings.

Native probes reused the unchanged million-document corpus at sequence 2,000. Three new-plan selections per query shape used identical inputs before and after deployment. Every response matched the complete persisted rows, revisions and scores; all reported a plan miss, zero learned-bound hits and 200 ranked segments. Cache and placement conditions were uncontrolled. The new grouping keys can miss older range caches, but individual hit receipts were not captured, so the first-use delays cannot be attributed entirely to cache filling.

| Query       | Before median ms | After median ms | Posting acquisitions before / after | Posting bytes before / after |
| ----------- | ---------------: | --------------: | ----------------------------------: | ---------------------------: |
| Eight terms |         7,022.63 |        5,959.74 |                           221 / 200 |        4,116,967 / 4,125,540 |
| Phrase      |         6,532.47 |        5,515.89 |                           402 / 200 |        3,296,896 / 3,868,696 |

The medians decreased 15.1%/15.6%, while the first eight-term request regressed 8,264.31→9,866.80 ms and the first phrase 6,537.52→14,442.38 ms. Eight-term selected spans/blocks remained 1,600/54,653 and phrase 800/31,792. These are logical acquisition/transfer counters, including cached bodies, not billed R2 operations. Fewer calls are verified; uniformly faster first selections and lower cost are not.

A later standard load retained all 384 exact comparisons against strong references. Concurrency 1/4/16 p50 was 45.86/48.88/60.28 ms, p95 68.65/146.54/760.68 ms and throughput 16.53/43.85/66.28 requests/s. The preceding four-read run measured p95 192.22/156.02/750.37 ms. The small concurrency-sixteen tail regression and uncontrolled cache/placement/network conditions remain part of the result.

A separate four-request mixed strong/edge burst used new plan identities. All four preserved complete rows/scores and sequence and ranked 200 segments. Strong eight-term/phrase times were 8,701.00/8,695.76 ms, and edge 9,619.86/19,490.60 ms. A subsequent sixteen-request burst reused those selections, preserved every reference and ranked three segments in every response: twelve recovered shared plans and four used memory. Its p50/p95/max was 1,013.06/1,271.73/1,311.34 ms with 12.13 requests/s. All 410 measured post-deploy responses passed, plus the standard load's four strong baselines. Cold-query and concurrent tails remain far above the intended fast-search outcome; real Vectorize visibility, peak memory and general Turbopuffer parity remain unproven.

## Semantic query plan identities

Runtime `1842c68` deployed as Cloudflare version `43f203b7-f3d9-4444-8707-434f01610f9e`, verified through the native minutei profile after the unconditional metadata migration. Rust already normalizes text and deduplicates/sorts non-phrase scoring terms. The Worker now uses that same tokenizer output in plan and learned-bound identities: sorted unique tokens for any/all, ordered tokens with repetitions for phrases. The original request text still reaches Rust. Mode, filters, current global statistics, immutable segment identity, tombstones, removed frequencies, physical bucket and native Worker version remain part of their existing scope. Current-manifest acquisition and minimumSequence validation remain required. This changes reuse across equivalent selections; it does not make a first genuinely new token selection cheap.

A red/green workerd regression verifies reuse across whitespace, punctuation, Unicode normalization, case and non-phrase order/repetition changes. Phrase order and repetition changes must each miss while the original plan remains cached; their complete results then match a namespace cache rebuild. A persisted Cache API fixture recovers a plan in a fresh workerd instance using reordered, accented and duplicated non-phrase input, while retaining checksum, identity, version, count, statistics and bound rejection checks. Cache-pressure tests now use genuinely distinct filters rather than whitespace variants. The final gate passed 175 Worker/tooling tests, 36 Rust tests and 3,906 assertions, plus formatting, Effect/Oxlint, type checks and native/WASM Clippy. No Rust scoring or WASM artifact change shipped. The complete SciFact report, including all 300 ranked-ID arrays and metrics over 5,183 documents, is identical to the prior reference: nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201.

An alternating local workerd comparison reused 50,000 documents at 100 segments, then compacted to eight. Six repetitions per query/layout alternated the implementations and changed equivalent case, accent, token order, duplicates and spacing. All 48 responses retained complete rows/scores and sequence. Excluding the first repetition, medians were:

| Segments | Query       | Before ms | After ms | Final ranked segments before / after |
| -------: | ----------- | --------: | -------: | -----------------------------------: |
|      100 | Eight terms |     88.10 |    13.52 |                              100 / 8 |
|      100 | Phrase      |    126.07 |    10.38 |                              100 / 3 |
|        8 | Eight terms |     70.41 |    25.17 |                                8 / 2 |
|        8 | Phrase      |     98.19 |    39.38 |                                8 / 2 |

Native probes reused the unchanged million-document, 200-segment corpus at sequence 2,000. Both versions received exactly the same three equivalent inputs per shape. Before deployment every input missed its raw-text plan and ranked 200 segments. After deployment the first input per shape still missed and ranked 200; the next two used the normalized memory plan and ranked three. Every response matched the complete persisted rows, revisions and scores. The first strong eight-term request changed 7,739.32→7,238.48 ms, while the first phrase regressed 5,697.77→6,308.50 ms. The improvement below is reuse across equivalent queries, not evidence of faster first-use search:

| Equivalent variant                                    | Eight terms before / after ms | Phrase before / after ms |
| ----------------------------------------------------- | ----------------------------: | -----------------------: |
| Case, accents and spacing                             |             7,200.77 / 313.05 |        6,105.74 / 244.78 |
| Non-phrase permutation/duplicates; phrase punctuation |             8,004.28 / 206.53 |        6,238.09 / 243.03 |

A separate edge sequence first missed at 6,524.80/5,840.71 ms, ranking 200 segments. Its equivalent variations then used memory plans and ranked three: eight-term times were 320.63/82.69 ms, and phrase 73.83/117.66 ms. Every response retained exact rows/scores, sequence and declared edge consistency. Strong and edge have different freshness contracts and placement; these samples do not establish equal guarantees or uniform latency.

The standard load preserved all 384 comparisons against strong references. Concurrency 1/4/16 p50 was 48.70/50.62/62.91 ms, p95 80.68/120.32/730.03 ms and throughput 16.79/41.81/62.85 requests/s. The prior run's p95 was 68.65/146.54/760.68 ms. Concurrency-one tails and concurrency-four/sixteen throughput regressed; these standard inputs were already normalized, and uncontrolled cache/network/placement variation prevents attributing these changes to semantic reuse.

A fresh-client sixteen-request dense mixed strong/edge burst preserved every reference and ranked three segments in all responses, with eleven shared-plan recoveries and five memory plans. Its p50/p95/max was 1,073.01/1,515.44/1,519.13 ms, with 10.48 requests/s. A second fresh client warmed with 32 verified requests and then measured 96 requests at concurrency sixteen in the same process: p50/p95/max was 347.29/777.73/1,289.53 ms and throughput 32.03 requests/s. All 128 responses ranked three segments; warmup had eleven shared/twenty-one memory plans and the measured phase twelve shared/eighty-four memory plans. This separates warmup from the measurement but does not isolate connections, snapshots, placement or cache recovery. The slowest measured edge response took 1,289.53 ms at the client and reported a 399 ms gateway interval, including 226 ms selecting a snapshot; native clocks and these intervals do not classify the remaining delay or establish CPU usage.

All 540 post-deploy query checks passed, including the 32 warmups, plus the standard load's four strong baselines. First-use search, concurrent tails, real Vectorize visibility, peak memory and general Turbopuffer parity remain open. The next first-use investigation must target genuinely different token selections, rather than treating equivalent whitespace or case variants as cold queries after this change.

## Rejected directory CRC composition

The original Rust decoder validates a CRC over the inflated canonical header and then the canonical JSON payload CRC. An experiment used crc32fast's native concatenation operation to combine the sixteen-byte prefix CRC with the declared JSON CRC, while retaining actual payload hashing and all canonical validation. Encoder output was byte-identical in the measured fixtures. Native and WASM tests verify the outer CRC against a direct hash, reject independently damaged frame/payload checksums and reject valid JSON altered beneath unchanged CRC declarations. This optimization was tested and then reverted; only the stronger integrity tests remain.

A baseline bridge measurement over deterministic 500/5,000/10,000-document segments measured raw-directory medians of 1.33/12.97/26.66 ms and compressed-directory medians of 2.00/18.97/38.33 ms. Two paired WASM comparisons alternated implementation order, excluded five warmups, then measured thirty pairs of four decodes each. The second comparison reversed engine initialization order and added 1/16/128-document controls. All compressed encoder outputs matched the original bytes.

| Documents | First compressed before / after ms | Reversed compressed before / after ms |
| --------: | ---------------------------------: | ------------------------------------: |
|       500 |                      2.103 / 1.899 |                         3.646 / 3.209 |
|     5,000 |                    18.831 / 16.322 |                       20.278 / 18.946 |
|    10,000 |                    39.234 / 33.799 |                       37.460 / 32.701 |

Small reversed controls measured 0.0881→0.0864 ms at one document, 0.2326→0.2168 ms at sixteen and 1.2052→1.1109 ms at 128. Unchanged raw-directory controls also shifted: 13.120→12.166 and 26.947→24.683 ms in the first larger cases, and 23.907→22.533/29.566→28.775 ms on repetition. Those shifts limit attribution of the full measured difference to CRC composition. The experiment removed one complete checksum scan but did not change cache geometry, posting acquisition, scoring or canonical R2 bytes.

Candidate `0525198` deployed as native version `c85a810d-18c3-4df5-9ebf-e02d70d861fa`. Its full gate passed 176 Worker/tooling tests, 36 Rust tests and 3,911 assertions, including Effect/Oxlint, type checks and native/WASM Clippy. Its complete 300-query SciFact report remained identical to the prior reference. The original code was restored in `24dd7e6`, deployed and independently verified as `c55e26c1-5c9a-4dd5-b014-3969ae02d9d6`. Both unconditional metadata migrations completed. Restored WASM SHA-256 is byte-identical to the pre-experiment reference: `e44d6c87a1cfbd2c6944e0605ad89716a98cd57cdf10a5854d683ed23dc38791`. The restored full gate passed the same 212 tests and 3,911 assertions.

Native reference acquisition first used three unused group terms and three different two-term phrases over the unchanged million-document, 200-segment corpus at sequence 2,000. All six plans missed and ranked 200 segments; elapsed times ranged 7.01–15.95 seconds. These references were retained separately. A second comparison used groups 66/67/68 and the phrases `object storage`, `storage latency durable` and `latency durable object`. Each measured query was preceded by the same words under another match mode to warm immutable inputs without sharing that query plan. All measured requests still required a plan miss. This did not make cache retention uniform: before-change directory intervals ranged 11–1,335 ms. Every candidate/restored measured response matched the complete pre-change rows, revisions and scores.

| Query                          | Original ms | CRC candidate ms | Restored ms |
| ------------------------------ | ----------: | ---------------: | ----------: |
| Group 66 / eight terms         |    7,192.68 |         7,418.68 |    8,892.62 |
| Object-storage phrase          |    5,772.59 |         5,171.50 |    6,054.25 |
| Group 67 / eight terms         |    8,205.72 |         7,007.02 |    9,140.22 |
| Storage-latency-durable phrase |    7,237.10 |         6,394.65 |    7,351.30 |
| Group 68 / eight terms         |    8,241.66 |         7,959.19 |    8,015.96 |
| Latency-durable-object phrase  |    6,938.25 |         6,642.98 |    7,672.73 |

Five candidate timings improved and one regressed. The restored first-use results were generally slower, so these samples do not prove the candidate worsened first-use search. Metadata/range cache state, placement and network remained uncontrolled; native elapsed intervals do not establish CPU usage.

Two isolated candidate standard loads each preserved all 384 comparisons against strong baselines. Their concurrency 1/4/16 p95 was 85.71/249.81/1,053.32 ms and 99.13/249.33/1,112.22 ms; throughput was 15.93/30.62/53.86 and 15.79/38.37/53.33 requests/s. The prior implementation's preceding run measured p95 80.68/120.32/730.03 ms and throughput 16.79/41.81/62.85. Those repeat tail regressions did not justify keeping the local-only optimization. Restoration preserved another 384 comparisons, with p50 48.15/54.15/71.50 ms, p95 136.61/139.83/913.28 ms and throughput 13.53/47.02/58.78 requests/s. Restoration improved candidate concurrency-four/sixteen tails but did not recover the earlier reference and worsened concurrency-one tails. These observations do not isolate the CRC change as the cause.

An additional standard repeat overlapped a mixed sixteen-request dense burst. The standard responses remained exact; its latency figures are excluded from the comparisons above. The burst failed with HTTP 504, and its driver did not retain the response body or partial successes, leaving the cause unclassified. Later isolated strong/edge controls all matched their references, recovered shared plans with zero learned-bound memory hits and ranked three segments; metadata confirmed the corpus still had one million documents, 200 segments and sequence 2,000. A later isolated sixteen-request mixed dense burst passed every reference, with p50/p95/max 1,032.05/1,782.81/1,852.36 ms and 8.63 requests/s. These checks do not establish cold-burst reliability or Turbopuffer parity. The original first-use and concurrent-tail goals remain open; source performance gains must be demonstrated beyond a decoding microbenchmark.

## Unique score envelopes in derived catalogs

Term score catalogs now sort and deduplicate identical `(max_title_tf, max_body_tf, min_title_length, min_body_length)` tuples. The consumer takes their maximum score, so duplicate multiplicity and tuple order do not affect the bound. Canonical segment bytes, posting blocks, document frequencies and eligible filter minima retain their existing owners. Versioned derived catalog caches cut over together.

The paired local comparison seeded the same 50,000 documents into independent original/candidate workers, measured both 100-segment and compacted eight-segment layouts, alternated implementation order and excluded the first pair from each median. Six genuinely distinct any-mode group selections and six phrase selections avoided normalized plan reuse between pairs. All 48 responses retained identical complete rows, revisions, scores and sequence.

|       Layout | Query       | Original median ms | Unique-envelope median ms |
| -----------: | :---------- | -----------------: | ------------------------: |
| 100 segments | Eight terms |             238.71 |                    219.19 |
| 100 segments | Phrase      |             475.38 |                    445.14 |
|   8 segments | Eight terms |             147.34 |                    132.78 |
|   8 segments | Phrase      |             129.92 |                    121.35 |

Each median contains five samples per implementation. This emulator comparison does not include production network latency. On the 5,000-document repeated-field fixture, the projected term summary shrank from 3,512 to 353 JSON bytes. Packed all-term overviews changed only from 17,647 to 17,564 bytes because compression already removes much of the repetition. The paired WASM probe improved summary generation and 64-catalog bound evaluation, but overview projection regressed on the 500-document fixture and was approximately unchanged on larger fixtures. The optimization therefore does not imply uniformly faster directory operations or fewer canonical R2 bytes.

The complete independent SciFact report was identical after the change: 5,183 documents, 300 queries, nDCG@10 0.6730619695232347, recall@10 0.7956666666666666 and MRR@10 0.641808201058201. The local gate passed 177 Worker/tooling tests and 36 Rust tests, including exact equality between full and deduplicated bounds across different global statistics and filter minima.

The deployed million-document comparison used groups 69/70/71 and three new phrase selections, with the same corpus, 200 segments and sequence 2,000. Each measured query followed an alternate-mode warmup for its terms; every measurement required a text-plan miss. All six candidate responses matched the original complete rows, revisions and scores.

| Query                         | Original ms | Unique-envelope ms |
| :---------------------------- | ----------: | -----------------: |
| Group 69 / eight terms        |    7,824.05 |           7,780.22 |
| Durable-object-storage phrase |    6,756.24 |           6,302.17 |
| Group 70 / eight terms        |    8,026.25 |           8,509.55 |
| Object-storage-latency phrase |    7,107.43 |           5,673.72 |
| Group 71 / eight terms        |    9,226.41 |           6,647.73 |
| Repeated storage phrase       |    8,281.57 |           6,082.36 |

Five elapsed samples improved and one regressed. Candidate directory intervals were 9–67 ms versus 24–452 ms originally, but cache retention, regional placement and network were not controlled. These are single samples per selection and do not isolate CPU gains or establish first-use latency improvements. New selections still ranked all 200 segments and remain multi-second.

Two isolated post-deploy standard runs each preserved all 384 strong-baseline comparisons. The first measured concurrency 1/4/16 p50 61.30/60.69/76.21 ms, p95 105.21/689.15/969.58 ms and throughput 7.81/23.64/51.45 requests/s. The second measured p50 49.01/51.72/65.44 ms, p95 83.28/111.87/784.07 ms and throughput 18.42/49.33/58.99 requests/s. The second improved on the preceding restored run, while the first had a substantially worse concurrency-four tail; cache/placement/network variation remains unresolved.

Between those isolated runs, two sequential edge selections were explicitly warmed and compared against their original strong references before a mixed strong/edge burst. Their first-use latency was 21,019.97/10,538.66 ms. The following sixteen-request burst preserved every complete reference and measured p50/p95/max 843.58/1,556.01/1,603.28 ms and 9.96 requests/s. The driver retains per-response status, timing and ray and waits for all outcomes; no HTTP error occurred in this burst. This warm success does not resolve the earlier unclassified 504 or establish cold-burst reliability. Native Vectorize visibility and general Turbopuffer parity remain separate unverified gates.

## Rejected positional JSON directory trial

An experimental derived directory encoding replaced repeated document/block field names with positional JSON tuples, reconstructing the same native Header. Canonical R2 segments retained their original format. The producer validated the canonical header and CRC; consumers checked the versioned frame, expected canonical length, bounded inflation, compact CRC, tuple shape and shared structural validation. A separate derived cache route prevented legacy frame reuse. The candidate was not retained after the native cold-edge probes below failed twice. Codec improvements alone did not satisfy the complete search contract.

A paired WASM comparison alternated original/candidate order over 24 pairs with two iterations each and excluded the first four pairs. Complete selected term metadata and filter minima remained equal. Each median contains twenty samples per implementation.

| Documents | Original packed bytes | Tuple packed bytes | Original decode ms | Tuple decode ms | Original encode ms | Tuple encode ms |
| --------: | --------------------: | -----------------: | -----------------: | --------------: | -----------------: | --------------: |
|       500 |                16,363 |             13,152 |               2.48 |            1.39 |               4.00 |            3.25 |
|     5,000 |               140,085 |            107,914 |              19.26 |           10.75 |              32.05 |           25.73 |
|    10,000 |               275,063 |            211,262 |              38.94 |           21.91 |              63.78 |           53.28 |

Unchanged raw-directory decode controls were 1.38/1.35, 13.76/13.00 and 27.92/25.91 ms respectively. These paired measurements establish faster codec operations for these fixtures, not whole-query speed or production CPU usage.

The complete 50,000-document comparison used the preceding unique-envelope implementation as baseline, independent original/candidate workers, six distinct selections per query shape, alternating implementation order and both 100-segment and compacted eight-segment layouts. Every one of the 48 responses preserved complete rows, revisions, scores and sequence. Excluding the first pair left five samples per median. Results were mixed: eight-term medians changed 233.41→264.54 ms at 100 segments and 166.44→153.21 ms at eight segments; phrase medians changed 482.48→468.93 and 150.31→158.39 ms. Local codec gains alone therefore do not establish faster complete queries.

The full gate passed 178 Worker/tooling tests and 36 Rust tests. The independent SciFact report remained completely identical, including all 300 per-query results and aggregate metrics. A separate paired build also confirmed identical canonical segment bytes for the 500-document fixture. Malformed tuple versions, document ordering, frequencies, block counts/rows, field types, trailing JSON, corrupted payloads and source headers are rejected.

The first deployment uploaded the Worker but its vector migration command returned HTTP 503 without retaining the response body or namespace. Read-only checks confirmed the active version, namespace inventory and R2 state. Resuming the existing first-namespace snapshot returned complete with zero submissions; replaying the owning Alchemy reconciliation then completed all 30 namespaces and 398 deterministic vector submissions without changing the active Worker version. The original 503 cause remains unclassified; acknowledgement does not establish Vectorize visibility.

The million-document native comparison used groups 72/73/74 and three five-token phrase selections, with 200 segments and sequence 2,000. Alternate-mode warmups preceded every measured selection, and every measurement required a plan miss. All six candidate responses exactly matched original rows, revisions and scores.

| Query                                         | Original ms | Tuple-directory ms |
| :-------------------------------------------- | ----------: | -----------------: |
| Group 72 / eight terms                        |    7,979.54 |           6,629.71 |
| Durable-object-storage-latency-durable phrase |    6,856.16 |           5,844.55 |
| Group 73 / eight terms                        |    7,543.30 |           6,408.14 |
| Object-storage-latency-durable-object phrase  |    6,820.41 |           6,153.77 |
| Group 74 / eight terms                        |    7,799.72 |           6,874.98 |
| Latency-durable-object-storage-latency phrase |    6,805.03 |           5,528.71 |

All six elapsed samples improved by 9.8–18.8%, with one measurement per selection. Post-deployment requests overlapped read-only diagnostics for the failed migration, so this table is diagnostic evidence rather than an isolated performance comparison. These measurements cover new query plans after warming immutable inputs; they do not establish fully cold latency or isolate production CPU usage. The first alternate-mode warmup took 11,795.36 ms originally and 28,736.53 ms after the new derived-cache route was deployed. That initial cache-population cost remains material; the codec and warmed-input improvements do not resolve fully cold search.

An immediately preceding original standard load preserved all 384 strong-baseline comparisons, measuring concurrency 1/4/16 p50 48.16/58.50/77.27 ms, p95 103.21/650.12/764.00 ms and throughput 15.96/24.73/54.94 requests/s. The candidate's standard load also preserved all 384 comparisons, with p50 61.59/56.96/63.51 ms, p95 150.89/282.39/830.93 ms and throughput 9.80/38.51/53.44 requests/s. The mixed tail changes do not establish uniform throughput or latency gains.

The planned dense burst never started: its first sequential edge warmup for group 72 returned HTTP 504 after 30,715.29 ms. An isolated repeat returned the same status after 30,347.88 ms. Both response bodies explicitly reported `Edge query exceeded its 30-second snapshot lease`; this classifies these failures, not the earlier burst whose error body was lost. Status, body, server timing and ray were retained. Strong references had already passed for this selection. The candidate and complete evidence were preserved outside the tracked tree, and the preceding runtime was restored for the same-query control. These failures do not prove a tuple codec defect: cache placement, cold acquisition and timed-out query lifetime still require diagnosis. Extending the snapshot deadline would hide the failure without proving faster search.

Restoration passed the complete original gate again (177 Worker/tooling and 36 Rust tests), completed the Alchemy migration and was confirmed through the native deployment API. The same two sequential edge selections then returned HTTP 200 with exact references in 13,766.75/11,884.98 ms. This establishes recovery under the restored runtime and its cache state, not that the tuple format caused the failures.

The following restored sixteen-request mixed burst preserved every reference, but p50/p95/max was 1,174.84/14,715.29/14,721.67 ms and throughput 1.09 requests/s. Only edge selections had been warmed after restoration: four strong requests still missed their plans and each ranked all 200 segments. Later strong requests recovered memory plans and ranked three segments but waited behind that cold work. The eight edge requests recovered shared plans, ranked three segments and took approximately 997–1,175 ms. This is a mixed cold/warm control, not a fully warmed burst benchmark. It exposes duplicated concurrent cold work and admission delays as another concrete target; preserving all results does not establish acceptable latency.

A separate repetition after both consistency paths had completed retained all sixteen exact references. Its sequential edge warmups took 533.47/120.91 ms, and the fully warmed mixed burst measured p50/p95/max 1,380.41/1,514.87/1,663.94 ms with 9.59 requests/s. The restored runtime remains deployed. The tuple candidate is rejected for now; cold-edge acquisition, cold duplicate scoring, concurrent tails and general Turbopuffer parity remain open.

## Sharing active coordinator text evaluations

Identical admitted text requests against the same captured manifest object now share active ranking and document materialization in their namespace coordinator. Identity includes the complete Schema-encoded Query; different inputs and different roots cannot join, including roots replaced without a sequence change. The coordinator's four read slots bound active entries. Every caller keeps its own sequence validation, read lease, response encoding and headers. Success and failure remove the entry; no completed result is retained. Vector/hybrid queries and edge execution retain their existing paths. Successful followers report `text_inflight` wait time rather than claiming separate ranking work.

Five deterministic producer-gate tests verify one producer for four identical callers, successful-entry removal, isolation of every input and coordinator/root identity, failure identity and retry, new-root progress while old readers wait, and coexistence of different active selections. The full gate passed 182 Worker/tooling tests and 36 Rust tests with 3,950 assertions. The complete SciFact report remained identical. A four-request workerd probe also preserved every complete response, but its first cold request ran before the later warm requests, so that local probe does not exercise concurrent sharing or establish a speed gain. The native comparison below verifies the actual call path.

The deployed control used one million documents, 200 segments and sequence 2,000. Four genuinely new selections each received an alternate-mode warmup before a burst of four identical strong requests. The original implementation ranked all 200 segments independently in every one of the sixteen measured responses, preserving identical complete rows, revisions and scores. Original burst completion took 11,116.94/12,283.11/11,182.54/12,579.48 ms for group 75, the storage-latency repeated phrase, group 76 and the object-storage repeated phrase respectively. These are elapsed intervals, not CPU measurements or a fully cold-cache comparison.

After deployment, each native burst required exactly three `text_inflight` followers and one 200-segment producer. All sixteen measured responses matched the original complete references. Total ranked segment visits fell from 3,200 to 800 across the four bursts, including cache hits; this does not measure billed CPU or transferred bytes.

| Selection                                             | Original burst ms | Shared-work burst ms | Elapsed reduction |
| :---------------------------------------------------- | ----------------: | -------------------: | ----------------: |
| Group 75 / eight terms                                |         11,116.94 |             9,652.12 |            13.18% |
| Storage-latency-durable-object-storage-latency phrase |         12,283.11 |             9,289.46 |            24.37% |
| Group 76 / eight terms                                |         11,182.54 |             8,688.28 |            22.30% |
| Object-storage-latency-durable-object-storage phrase  |         12,579.48 |             7,969.07 |            36.65% |

These are four paired selection samples, not a statistical latency distribution. Identical cold work was eliminated at the actual coordinator call path; the elapsed improvement still includes uncontrolled cache, placement and network effects. Native interval timings are diagnostic; client elapsed time is used in this table. A regression control that disabled joining failed the producer-count and lifetime tests; restoring the exact source made all five pass again.

The deployed standard load preserved all 384 strong-baseline comparisons. Concurrency 1/4/16 measured p50 48.23/53.53/70.95 ms, p95 81.97/156.30/905.33 ms and throughput 15.01/23.74/65.89 requests/s. Its worst phase-four request took 4,172.14 ms: timing reported slow R2 snapshot acquisition/body handling, an expired snapshot and coordinator fallback. The response still matched its strong reference. The worst phase-sixteen request took 1,747.74 ms and also fell back after slow R2 snapshot revalidation. Those tails are not solved by sharing coordinator ranking.

Two sequential edge selections for group 75 and the first six-token phrase matched their original strong references in 11,760.34/6,679.39 ms. After those warmups, a sixteen-request mixed strong/edge burst preserved all references, measuring p50/p95/max 1,668.42/2,115.49/2,120.03 ms and 7.54 requests/s. Every producer ranked three segments; three strong requests joined active coordinator work. No HTTP error occurred in these measured runs. This does not establish cold-edge reliability, native vector visibility, or general Turbopuffer parity. The deployment completed the unconditional 30-namespace/398-submission vector reconciliation, and its active version was verified through the native API; provider visibility remains separate.

## Required-term candidate traversal in Rust

Any-mode ranking now switches from union traversal to a required-term driver when top-k is full and the cutoff strictly exceeds the conservative maximum contribution of all other terms. Per-term maxima come from the same validated block bounds used by existing pruning. Their sum retains sorted term order, and the existing `1e-12` tolerance is preserved. The largest upper bound is selected, with shorter lists preferred on a tie. A document without that term cannot improve top-k; all other lists are sought to each retained candidate so their contributions remain included. All/phrase semantics, canonical segment bytes and cache formats stay unchanged.

A counted real-scorer regression fixture previously made 24,536 frequency accesses during scoring; the new traversal remains below 8,000, while exactly matching an exhaustive row/score oracle. A second oracle covers 72 combinations of query terms, top-k, filters, deletions and changed global statistics. The full gate passed 182 Worker/tooling and 38 Rust tests. The complete 300-query SciFact report remained identical.

The paired WASM finish-only comparison built identical fixtures independently in each engine, verified byte-identical canonical segments and every returned row/score, alternated engine order over 24 pairs and excluded the first four pairs. Ranker construction and posting loading occurred outside the measured interval. Each median contains twenty samples.

| Documents | Query                                   | Original finish ms | Required-term finish ms |
| --------: | :-------------------------------------- | -----------------: | ----------------------: |
|     5,000 | Eight terms including a selective group |             1.1749 |                  0.3191 |
|    10,000 | Eight terms including a selective group |             2.2919 |                  0.3511 |
|     5,000 | Four common terms                       |             0.6691 |                  0.6857 |
|    10,000 | Four common terms                       |             1.3517 |                  1.3742 |
|     5,000 | All-mode                                |             0.0796 |                  0.0819 |
|    10,000 | All-mode                                |             0.1345 |                  0.1333 |
|     5,000 | Phrase                                  |             1.2915 |                  1.3415 |
|    10,000 | Phrase                                  |             3.1126 |                  3.0450 |
|     5,000 | Filtered eight terms                    |             0.0876 |                  0.0876 |
|    10,000 | Filtered eight terms                    |             0.1501 |                  0.1561 |

The selective any-mode case improved approximately 73–85%; the controls showed small increases and decreases. An earlier fixture setup allocated the segment builder only in the baseline engine and produced misleading phrase-control differences; those timings are excluded above. The balanced setup prevents that unequal retained allocation. Finish-only results exclude directory decoding, posting transfer and materialization, so they do not establish an equivalent complete-query gain.

The million-document native comparison retained 200 segments and sequence 2,000. Each measured selection followed an alternate-mode warmup and required a plan miss; these are new-plan comparisons with warmed immutable inputs. Every complete row, revision and score matched its pre-change reference.

| Selection                                     | Original ms | Required-term ms |
| :-------------------------------------------- | ----------: | ---------------: |
| Group 77 / eight terms                        |    7,464.67 |         7,471.77 |
| Storage-latency-durable-object-storage phrase |    6,425.87 |         6,434.20 |
| Group 78 / eight terms                        |    7,895.73 |         6,642.12 |
| Latency-durable-object-storage-latency phrase |    6,369.49 |         6,356.27 |
| Group 79 / eight terms                        |    7,030.97 |         7,524.08 |
| Durable-object-storage-latency-durable phrase |    6,656.03 |         6,603.91 |

The three any-mode samples were approximately unchanged, 15.9% faster and 7.0% slower respectively. Phrase controls stayed within 0.8%. Each request still ranked all 200 segments. Reduced score evaluation did not reduce directory/posting acquisition, and the complete-query samples do not establish a uniform improvement. The Rust change is retained for its directly verified reduction in redundant scoring; the cold storage/catalog bottleneck remains open.

Two isolated standard loads each preserved all 384 comparisons against strong baselines. The first measured concurrency 1/4/16 p50 56.50/54.45/76.29 ms, p95 137.53/192.32/813.21 ms and throughput 12.01/36.14/46.02 requests/s. The repeat measured p50 52.14/64.55/74.58 ms, p95 93.59/182.14/674.28 ms and throughput 16.04/33.44/62.88 requests/s. Compared with the preceding implementation's 81.97/156.30/905.33 ms p95, these remain mixed rather than a general speedup.

Sequential edge warmups for group 77 and the first phrase returned exact references in 13,753.16/10,469.89 ms. The following mixed sixteen-request burst preserved every reference and measured p50/p95/max 1,375.46/1,573.48/1,607.44 ms with 9.94 requests/s. No HTTP error occurred in these runs. The Alchemy deployment and unconditional 30-namespace/398-submission vector migration completed, and the active Worker version was verified through the native API. Vectorize visibility, peak memory, fully cold reliability and general Turbopuffer parity remain separate unverified requirements.

## Correlated length bounds on immutable segments

Runtime `35990b31-99a0-4873-a2a7-2dd0f6398a0f` adds shared document-length partitions to disposable score summaries. Independent term maxima can combine frequencies and lengths from different documents. Taking the maximum of the summed bounds within shared partitions removes that slack while retaining the original scorer, live statistics, filters and tie order. Canonical segment bytes remain unchanged.

A sequential native before/after comparison retained one million documents, 200 segments and sequence 2000. Each selection used a neutral missing-field predicate to create a new plan, preceded by an alternate-match-mode warmup. Every measured plan missed the completed-plan cache. Three eight-token any queries selected groups 80–82; three five-token phrases rotated `storage latency durable object`. All complete rows, revisions and scores matched their pre-change references.

| Selection     | Before ms | After ms | Ranked segments before/after |
| :------------ | --------: | -------: | ---------------------------: |
| Any, group 80 |   7464.16 |   343.40 |                      200 / 3 |
| Phrase 1      |   7306.84 |   288.27 |                      200 / 3 |
| Any, group 81 |   7020.63 |  1876.52 |                      200 / 3 |
| Phrase 2      |   6169.05 |  2061.57 |                      200 / 3 |
| Any, group 82 |   7614.96 |  1238.48 |                      200 / 3 |
| Phrase 3      |   7389.91 |  1584.71 |                      200 / 3 |

These are new plans after priming immutable inputs, not isolated cold processes. The first alternate-mode warmup changed 10.31→5.10 seconds; its post-change directory interval alone was 4.21 seconds. The 200 R2 summaries were explicitly prepared and read back before deployment, occupying 3,860,042 compressed bytes and 5,191,921 bytes including envelopes. Their preparation preserved the canonical manifest byte for byte. New writes and compaction attempt to prepare summaries automatically; missing or unavailable summaries retain canonical fallback.

An expanded prototype regressed a paired local 1,000-document SciFact sample from median 125.79→217.91 ms across 24 queries. It was not deployed. Admission now limits partition entries relative to vocabulary size and omits singleton entries, retaining their ordinary bound in every partition. The retained version preserved every complete response in another alternating 24-query comparison, with medians 103.69/98.52 ms. Cache preparation ran concurrently with that local comparison; it is a regression check, not an isolated CPU speedup claim. The final complete 300-query SciFact report equals the prior report. The full gate passed 187 Worker/tooling and 38 Rust tests, including conservative coarsening, singleton terms, corruption, cache loss, source identity, and WASM range overflow.

Two subsequent 384-request native edge runs matched their strong baselines without errors. Concurrency 1/4/16 first-run p50 was 56.98/56.45/68.14 ms, p95 308.26/121.61/985.09 ms and throughput 3.45/42.36/47.23 requests/s. The first concurrency-one phase included a 12.07-second request with an 11.59-second directory interval. The repeat measured p50 49.42/60.11/66.35 ms, p95 91.63/128.85/764.23 ms and throughput 16.59/37.21/63.71 requests/s. Sequential warming and network/placement variation limit timing attribution. Cold catalogs, snapshot acquisition, concurrency tails, native vector visibility/recall, peak memory and a fully indexed Turbopuffer comparison remain open.

## Catalog acquisition and snapshot cache wait

The next native experiment kept the million-document root at sequence 2000 and compared three fresh selectors in both strong and edge modes. All six complete responses retained their prior rows and scores. Origin telemetry isolated a sequential batch of 16 R2 summaries: one strong request spent 2,405 ms in the origin before the change and 825 ms with four overlapping acquisitions. Total request latency was 2,668→1,507 ms. This is one measured sample, with different cache states, rather than a general speedup guarantee.

The corresponding edge request regressed 5,619→5,926 ms; 4,462 ms was in Cache API acquisition. An additional sparse-term experiment completed eight candidate responses with exact strong/edge equality; the preceding sequential experiment stopped at an HTTP 504 after three successful responses. Different term subsets were used to avoid already cached batches, so those whole-query times are not a paired causal comparison.

A subsequent 384-response load preserved every strong baseline and returned no errors, but concurrency 1/4/16 p50 was 68.57/73.36/77.63 ms, p95 384.96/1,034.66/1,096.95 ms and throughput 8.23/21.80/6.18 requests/s. Its slowest request took 20.71 seconds, including 16.95 seconds waiting for the snapshot Cache API, followed by about 246 ms acquiring and decoding canonical R2. This run exposes a cache tail; it does not improve on the earlier README table.

Snapshot cache acquisition now has a 250 ms foreground budget, with canonical R2 recovery and late-response protection. A workerd fixture stalls native Cache API matching for 800 ms while an older cached root competes with a newer R2 root. The query must return through R2 before the stalled lookup finishes, retain the newer root after that lookup settles and honor the unchanged sequence barrier. Relaxing the budget to two seconds makes the regression test fail. Native post-change results are recorded separately below.

After deployment, all 384 native responses matched the strong reference at sequence 2000. The 76 recorded snapshot cache intervals were at most **274 ms**, with 19 timeout fallbacks to canonical R2. This is a measured observation, not a hard real-time deadline. Overall p50 at concurrency 1/4/16 was **198.22/152.32/162.00 ms**, p95 **785.06/1,549.95/1,496.88 ms**, and throughput **1.76/6.29/14.41 requests/s**. These end-to-end results regressed despite bounding snapshot cache wait. The slowest request still took 19.32 seconds: directory acquisition 7.67 seconds, ranking 4.69 seconds and document materialization 6.21 seconds, while snapshot acquisition took 536 ms. Other native acquisition tails remain unresolved.

The final full local gate passed **190 Worker/tooling tests and 38 Rust tests**, including 7,203 Bun assertions. A fresh 300-query SciFact evaluation produced a complete JSON report identical to the previous report, including all returned document identifiers and per-query metrics. The deployed candidate is `88017f25-695c-4ad6-b0c1-be2e7793789c`. Native Vectorize migration acknowledged submissions; provider visibility and recall remain separate unverified gates.

The sequential 384-response repeat also preserved all strong baselines. Concurrency 1/4/16 p50 was **48.31/61.04/72.46 ms**, p95 **100.72/290.98/1,330.75 ms**, and throughput **14.65/38.85/39.84 requests/s**. Its slowest request took 1.77 seconds. Thirty-one snapshot cache intervals were recorded, with a maximum of **298 ms** and seven timeouts. Across both runs, all 768 results remained exact, while warmed concurrency tails still exceeded the earlier reference. Shared cache state and native timing variation prevent attributing the difference in end-to-end percentiles solely to this change.

## Shared plan publication outside query delivery

Native traces from the preceding candidate included foreground `text_plan_put` intervals of 774 and 2,033 ms. Publication is optional derived cache work; canonical R2 and exact ranking do not require its acknowledgement. The next candidate retains the tightened plan in memory immediately and offers its compressed frame through the owning HTTP or Durable Object context’s native `waitUntil`. It admits at most sixteen pending publications under a two-MiB charge budget and deduplicates their full cache identity. Failed or skipped publications leave catalog recovery intact.

A workerd fixture stalls native plan `cache.put` for 800 ms. The previous implementation fails a 650 ms response deadline; the candidate returns before publication finishes, reuses its in-memory plan during that wait and eventually finishes publication. The independent fresh-instance test waits for a stored frame and still checks recovery, corruption, identity and Worker-version isolation. The full gate passed **191 Worker/tooling and 38 Rust tests**, with 7,217 Bun assertions.

Response markers distinguish scheduled and skipped publication without claiming storage success. The old foreground put interval and publication-success marker are removed. Earlier document intervals included the foreground publication wait; new `text_documents` starts after scheduling. Those intervals therefore cannot be compared as isolated document acquisition timings across this change.

Six fresh-plan native comparisons on the unchanged million-document corpus retained all rows and scores. The preceding version’s publication waits were only 7–20 ms in this new sample, rather than the earlier multi-second tails. Candidate responses report scheduling instead of waiting for publication. Strong request elapsed times changed 2,980→2,131 ms, 562→394 ms and 1,264→829 ms; corresponding edge requests changed 1,927→1,931 ms, 563→530 ms and 1,041→1,078 ms. These samples use distinct neutral filter values to force fresh plan identities and share warmed immutable inputs. They do not isolate an end-to-end speedup attributable to background publication. Deployed version: `7315bd88-535c-4c52-84a5-cdf4b806c7fa`.

Two subsequent sequential native loads preserved every strong baseline at one million documents and sequence 2000: **768 complete responses, zero errors**. The first run at concurrency 1/4/16 measured p50 **65.67/63.27/87.77 ms**, p95 **459.19/804.42/981.59 ms**, and throughput **7.31/20.52/35.16 requests/s**. The repeat measured p50 **54.44/58.28/81.39 ms**, p95 **218.26/354.24/996.86 ms**, and throughput **11.62/24.61/17.92 requests/s**. Different native cache states limit causal comparison with earlier deployments; these measurements do not establish a general throughput improvement.

The first run’s maximum was 2.53 seconds; the repeat’s maximum was 6.05 seconds. That repeat request spent 4.11 seconds ranking, including 3.25 seconds acquiring postings, and 1.10 seconds acquiring documents. Snapshot selection took 494 ms, including a 250 ms cache timeout. Across both runs, 24 snapshot timeouts recovered through R2. The largest recorded snapshot cache interval was 465 ms, demonstrating that the nominal budget does not guarantee timer scheduling at exactly 250 ms. Native immutable acquisition tails remain open.
