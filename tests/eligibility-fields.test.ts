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

test("high-cardinality filters reuse bounded projections without changing exact ranking", async () => {
  const worker = await startWorker();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  for (const namespace of ["marginal", "marginal-oracle"]) {
    for (const batch of [0, 1, 2]) {
      const documents = Array.from({ length: 700 }, (_, index) =>
        document(String(batch * 700 + index), "common alpha ".repeat(1 + (index % 13)), {
          group: index % 100,
          year: 2020 + (index % 7),
        }),
      );
      expect((await request(worker, namespace, "write", write(documents))).status).toBe(200);
    }
    expect(
      (
        await request(worker, namespace, "write", {
          ...write([document("72", "common alpha", { group: 99, year: 2020 })]),
          deletes: ["172", "272"],
        })
      ).status,
    ).toBe(200);
  }
  for (const operation of ["compact", "compact", "compact"])
    expect((await request(worker, "marginal-oracle", operation, {})).status).toBe(200);
  for (const [index, group] of [72, 43, 0, 99, 101].entries()) {
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const input = textQuery("common alpha", 10, [
      { field: "group", op: "eq", value: group },
      { field: "year", op: "gte", value: 2020 + (index % 3) },
    ]);
    const actual = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "marginal", "query", input)).json(),
    );
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const expected = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "marginal-oracle", "query", input)).json(),
    );
    expect(actual).toEqual(expected);
    if (index > 0) expect(after.termRequests - before.termRequests).toBe(0);
  }
}, 30000);
