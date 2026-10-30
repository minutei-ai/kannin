import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Query, QueryResult, Root } from "../src/protocol";
import { TextExecutions } from "../src/text-executions";

const root = Schema.decodeSync(Root)({
  version: 1,
  sequence: 2,
  head: null,
  documents: 0,
  titleLength: 0,
  bodyLength: 0,
  vectorEpoch: "fixture",
  vectorJobs: [],
  lastReceipt: null,
  bloomPacks: [],
  segments: [],
});
const input = Schema.decodeSync(Query)({
  kind: "text",
  text: "alpha",
  topK: 10,
  filters: [],
});
if (input.kind !== "text") throw new Error("Expected text fixture");
const rows = Schema.decodeSync(QueryResult.fields.rows)([
  {
    id: "original",
    title: "Alpha",
    text: "alpha",
    attributes: { group: 1 },
    revision: 1,
    score: 1.25,
  },
]);

test("identical active text evaluations share ranking and retain no completed result", async () => {
  const executions = new TextExecutions();
  const gate = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const control = { calls: 0 };
  const rank = () => {
    control.calls += 1;
    return gate.promise;
  };
  const timings = Array.from({ length: 4 }, () => new Headers());
  const pending = timings.map((headers) => executions.evaluate(root, input, headers, rank));
  expect(control.calls).toBe(1);
  gate.resolve(rows);
  expect(await Promise.all(pending)).toEqual([rows, rows, rows, rows]);
  expect(
    timings.filter((headers) => headers.get("server-timing")?.includes("text_inflight")),
  ).toHaveLength(3);
  const repeated = new Headers();
  expect(await executions.evaluate(root, input, repeated, rank)).toEqual(rows);
  expect(control.calls).toBe(2);
  expect(repeated.get("server-timing")).toBeNull();
});

test("root identity, coordinator ownership and every request input isolate active work", async () => {
  const executions = new TextExecutions();
  const other = new TextExecutions();
  const gate = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const control = { calls: 0 };
  const rank = () => {
    control.calls += 1;
    return gate.promise;
  };
  const variants = [
    input,
    Schema.decodeSync(Query)({ ...input, topK: 3 }),
    Schema.decodeSync(Query)({ ...input, match: "all" }),
    Schema.decodeSync(Query)({ ...input, text: "beta" }),
    Schema.decodeSync(Query)({
      ...input,
      filters: [{ field: "group", op: "eq", value: 1 }],
    }),
    Schema.decodeSync(Query)({ ...input, minimumSequence: 1 }),
    Schema.decodeSync(Query)({ ...input, consistency: "edge-eventual" }),
  ];
  const pending = variants.map((query) => executions.evaluate(root, query, new Headers(), rank));
  const changedRoot = Schema.decodeSync(Root)({ ...root, sequence: 3 });
  const changed = executions.evaluate(changedRoot, input, new Headers(), rank);
  const elsewhere = other.evaluate(root, input, new Headers(), rank);
  const sameSequence = executions.evaluate(
    Schema.decodeSync(Root)({ ...root }),
    input,
    new Headers(),
    rank,
  );
  expect(control.calls).toBe(variants.length + 3);
  gate.resolve(rows);
  expect(await Promise.all([...pending, changed, elsewhere, sameSequence])).toHaveLength(
    variants.length + 3,
  );
});

test("a failed text producer preserves the failure and releases its entry for retry", async () => {
  const executions = new TextExecutions();
  const gate = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const failure = new Error("Ranking backend failed");
  const rank = () => gate.promise;
  const pending = Promise.allSettled([
    executions.evaluate(root, input, new Headers(), rank),
    executions.evaluate(root, input, new Headers(), rank),
  ]);
  gate.reject(failure);
  for (const result of await pending) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(failure);
  }
  expect(
    await executions.evaluate(root, input, new Headers(), () => Promise.resolve(rows)),
  ).toEqual(rows);
});

