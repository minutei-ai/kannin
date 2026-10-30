import { encodeCanonicalDocuments } from "./segment-fixture";
import { afterAll, expect, test } from "bun:test";
import { Clock, Effect, Schema } from "effect";
import { Directory, EligibilityQuery, Segment, initSync } from "../dist/wasm/raio_engine";
import {
  EligibilityProjection,
  EligibleMinimum,
  Filter,
  NamespaceSchema,
  QueryResult,
  RootMigrationResult,
  Scalar,
  StoredRoot,
  TermFilters,
  VectorRebuildCheckpointMetadata,
} from "../src/protocol";
import { decodeRoot, decodeVectorRebuildSnapshot, encodeRoot } from "../src/manifest";
import { document, request, startWorker, textQuery, write } from "./harness";
import { legacyRootText, legacySnapshotText, migrationRootFacts } from "./legacy-root";

initSync({
  module: new WebAssembly.Module(
    await Bun.file(new URL("../dist/wasm/raio_engine_bg.wasm", import.meta.url)).arrayBuffer(),
  ),
});

const worker = await startWorker();
afterAll(() => worker.dispose());
const fields = Array.from({ length: 64 }, (_, index) => `f${String(index).padStart(2, "0")}`);
const schema = Schema.decodeSync(NamespaceSchema)({ filterable: fields, vectorFilterFields: [] });
const fixtures = Array.from({ length: 48 }, (_, index) =>
  document(
    String(index).padStart(3, "0"),
    "alpha beta ".repeat(1 + (index % 3)),
    Object.fromEntries(
      fields.map((field) => {
        if (field === "f00") return [field, index % 2];
        if (field === "f63") return [field, 2020 + (index % 2)];
        return [field, 0];
      }),
    ),
  ),
);

test("declared native producers agree across 64 fields and exact subset minima", () => {
  using segment = new Segment(
    encodeCanonicalDocuments(fixtures.map((source) => ({ ...source, revision: 1 }))),
    Schema.encodeSync(Schema.fromJsonString(NamespaceSchema.fields.filterable))(
      fields.toReversed(),
    ),
  );
  using directory = new Directory(segment.bytes());
  const names = Schema.encodeSync(Schema.fromJsonString(NamespaceSchema.fields.filterable))(fields);
  const encoded = segment.eligibility(names);
  if (encoded === undefined) throw new Error("Missing bounded declared-field model");
  expect(directory.eligibility(names)).toBe(encoded);
  const model = Schema.decodeSync(Schema.fromJsonString(EligibilityProjection))(encoded);
  expect(model.fields).toEqual(fields);
  for (const values of [
    [{ field: "f63", op: "gte", value: 2021 }],
    [
      { field: "f00", op: "eq", value: 1 },
      { field: "f63", op: "eq", value: 2021 },
    ],
    [
      { field: "f00", op: "eq", value: 0 },
      { field: "f00", op: "eq", value: 1 },
    ],
  ]) {
    const filters = Schema.encodeSync(TermFilters)(
      Schema.decodeUnknownSync(Schema.Array(Filter))(values),
    );
    using query = new EligibilityQuery(filters);
    expect(
      Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(query.minimum(encoded)),
    ).toEqual(
      Schema.decodeSync(Schema.fromJsonString(EligibleMinimum))(directory.minimum(filters)),
    );
  }
});

