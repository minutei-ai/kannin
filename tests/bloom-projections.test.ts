import { decodeRoot } from "../src/manifest";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { BloomBatch, initSync } from "../dist/wasm/raio_engine";
import { Health, Metadata, QueryResult } from "../src/protocol";
import { document, request, startWorker, textQuery, write } from "./harness";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

test("Bloom term masks reuse projections and preserve global scoring across sparse terms", async () => {
  const worker = await startWorker();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => worker.dispose());
  await Promise.all(
    ["masked", "oracle"].map(async (namespace) => {
      for (const index of Array.from({ length: 16 }, (_, i) => i))
        expect(
          (
            await request(
              worker,
              namespace,
              "write",
              write([
                document(String(index).padStart(2, "0"), `common unique${index}`, {
                  group: index % 2,
                }),
              ]),
            )
          ).status,
        ).toBe(200);
    }),
  );
  for (const operation of ["compact", "compact", "compact"])
    expect((await request(worker, "oracle", operation, {})).status).toBe(200);
  expect(
    Schema.decodeUnknownSync(Metadata)(await (await request(worker, "oracle", "metadata")).json())
      .segments,
  ).toBe(1);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get("namespaces/masked/root.json");
  if (object === null) throw new Error("Missing masked manifest");
  const root = decodeRoot(await object.text());
  const columns = await Promise.all(
    root.bloomPacks.map(async (pack) => {
      const columnObject = await bucket.get(pack.key, {
        range: { offset: pack.term.offset, length: pack.term.length },
      });
      if (columnObject === null) throw new Error("Missing term Bloom column");
      const column = new Uint8Array(await columnObject.arrayBuffer());
      expect(column.byteLength).toBe(pack.term.length);
      return column;
    }),
  );
  const bitsets = root.segments.map((segment) => {
    const pack = root.bloomPacks[segment.bloom.packIndex];
    const column = columns[segment.bloom.packIndex];
    if (pack === undefined || column === undefined) throw new Error("Missing Bloom pack");
    return column.slice(
      pack.term.offsets[segment.bloom.row],
      pack.term.offsets[segment.bloom.row + 1],
    );
  });
  const bytes = new Uint8Array(bitsets.flatMap((bits) => Array.from(bits)));
  const offsets = new Uint32Array(bitsets.length + 1);
  const cursor = { offset: 0 };
  for (const [index, bits] of bitsets.entries()) {
    offsets[index] = cursor.offset;
    cursor.offset += bits.byteLength;
  }
  offsets[bitsets.length] = cursor.offset;
  using bloom = new BloomBatch(bytes, offsets);
  const probes = ["unique1", "unique2", ...Array.from({ length: 32 }, (_, i) => `missing${i}`)];
  const matches = Schema.decodeSync(
    Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
  )(bloom.filter(JSON.stringify(probes)));
  const possible = new Set(matches.flat());
  const missing = probes.find((word) => word.startsWith("missing") && !possible.has(word));
  if (missing === undefined) throw new Error("Missing negative Bloom probe");
  const original = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "masked", "query", textQuery("common"))).json(),
  );
  const before = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  const absent = Schema.decodeUnknownSync(QueryResult)(
    await (await request(worker, "masked", "query", textQuery(`common ${missing}`))).json(),
  );
  expect(absent).toEqual(original);
  const after = Schema.decodeUnknownSync(Health)(
    await (await fetch(new URL("/health", await worker.ready))).json(),
  );
  expect(after.termReads - before.termReads).toBe(0);
  expect(after.termRequests - before.termRequests).toBe(0);
  expect(after.textPlanCacheHits - before.textPlanCacheHits).toBe(1);
  for (const match of ["all", "phrase"] as const) {
    const result = Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(worker, "masked", "query", { ...textQuery(`common ${missing}`), match })
      ).json(),
    );
    expect(result.rows).toHaveLength(0);
  }
  for (const term of ["unique1", "unique2"]) {
    const prior = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    const text = `common unique1 ${term} ${missing}`;
    const response = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "masked", "query", textQuery(text))).json(),
    );
    const acquired = Schema.decodeUnknownSync(Health)(
      await (await fetch(new URL("/health", await worker.ready))).json(),
    );
    expect(acquired.termReads - prior.termReads).toBe(
      matches.filter((selected) => selected.includes(term)).length,
    );
    const expected = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "oracle", "query", textQuery(text))).json(),
    );
    expect(response).toEqual(expected);
  }
  for (const namespace of ["masked", "oracle"])
    expect(
      (
        await request(
          worker,
          namespace,
          "write",
          write([document("01", "common replaced", { group: 1 })]),
        )
      ).status,
    ).toBe(200);
  for (const consistency of ["strong", "edge-eventual"] as const) {
    const input = {
      ...textQuery(`common unique1 unique2 ${missing}`, 10, [
        { field: "group", op: "eq", value: 0 },
      ]),
      consistency,
      minimumSequence: 17,
    };
    const result = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "masked", "query", input)).json(),
    );
    const expected = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "oracle", "query", input)).json(),
    );
    expect(result).toEqual(expected);
    expect(result.rows[0]?.id).toBe("02");
  }
});
