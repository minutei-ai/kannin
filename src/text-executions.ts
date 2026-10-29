import { Clock, Effect, Schema } from "effect";
import { Query } from "./protocol";
import type { QueryResult, Root } from "./protocol";

const encodeQuery = Schema.encodeSync(Schema.fromJsonString(Query));

type TextRows = (typeof QueryResult.Type)["rows"];

type SharedTextExecution = {
  readonly controller: AbortController;
  readonly waiters: { count: number };
  readonly anchored: { value: boolean };
  readonly settled: { value: boolean };
  promise: Promise<TextRows> | undefined;
};

function leaveTextWaiter(
  shared: SharedTextExecution,
  signal: AbortSignal,
  participation: { active: boolean },
  onAbort: () => void,
  abort: boolean,
) {
  if (!participation.active) return;
  participation.active = false;
  signal.removeEventListener("abort", onAbort);
  shared.waiters.count -= 1;
  if (abort && shared.waiters.count === 0 && !shared.anchored.value) shared.controller.abort();
}

function joinTextExecution(shared: SharedTextExecution, callerSignal?: AbortSignal) {
  const promise = shared.promise;
  if (promise === undefined) return Promise.reject(new Error("Missing shared text execution"));
  if (callerSignal === undefined) {
    shared.anchored.value = true;
    return promise;
  }
  const signal = callerSignal;
  const participation = { active: true };
  shared.waiters.count += 1;
  const onAbort = () => {
    leaveTextWaiter(shared, signal, participation, onAbort, true);
  };
  const observed = promise.then(
    (rows) => {
      leaveTextWaiter(shared, signal, participation, onAbort, false);
      signal.throwIfAborted();
      return rows;
    },
    (cause: unknown) => {
      leaveTextWaiter(shared, signal, participation, onAbort, false);
      signal.throwIfAborted();
      throw cause;
    },
  );
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort);
  return observed;
}

function startTextExecution(
  roots: WeakMap<typeof Root.Type, Map<string, SharedTextExecution>>,
  queries: Map<string, SharedTextExecution>,
  root: typeof Root.Type,
  identity: string,
  rank: (signal: AbortSignal) => Promise<TextRows>,
) {
  const shared: SharedTextExecution = {
    controller: new AbortController(),
    waiters: { count: 0 },
    anchored: { value: false },
    settled: { value: false },
    promise: undefined,
  };
  const promise = rank(shared.controller.signal)
    .then(
      (rows) => {
        shared.settled.value = true;
        return rows;
      },
      (cause: unknown) => {
        shared.settled.value = true;
        throw cause;
      },
    )
    .finally(() => {
      if (queries.get(identity) === shared) queries.delete(identity);
      if (queries.size === 0) roots.delete(root);
    });
  shared.promise = promise;
  queries.set(identity, shared);
  return shared;
}

export class TextExecutions {
  private readonly roots = new WeakMap<typeof Root.Type, Map<string, SharedTextExecution>>();

  async evaluate(
    root: typeof Root.Type,
    input: typeof Query.Type,
    timings: Headers,
    rank: (signal: AbortSignal) => Promise<TextRows>,
    callerSignal?: AbortSignal,
  ) {
    callerSignal?.throwIfAborted();
    const identity = encodeQuery(input);
    const queries = this.roots.get(root) ?? new Map<string, SharedTextExecution>();
    this.roots.set(root, queries);
    const pending = queries.get(identity);
    const selected = { shared: pending };
    if (
      selected.shared !== undefined &&
      selected.shared.controller.signal.aborted &&
      !selected.shared.settled.value
    ) {
      queries.delete(identity);
      if (queries.size === 0) this.roots.delete(root);
      selected.shared = undefined;
    }
    if (selected.shared !== undefined) {
      timings.append("server-timing", 'text_phase;desc="shared"');
      const started = Effect.runSync(Clock.currentTimeNanos);
      const rows = await joinTextExecution(selected.shared, callerSignal);
      const ended = Effect.runSync(Clock.currentTimeNanos);
      timings.append("server-timing", `text_inflight;dur=${Number(ended - started) / 1e6}`);
      return rows;
    }
    const created = this.roots.get(root) ?? queries;
    this.roots.set(root, created);
    return joinTextExecution(
      startTextExecution(this.roots, created, root, identity, rank),
      callerSignal,
    );
  }
}