test("Unicode field order survives prepared eligibility models and exact subset minima", () => {
  const names = ["\uE000", "😀"];
  const encodeNames = Schema.encodeSync(Schema.fromJsonString(NamespaceSchema.fields.filterable));
  using segment = new Segment(
    encodeCanonicalDocuments([
      { ...document("a", "alpha beta", { "\uE000": "keep", "😀": 1 }), revision: 1 },
      { ...document("b", "alpha", { "\uE000": "keep", "😀": 0 }), revision: 1 },
      { ...document("c", "alpha beta gamma", { "\uE000": "drop", "😀": 1 }), revision: 1 },
    ]),
    encodeNames(names.toReversed()),
  );
  using directory = new Directory(segment.bytes());
  const encoded = segment.eligibility(encodeNames(names.toReversed()));
  if (encoded === undefined) throw new Error("Missing Unicode eligibility model");
  expect(directory.eligibility(encodeNames(names))).toBe(encoded);
  expect(Schema.decodeSync(Schema.fromJsonString(EligibilityProjection))(encoded).fields).toEqual(
    names,
  );
  const check = (
    filters: readonly (typeof Filter.Type)[],
    expected: typeof EligibleMinimum.Type,
  ) => {
    const input = Schema.encodeSync(TermFilters)(filters);
    using prepared = new EligibilityQuery(input);
    const minimum = Schema.decodeSync(Schema.fromJsonString(EligibleMinimum));
    expect(minimum(prepared.minimum(encoded))).toEqual(expected);
    expect(minimum(directory.minimum(input))).toEqual(expected);
  };
  check([{ field: "\uE000", op: "eq", value: "keep" }], [0, 1]);
  check([{ field: "😀", op: "eq", value: 1 }], [0, 2]);
  check(
    [
      { field: "😀", op: "eq", value: 1 },
      { field: "\uE000", op: "eq", value: "keep" },
    ],
    [0, 2],
  );
  check([{ field: "😀", op: "eq", value: 2 }], null);
});

test("write and compaction publish pooled declared models while subset ranking matches canonical fallback", async () => {
  const namespaces = ["eligibility-cutover", "eligibility-cutover-reference"] as const;
  for (const namespace of namespaces)
    for (const batch of Array.from({ length: 8 }, (_, index) => index))
      expect(
        (
          await request(worker, namespace, "write", {
            ...write(fixtures.slice(batch * 6, batch * 6 + 6)),
            schema,
          })
        ).status,
      ).toBe(200);
  const bucket = await worker.getR2Bucket("STORAGE");
  const object = await bucket.get(`namespaces/${namespaces[0]}/root.json`);
  if (object === null) throw new Error("Missing produced Root");
  const stored = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(await object.text());
  expect(stored.version).toBe(7);
  expect(stored.eligibilityModels).toHaveLength(1);
  expect(stored.segments.every((segment) => segment.eligibilityIndex === 0)).toBe(true);
  const logical = decodeRoot(Schema.encodeSync(Schema.fromJsonString(StoredRoot))(stored));
  expect(logical.segments[0]?.eligibility).toBe(logical.segments[1]?.eligibility);
  const referenceKey = `namespaces/${namespaces[1]}/root.json`;
  const referenceObject = await bucket.get(referenceKey);
  if (referenceObject === null) throw new Error("Missing reference Root");
  const reference = decodeRoot(await referenceObject.text());
  await bucket.put(
    referenceKey,
    encodeRoot({
      ...reference,
      segments: reference.segments.map((segment) =>
        Object.assign({}, segment, { eligibility: null }),
      ),
    }),
  );
  expect((await request(worker, namespaces[1], "rebuild", {})).status).toBe(200);
  for (const namespace of namespaces)
    expect(
      (
        await request(worker, namespace, "write", {
          ...write([], ["003", "017"]),
          schema,
        })
      ).status,
    ).toBe(200);
  for (const mode of ["any", "all", "phrase"] as const) {
    const input = {
      ...textQuery("alpha beta", 20, [{ field: "f00", op: "eq", value: 1 }]),
      match: mode,
    };
    const actualResponse = await request(worker, "eligibility-cutover", "query", input);
    const actual = Schema.decodeUnknownSync(QueryResult)(await actualResponse.json());
    const expected = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, "eligibility-cutover-reference", "query", input)).json(),
    );
    expect(actual).toEqual(expected);
    expect(actualResponse.headers.get("server-timing")).toContain(
      'catalog_root_eligibility;desc="hit"',
    );
    expect(actual.rows.every((row) => row.id !== "003" && row.id !== "017")).toBe(true);
  }
  const before = Schema.decodeUnknownSync(QueryResult)(
    await (
      await request(
        worker,
        "eligibility-cutover",
        "query",
        textQuery("alpha beta", 20, [{ field: "f63", op: "eq", value: 2021 }]),
      )
    ).json(),
  );
  expect((await request(worker, "eligibility-cutover", "compact", {})).status).toBe(200);
  const compacted = await bucket.get("namespaces/eligibility-cutover/root.json");
  if (compacted === null) throw new Error("Missing compacted Root");
  const root = decodeRoot(await compacted.text());
  expect(root.segments).toHaveLength(1);
  expect(root.segments[0]?.eligibility?.fields).toEqual(fields);
  expect(
    Schema.decodeUnknownSync(QueryResult)(
      await (
        await request(
          worker,
          "eligibility-cutover",
          "query",
          textQuery("alpha beta", 20, [{ field: "f63", op: "eq", value: 2021 }]),
        )
      ).json(),
    ),
  ).toEqual(before);
}, 30000);

