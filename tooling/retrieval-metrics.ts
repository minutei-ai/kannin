export function retrievalMetrics(
  ids: ReadonlyArray<string>,
  relevance: ReadonlyMap<string, number>,
) {
  const scores = ids.slice(0, 10).map((id) => relevance.get(id) ?? 0);
  const ideal = [...relevance.values()].toSorted((a, b) => b - a).slice(0, 10);
  const denominator = ideal.reduce((sum, score, index) => sum + score / Math.log2(index + 2), 0);
  const gain = scores.reduce((sum, score, index) => sum + score / Math.log2(index + 2), 0);
  const relevant = [...relevance.values()].filter((score) => score > 0).length;
  const rank = scores.findIndex((score) => score > 0);
  const metrics = { ndcg10: 0, recall10: 0, mrr10: 0 };
  if (denominator > 0) metrics.ndcg10 = gain / denominator;
  if (relevant > 0) metrics.recall10 = scores.filter((score) => score > 0).length / relevant;
  if (rank >= 0) metrics.mrr10 = 1 / (rank + 1);
  return metrics;
}
