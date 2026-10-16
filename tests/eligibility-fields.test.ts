import { expect, test } from "bun:test";
import { Match, Schema } from "effect";
import { Filter, Health, QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("cached field eligibility preserves correlated filters and global scores across values", async () => {
  const worker = await startWorker();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  await Promise.all(
    ["fields", "fields-oracle"].map(async (namespace) => {
      for (const batch of Array.from({ length: 16 }, (_, i) => i)) {
        const documents = Array.from({ length: 10 }, (_, i) => {
          const index = batch * 10 + i;
          const attributes = Match.value(index % 5).pipe(
            Match.when(0, () => ({ group: index % 2 })),
            Match.when(1, () => ({ group: index % 2, year: null })),
            Match.orElse(() => ({ group: index % 2, year: 2020 + (index % 3) })),
          );
          return document(
            String(index).padStart(3, "0"),
            "common alpha ".repeat(1 + (index % 3)),
            attributes,
          );
        });
        expect((await request(worker, namespace, "write", write(documents))).status).toBe(200);
      }
    }),
  );
  for (const operation of ["compact", "compact", "compact"])
    expect((await request(worker, "fields-oracle", operation, {})).status).toBe(200);
  const filters = Schema.decodeSync(Schema.Array(Schema.Array(Filter)))([
    [{ field: "year", op: "gte", value: 0 }],
    [{ field: "year", op: "gte", value: 2021 }],
    [{ field: "year", op: "eq", value: null }],
    [{ field: "year", op: "exists", value: false }],
    [{ field: "year", op: "ne", value: null }],
    [{ field: "year", op: "in", value: [2020, null] }],
    [
      { field: "group", op: "eq", value: 1 },
      { field: "year", op: "gte", value: 2021 },
    ],
    [
      { field: "year", op: "lt", value: 2022 },
      { field: "group", op: "eq", value: 0 },
    ],
  ]);
  for (const [index, predicates] of filters.entries()) {
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const input = textQuery("common alpha", 10, [...predicates]);
    const actual = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "fields", "query", input)).json(),
    );
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const expected = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "fields-oracle", "query", input)).json(),
    );
    expect(actual).toEqual(expected);
    if (index !== 0 && index !== 6) expect(after.termRequests - before.termRequests).toBe(0);
  }
}, 15000);
