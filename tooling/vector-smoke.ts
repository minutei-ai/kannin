import { Config, Effect, Redacted, Schema } from "effect";
import { Query, QueryResult, Write, WriteResult } from "../src/protocol";

const url = new URL(Effect.runSync(Config.String("RAIO_URL")));
const token = Effect.runSync(Config.Redacted("RAIO_API_TOKEN"));
const namespace = `raio-ann-${crypto.randomUUID()}`;
const group = "ação".repeat(40);
const headers = {
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
};
const documents = Array.from({ length: 100 }, (_, index) => {
  const coordinates = { cosine: 0.9 + index / 1000, group: "distractor" };
  if (index >= 80) {
    coordinates.cosine = 0.51 + (index - 80) / 100;
    coordinates.group = group;
  }
  return {
    id: String(index),
    text: "native ANN validation",
    attributes: { group: coordinates.group, year: index },
    vector: [
      coordinates.cosine,
      Math.sqrt(1 - coordinates.cosine ** 2),
      ...Array.from({ length: 766 }, () => 0),
    ],
  };
});
console.error(`Native vector namespace: ${namespace}`);
const written = await fetch(new URL(`/v1/namespaces/${namespace}/write`, url), {
  method: "POST",
  headers,
  body: Schema.encodeSync(Schema.fromJsonString(Write))({
    schema: { filterable: ["group", "year"], vectorFilterFields: ["group", "year"] },
    requestId: "seed",
    upserts: documents,
    deletes: [],
  }),
});
if (!written.ok) throw new Error(`Native vector write failed: ${written.status}`);
const receipt = Schema.decodeUnknownSync(WriteResult)(await written.json());
const expected = Array.from({ length: 10 }, (_, index) => String(99 - index));
const observed = { visible: false, samples: 0, recall10: 0 };
for (const attempt of Array.from({ length: 60 }, (_, index) => index)) {
  const response = await fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
    method: "POST",
    headers,
    body: Schema.encodeSync(Schema.fromJsonString(Query))({
      kind: "vector",
      vector: [1, ...Array.from({ length: 767 }, () => 0)],
      topK: 10,
      filters: [{ field: "group", op: "eq", value: group }],
      minimumSequence: receipt.sequence,
    }),
  });
  if (!response.ok) throw new Error(`Native filtered ANN query failed: ${response.status}`);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  const ids = result.rows.map((row) => row.id);
  observed.samples += 1;
  observed.recall10 = ids.filter((id) => expected.includes(id)).length / expected.length;
  if (observed.recall10 === 1) {
    observed.visible = true;
    break;
  }
  if (attempt < 59) await Effect.runPromise(Effect.sleep("2 seconds"));
}
if (!observed.visible)
  throw new Error("Native filtered ANN failed to reach expected recall within observation window");
const numeric = { matches: 0, samples: 0, visible: false };
for (const attempt of Array.from({ length: 60 }, (_, index) => index)) {
  const interval = await fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
    method: "POST",
    headers,
    body: Schema.encodeSync(Schema.fromJsonString(Query))({
      kind: "vector",
      vector: [1, ...Array.from({ length: 767 }, () => 0)],
      topK: 10,
      filters: [
        { field: "year", op: "gte", value: 95 },
        { field: "year", op: "lt", value: 100 },
      ],
      minimumSequence: receipt.sequence,
    }),
  });
  if (!interval.ok) throw new Error(`Native numeric ANN query failed: ${interval.status}`);
  const ranged = Schema.decodeUnknownSync(QueryResult)(await interval.json());
  numeric.samples += 1;
  numeric.matches = ranged.rows.length;
  if (
    ranged.rows.length === 5 &&
    ranged.rows.every(
      (row) => Number(row.attributes.year) >= 95 && Number(row.attributes.year) < 100,
    )
  ) {
    numeric.visible = true;
    break;
  }
  if (attempt < 59) await Effect.runPromise(Effect.sleep("2 seconds"));
}
if (!numeric.visible)
  throw new Error(
    "Native numeric interval did not reach expected candidates within observation window",
  );
console.log(
  JSON.stringify({
    namespace,
    documents: documents.length,
    recall10: observed.recall10,
    visibilityPolls: observed.samples,
    numericIntervalMatches: numeric.matches,
    numericVisibilityPolls: numeric.samples,
    consistency: "strong",
  }),
);
