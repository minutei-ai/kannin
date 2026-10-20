import { expect, test } from "bun:test";
import { retrievalMetrics } from "../tooling/retrieval-metrics";

test("graded nDCG follows trec_eval linear relevance gains", () => {
  const relevance = new Map([
    ["best", 3],
    ["good", 2],
    ["fair", 1],
    ["irrelevant", 0],
  ]);
  const result = retrievalMetrics(["missing", "good", "best"], relevance);
  const ideal = 3 + 2 / Math.log2(3) + 1 / Math.log2(4);
  expect(result.ndcg10).toBeCloseTo((2 / Math.log2(3) + 3 / Math.log2(4)) / ideal, 12);
  expect(result.recall10).toBe(2 / 3);
  expect(result.mrr10).toBe(1 / 2);
  expect(retrievalMetrics(["best", "good", "fair"], relevance).ndcg10).toBe(1);
});

test("empty judgments, missing candidates and cutoff retain their evaluation semantics", () => {
  expect(retrievalMetrics([], new Map())).toEqual({ ndcg10: 0, recall10: 0, mrr10: 0 });
  expect(retrievalMetrics(["absent"], new Map([["relevant", 1]]))).toEqual({
    ndcg10: 0,
    recall10: 0,
    mrr10: 0,
  });
  const ids = [...Array.from({ length: 10 }, (_, index) => `miss${index}`), "relevant"];
  expect(retrievalMetrics(ids, new Map([["relevant", 1]]))).toEqual({
    ndcg10: 0,
    recall10: 0,
    mrr10: 0,
  });
});
