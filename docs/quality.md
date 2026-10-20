# Retrieval quality

The local workerd evaluation uses public BEIR test judgments independent of Kannin's scorer. Unchanged documents and titles are indexed into emulated R2 and queried through the compiled Rust/WASM Worker and native Effect SDK bindings.

| BEIR test collection | Documents | Queries |  nDCG@10 | Recall@10 |   MRR@10 |
| -------------------- | --------: | ------: | -------: | --------: | -------: |
| SciFact              |     5,183 |     300 | 0.673062 |  0.795667 | 0.641808 |
| NFCorpus             |     3,633 |     323 | 0.306753 |  0.148862 | 0.512368 |
| ArguAna              |     8,674 |   1,406 | 0.406384 |  0.665718 | 0.325646 |

The current evaluation preserves every SciFact returned identifier and per-query metric against the frozen positional-engine baseline. NFCorpus's 323 result lists and metrics also remained identical after bounded compaction and the switch to native SDK bindings. NIST's official `trec_eval` executable independently reproduced NFCorpus and ArguAna aggregates at its printed four-decimal precision. Reports now include input hashes, layout and transport observations.

All runs use Kannin's default BM25F parameters: title weight 2, body weight 1, k1 1.2 and b 0.75, with Unicode decomposition and lowercasing, without stemming or stopword removal. Results were scored against the published test judgments. A separate Python standard-library calculation recomputed all aggregate metrics from returned identifiers and judgments, agreeing within 1e-12. These are English scientific, medical and counterargument retrieval baselines; native deployment ranking evaluation, legal/Portuguese corpora, vector recall and hybrid judgments remain separate gates.

Download the dataset following [BEIR's official instructions](https://github.com/beir-cellar/beir#quick-example) into a directory outside this repository, then run:

```sh
TMPDIR=/outside/disk/temp RAIO_EVAL_DIRECTORY=/outside/path/scifact bun run quality
```

The evaluator reuses the native Effect SDK binding client from the RPC integration test; the CLI calls Miniflare's native Fetcher proxy, and client-to-search and search-to-coordinator calls use service bindings. It consumes corpus.jsonl, queries.jsonl and qrels/test.tsv, validates external records through Effect Schema, and disposes the local Worker through native asynchronous resource disposal. `RAIO_EVAL_SPLIT=dev` or `train` selects a supplied development or training split. The corpus is streamed into 500-document batches instead of retaining its complete text; document identifiers, queries and judgments remain in memory. Reports identify the directory basename and split, hash all three inputs, and retain every evaluated query and returned identifier. After ingestion, the runner uses Kannin's bounded compaction operation until no further merge is eligible, verifies corpus cardinality, and reports the resulting segment count. Up to four judged queries run concurrently; returned rows and metric aggregation retain the input order. It does not alter documents, tokenization or judgments. Use a disk-backed temporary directory for long runs: local R2 and Cache API files on tmpfs, including `/tmp` on some hosts, consume RAM in addition to process heaps. Enforce memory, swap and CPU caps at the native process boundary. Dataset files and per-query artifacts remain outside the public repository. Source: [BEIR](https://github.com/beir-cellar/beir), [SciFact](https://github.com/allenai/scifact).

Corpus SHA-256: `dec31c8182f3d744c7d2c09423756fd1d17cbef75808db13ba01cc0aab4d1ac6`. Test judgments SHA-256: `0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c`. Downloaded archive SHA-256: `536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165`.

## Benchmark coverage

Use independent relevance judgments and controlled performance workloads as separate gates. Keep the production BM25F scorer fixed while collecting baselines; tune only on training/development splits and evaluate held-out queries afterward. No neural reranker or new evaluation framework is required by the Worker.

| Reference                                                                                                                   | Purpose                                                                      | Local coverage                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [BEIR](https://github.com/beir-cellar/beir#beers-available-datasets): SciFact, NFCorpus, ArguAna                            | Scientific retrieval, graded medical judgments, long counterargument queries | All three complete test splits evaluated above                                 |
| BEIR: TREC-COVID, FiQA, SCIDOCS, Touché, CQADupStack, Quora, DBPedia, NQ, HotpotQA, FEVER, Climate-FEVER                    | Domain, query-length and corpus diversity                                    | Not executed in this cut; the same JSONL/TSV runner accepts their BEIR layout  |
| [Pyserini reproduction matrices](https://github.com/castorini/pyserini#-reproduction-matrices): MS MARCO / TREC DL and BEIR | Reproducible Lucene BM25 reference configurations                            | Reference only; no local competitor index or matched comparison                |
| [MIRACL](https://github.com/project-miracl/miracl)                                                                          | Human-judged multilingual retrieval across 18 languages                      | Not executed; requires its corpus/query/qrels data in the runner's layout      |
| [mMARCO](https://github.com/unicamp-dl/mMARCO)                                                                              | Portuguese and multilingual passage retrieval                                | Reference only; translated MS MARCO data, not native Portuguese judgments      |
| [BRIGHT](https://github.com/xlang-ai/BRIGHT)                                                                                | Reasoning-intensive retrieval beyond lexical overlap                         | Reference only; requires its own evaluation and exclusion policy               |
| [Search benchmark game](https://github.com/quickwit-oss/search-benchmark-game), [PISA](https://github.com/pisa-engine/pisa) | Posting traversal, exact top-k, index size and CPU/RSS reference workloads   | Reference only; existing local synthetic cold/warm comparisons remain separate |

The BEIR inventory also includes datasets with access restrictions. Do not label restricted data as downloaded, run a truncated collection as the official full benchmark, or compare published engine timings across different hardware, analyzers and index layouts.

NFCorpus archive SHA-256: `efe5be03f8c5b86a5870102d0599d227c8c6e2484328e68c6522560385671b0b`. These are baselines for the default scorer; no matched Lucene or Turbopuffer comparison was executed.

The evaluator follows [NIST's linear-gain nDCG definition](https://github.com/usnistgov/trec_eval/blob/main/m_ndcg_cut.c), not exponential gains. This correction leaves binary SciFact judgments unchanged but matters for graded collections. It requests eleven results and excludes a document whose ID equals the query ID before taking ten, following [BEIR's default self-match policy](https://github.com/beir-cellar/beir/blob/main/beir/retrieval/evaluation.py). Missing corpus documents remain in the original qrels and denominator; reports expose their count as `missingJudgments`. The official ArguAna archive has five such judgments, consistent with [the upstream missing-document issue](https://github.com/beir-cellar/beir/issues/172). No examples or judgments are silently removed. Only failed read transports are retried, at most twice per query; the report records `transportRetries`, and failed HTTP/domain responses remain failures. Writes are not automatically retried by the evaluator. These ranking runs do not establish latency or transport reliability.

Any/all BM25 queries now accept up to 512 distinct normalized terms within the existing 8,192-character input limit. Phrase queries retain the 64-token limit. Catalog projections and native prepared queries enforce the same term boundary. This supports long benchmark queries without truncating their text. Larger query budgets do not establish a latency or memory guarantee for those queries.

ArguAna retained all 1,406 judged queries and its five absent-document judgments. Its full result contains 13 additional read-transport attempts; no failed queries were dropped. The successful local run used two compacted segments, up to four concurrent reads, a four-GiB memory cap, no swap and two CPUs. Peak memory for the complete emulator group was 2.12 GiB, including support Workers and storage emulation. This does not measure Cloudflare isolate heap. Archive SHA-256: `cfdf79adce27a401b3cd3ea267903134dbfab2c6afeb95d7fe5724a00bf7557b`.