test("a new root finishes independently while the old root still has waiting readers", async () => {
  const executions = new TextExecutions();
  const gate = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const captured = executions.evaluate(root, input, new Headers(), () => gate.promise);
  const follower = executions.evaluate(root, input, new Headers(), () => Promise.resolve([]));
  const changed = Schema.decodeSync(Root)({ ...root, sequence: 3 });
  const revised = Schema.decodeSync(QueryResult.fields.rows)([
    {
      id: "replacement",
      title: "Alpha",
      text: "alpha new",
      attributes: {},
      revision: 3,
      score: 2,
    },
  ]);
  expect(
    await executions.evaluate(changed, input, new Headers(), () => Promise.resolve(revised)),
  ).toEqual(revised);
  gate.resolve(rows);
  expect(await captured).toEqual(rows);
  expect(await follower).toEqual(rows);
});

test("settling one selection does not discard another active selection on the same root", async () => {
  const executions = new TextExecutions();
  const first = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const second = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const other = Schema.decodeSync(Query)({ ...input, text: "beta" });
  const control = { calls: 0 };
  const rank = () => {
    control.calls += 1;
    return second.promise;
  };
  const completed = executions.evaluate(root, input, new Headers(), () => first.promise);
  const active = executions.evaluate(root, other, new Headers(), rank);
  first.resolve(rows);
  await completed;
  const follower = executions.evaluate(root, other, new Headers(), rank);
  expect(control.calls).toBe(1);
  second.resolve(rows);
  expect(await Promise.all([active, follower])).toEqual([rows, rows]);
});

test("aborting the last waiter aborts ranking and ignores a later success", async () => {
  const executions = new TextExecutions();
  const gate = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const seen = { aborted: false };
  const rank = (signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      seen.aborted = true;
    });
    return gate.promise;
  };
  const caller = new AbortController();
  const pending = executions.evaluate(root, input, new Headers(), rank, caller.signal);
  caller.abort();
  gate.resolve(rows);
  const settled = await pending.then(
    () => "resolved",
    () => "rejected",
  );
  expect(settled).toBe("rejected");
  expect(seen.aborted).toBe(true);
});

test("an already aborted caller never starts a text producer", async () => {
  const executions = new TextExecutions();
  const caller = new AbortController();
  const reason = new Error("cancelled before ranking");
  const observed = { calls: 0 };
  caller.abort(reason);
  expect(
    await executions
      .evaluate(
        root,
        input,
        new Headers(),
        () => {
          observed.calls += 1;
          return Promise.resolve(rows);
        },
        caller.signal,
      )
      .catch((cause: unknown) => cause),
  ).toBe(reason);
  expect(observed.calls).toBe(0);
});

test("a producer aborting its caller during startup is observed without an unhandled rejection", async () => {
  const executions = new TextExecutions();
  const caller = new AbortController();
  const reason = new Error("caller aborted during startup");
  expect(
    await executions
      .evaluate(
        root,
        input,
        new Headers(),
        () => {
          caller.abort(reason);
          return Promise.reject(new Error("producer stopped"));
        },
        caller.signal,
      )
      .catch((cause: unknown) => cause),
  ).toBe(reason);
});

test("one of two waiters aborting leaves the shared ranking running", async () => {
  const executions = new TextExecutions();
  const gate = Promise.withResolvers<(typeof QueryResult.Type)["rows"]>();
  const seen = { aborted: false };
  const rank = (signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      seen.aborted = true;
    });
    return gate.promise;
  };
  const caller = new AbortController();
  const siblingSignal = new AbortController();
  const first = executions.evaluate(root, input, new Headers(), rank, caller.signal);
  const sibling = executions.evaluate(root, input, new Headers(), rank, siblingSignal.signal);
  caller.abort();
  expect(seen.aborted).toBe(false);
  gate.resolve(rows);
  expect(await sibling).toEqual(rows);
  const settled = await first.then(
    () => "resolved",
    () => "rejected",
  );
  expect(settled).toBe("rejected");
  expect(seen.aborted).toBe(false);
});

test("aborting the last waiter interrupts a nested Effect runtime", async () => {
  const executions = new TextExecutions();
  const entered = Promise.withResolvers<void>();
  const interrupted = { value: false };
  const rank = (signal: AbortSignal) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          entered.resolve();
        });
        return yield* Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              interrupted.value = true;
            }),
          ),
        );
      }),
      { signal },
    );
  const caller = new AbortController();
  const pending = executions.evaluate(root, input, new Headers(), rank, caller.signal);
  await entered.promise;
  caller.abort();
  const settled = await pending.then(
    () => "resolved",
    () => "rejected",
  );
  expect(settled).toBe("rejected");
  expect(interrupted.value).toBe(true);
});
