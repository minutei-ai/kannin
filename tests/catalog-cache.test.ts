import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Health, QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

test("oversized field projections preserve hot term entries through filter selector eviction", async () => {
  const worker = await startWorker();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  for (const id of ["left", "right"])
    expect(
      (
        await request(
          worker,
          "selector-churn",
          "write",
          write([
            document(id, "shared"),
            ...Array.from({ length: 499 }, (_, index) =>
              document(`${id}-${index}`, "filler", { group: index }),
            ),
          ]),
        )
      ).ok,
    ).toBe(true);
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "selector-churn", "query", textQuery("shared"))).json(),
  );
  expect(original.rows.map((row) => row.id)).toEqual(["left", "right"]);
  const transferred = { bytes: 0 };
  for (const index of Array.from({ length: 64 }, (_, ordinal) => ordinal)) {
    const before = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const filtered = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(
          worker,
          "selector-churn",
          "query",
          textQuery("shared", 10, [
            { field: "group", op: "ne", value: `${"x".repeat(16384)}${index}` },
          ]),
        )
      ).json(),
    );
    const after = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    expect(filtered.rows).toEqual(original.rows);
    expect(filtered.sequence).toBe(original.sequence);
    expect(after.termReads - before.termReads).toBe(2);
    expect(after.termCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    if (index === 0) transferred.bytes = after.termBytes - before.termBytes;
    else expect(after.termBytes - before.termBytes).toBe(transferred.bytes);
  }
});
