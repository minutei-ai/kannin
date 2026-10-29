import { textQuery } from "../tests/harness";

export const benchmarkQueries = [
  ["rare", textQuery("unique42")],
  ["selective", textQuery("group42")],
  ["common", textQuery("cloudflare rust")],
  ["filtered", textQuery("cloudflare", 10, [{ field: "group", op: "eq", value: 42 }])],
  ["common-all", { ...textQuery("cloudflare rust"), match: "all" }],
  ["common-phrase", { ...textQuery("cloudflare rust"), match: "phrase" }],
  [
    "filtered-all",
    {
      ...textQuery("cloudflare rust", 10, [{ field: "group", op: "eq", value: 42 }]),
      match: "all",
    },
  ],
  [
    "filtered-phrase",
    {
      ...textQuery("cloudflare rust", 10, [{ field: "group", op: "eq", value: 42 }]),
      match: "phrase",
    },
  ],
  ...[64, 256, 512].map(
    (count) =>
      [
        `rare-${count}-terms`,
        textQuery(Array.from({ length: count }, (_, index) => `unique${42 + index}`).join(" ")),
      ] as const,
  ),
] as const;
