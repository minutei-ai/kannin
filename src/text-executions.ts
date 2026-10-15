import { Clock, Effect, Schema } from "effect";
import { Query } from "./protocol";
import type { QueryResult, Root } from "./protocol";

const encodeQuery = Schema.encodeSync(Schema.fromJsonString(Query));

export class TextExecutions {
  private readonly roots = new WeakMap<
    typeof Root.Type,
    Map<string, Promise<(typeof QueryResult.Type)["rows"]>>
  >();

  async evaluate(
    root: typeof Root.Type,
    input: typeof Query.Type,
    timings: Headers,
    rank: () => Promise<(typeof QueryResult.Type)["rows"]>,
  ) {
    const identity = encodeQuery(input);
    const queries = this.roots.get(root) ?? new Map<string, ReturnType<typeof rank>>();
    this.roots.set(root, queries);
    const pending = queries.get(identity);
    if (pending !== undefined) {
      timings.append("server-timing", 'text_phase;desc="shared"');
      const started = Effect.runSync(Clock.currentTimeNanos);
      const rows = await pending;
      const ended = Effect.runSync(Clock.currentTimeNanos);
      timings.append("server-timing", `text_inflight;dur=${Number(ended - started) / 1e6}`);
      return rows;
    }
    const acquired = rank().finally(() => {
      queries.delete(identity);
      if (queries.size === 0) this.roots.delete(root);
    });
    queries.set(identity, acquired);
    return acquired;
  }
}