test("an unsupported high-cardinality model stays null and retains canonical filtered results", async () => {
  const namespace = "eligibility-cutover-unsupported";
  const sources = Array.from({ length: 12 }, (_, index) =>
    document(String(index), "alpha beta", { group: `${"x".repeat(1024)}${index}` }),
  );
  expect(
    (
      await request(worker, namespace, "write", {
        ...write(sources),
        schema: { filterable: ["group"], vectorFilterFields: [] },
      })
    ).status,
  ).toBe(200);
  const object = await (
    await worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing unsupported Root");
  expect(decodeRoot(await object.text()).segments[0]?.eligibility).toBeNull();
  const response = await request(
    worker,
    namespace,
    "query",
    textQuery("alpha beta", 10, [{ field: "group", op: "eq", value: `${"x".repeat(1024)}0` }]),
  );
  expect(response.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(QueryResult)(await response.json()).rows.map((row) => row.id),
  ).toEqual(["0"]);
  expect(response.headers.get("server-timing")).not.toContain("catalog_root_eligibility");
});

test("Root model pools reject missing indices and malformed unused models", async () => {
  const namespace = "eligibility-cutover-contract";
  expect(
    (
      await request(worker, namespace, "write", {
        ...write([
          document("a", "alpha beta", { group: 0 }),
          document("b", "alpha beta", { group: 1 }),
        ]),
        schema: { filterable: ["group"], vectorFilterFields: [] },
      })
    ).status,
  ).toBe(200);
  const object = await (
    await worker.getR2Bucket("STORAGE")
  ).get(`namespaces/${namespace}/root.json`);
  if (object === null) throw new Error("Missing contract Root");
  const stored = Schema.decodeSync(Schema.fromJsonString(StoredRoot))(await object.text());
  const model = stored.eligibilityModels[0];
  if (model === undefined) throw new Error("Missing contract model");
  expect(() =>
    Schema.decodeSync(StoredRoot)({
      ...stored,
      segments: stored.segments.map((segment) => ({ ...segment, eligibilityIndex: 999 })),
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(StoredRoot)({
      ...stored,
      segments: stored.segments.map((segment) => {
        const { eligibilityIndex, ...without } = segment;
        expect(eligibilityIndex).toBe(0);
        return without;
      }),
    }),
  ).toThrow();
  const scalar = Schema.encodeSync(Schema.fromJsonString(Scalar))("x".repeat(400));
  for (const invalid of [
    { ...model, data: { kind: "joint", groups: [[[["0"]], -1, 0]] } },
    { ...model, data: { kind: "joint", groups: [[[[], []], 0, 0]] } },
    {
      ...model,
      data: { kind: "joint", groups: Array.from({ length: 16 }, () => [[[scalar]], 0, 1]) },
    },
    {
      fields: ["group", "unused"],
      data: { kind: "marginal", columns: [[["0", 0, 1]], [["{}", 0, 1]]] },
    },
  ])
    expect(() =>
      Schema.decodeUnknownSync(StoredRoot)({
        ...stored,
        eligibilityModels: [...stored.eligibilityModels, invalid],
      }),
    ).toThrow();
});

for (const version of [1, 2, 3, 4] as const)
  test(`v${version} migration derives canonical models and preserves checkpoint expiration`, async () => {
    const namespace = `eligibility-cutover-migrate-${version}`;
    const key = `namespaces/${namespace}/root.json`;
    const checkpointKey = `namespaces/${namespace}/vector-rebuild/00000000-0000-4000-8000-000000000001.json`;
    const declarations = { filterable: ["group"], vectorFilterFields: [] };
    expect(
      (
        await request(worker, namespace, "write", {
          ...write([
            document("a", "alpha beta", { group: 0 }),
            document("b", "alpha beta", { group: 1 }),
          ]),
          schema: declarations,
        })
      ).status,
    ).toBe(200);
    const bucket = await worker.getR2Bucket("STORAGE");
    const first = await bucket.get(key);
    if (first === null) throw new Error("Missing checkpoint source Root");
    const checkpointRoot = decodeRoot(await first.text());
    expect(
      (
        await request(worker, namespace, "write", {
          ...write([
            document("c", "alpha beta alpha beta", { group: 2 }),
            document("d", "alpha beta", { group: 3 }),
          ]),
          schema: declarations,
        })
      ).status,
    ).toBe(200);
    const current = await bucket.get(key);
    if (current === null) throw new Error("Missing migration Root");
    const currentRoot = decodeRoot(await current.text());
    const input = textQuery("alpha beta", 10, [{ field: "group", op: "gte", value: 1 }]);
    const expected = Schema.decodeUnknownSync(QueryResult)(
      await (await request(worker, namespace, "query", input)).json(),
    );
    const beforeEtags = await Promise.all(
      currentRoot.segments.map(
        async (segment) => [segment.key, (await bucket.head(segment.key))?.etag] as const,
      ),
    );
    const legacyRoot = await legacyRootText(bucket, currentRoot, version);
    const legacySnapshot = await legacySnapshotText(
      bucket,
      { root: checkpointRoot, fields: [] },
      version,
    );
    expect(() => decodeRoot(legacyRoot)).toThrow();
    expect(() => decodeVectorRebuildSnapshot(legacySnapshot)).toThrow();
    const expiresAt = Effect.runSync(Clock.currentTimeMillis) + 24 * 60 * 60 * 1000;
    await bucket.put(key, legacyRoot);
    await bucket.put(checkpointKey, legacySnapshot, {
      customMetadata: Schema.encodeSync(VectorRebuildCheckpointMetadata)({ expiresAt }),
    });
    await worker.unsafeEvictDurableObject("raio", "SearchNamespace", { name: namespace });
    expect((await request(worker, namespace, "query", input)).status).toBe(503);
    const response = await request(worker, namespace, "migrate-root", {});
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(RootMigrationResult)(await response.json())).toMatchObject({
      version: 8,
      rootRewritten: true,
      migratedSnapshots: 1,
      expiredSnapshots: 0,
    });
    const migrated = await bucket.get(key);
    const checkpoint = await bucket.get(checkpointKey);
    if (migrated === null || checkpoint === null) throw new Error("Missing migrated objects");
    expect(migrationRootFacts(decodeRoot(await migrated.text()))).toEqual(
      migrationRootFacts(currentRoot),
    );
    const migratedSnapshot = decodeVectorRebuildSnapshot(await checkpoint.text());
    expect(migratedSnapshot.fields).toEqual([]);
    expect(migrationRootFacts(migratedSnapshot.root)).toEqual(migrationRootFacts(checkpointRoot));
    expect(
      Schema.decodeUnknownSync(VectorRebuildCheckpointMetadata)(checkpoint.customMetadata)
        .expiresAt,
    ).toBe(expiresAt);
    expect(
      await Promise.all(
        currentRoot.segments.map(
          async (segment) => [segment.key, (await bucket.head(segment.key))?.etag] as const,
        ),
      ),
    ).toEqual(beforeEtags);
    expect(
      Schema.decodeUnknownSync(QueryResult)(
        await (await request(worker, namespace, "query", input)).json(),
      ),
    ).toEqual(expected);
    const repeated = Schema.decodeUnknownSync(RootMigrationResult)(
      await (await request(worker, namespace, "migrate-root", {})).json(),
    );
    expect(repeated).toMatchObject({ version: 8, rootRewritten: false, migratedSnapshots: 0 });
    expect((await bucket.head(key))?.etag).toBe(migrated.etag);
    expect((await bucket.head(checkpointKey))?.etag).toBe(checkpoint.etag);
  }, 15000);
