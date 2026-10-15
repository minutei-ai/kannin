# Retrieval quality

The BEIR SciFact test split supplies public relevance judgments independent of the scorer. The local workerd evaluation indexed 5,183 scientific abstracts and titles into native emulated R2 and ran all 300 judged test queries through the compiled Rust/WASM HTTP Worker. The same scorer serves the deployed strong and edge text paths.

| Metric    |   Result |
| --------- | -------: |
| NDCG@10   | 0.673062 |
| Recall@10 | 0.795667 |
| MRR@10    | 0.641808 |

The complete 300-query evaluation was repeated after introducing compact any/all frequency lists, after discarding validated excluded postings, after bounded top-k heap replacement, after retaining immutable Bloom batches, and after request-local query preparation. The original BEIR archive digest matched the recorded baseline. A separately rebuilt positional-engine baseline and the new engine produced byte-identical complete reports, including every query's returned identifiers and metrics. An independent Python recomputation agreed within 1e-12. The evaluator accepts both LF and the official dataset's CRLF judgment files without altering their contents.

The run used Kannin's default BM25F parameters: title weight 2, body weight 1, k1 1.2 and b 0.75, with Unicode decomposition and lowercasing, without stemming or stopword removal. Results were scored against the published test judgments. A separate Python standard-library calculation recomputed all aggregate metrics from returned identifiers and judgments, agreeing within 1e-12. This is evidence for one English scientific retrieval dataset; native deployment ranking evaluation, legal/Portuguese corpora, vector recall and hybrid judgments remain separate gates.

Download the dataset following [BEIR's official instructions](https://github.com/beir-cellar/beir#quick-example) into a directory outside this repository, then run:

```sh
RAIO_EVAL_DIRECTORY=/outside/path/scifact bun run quality
```

The evaluator consumes corpus.jsonl, queries.jsonl and qrels/test.tsv, validates external records through Effect Schema, and disposes the local Worker through native asynchronous resource disposal. Dataset files and per-query artifacts remain outside the public repository. Source: [BEIR](https://github.com/beir-cellar/beir), [SciFact](https://github.com/allenai/scifact).

Corpus SHA-256: `dec31c8182f3d744c7d2c09423756fd1d17cbef75808db13ba01cc0aab4d1ac6`. Test judgments SHA-256: `0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c`. Downloaded archive SHA-256: `536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165`.
