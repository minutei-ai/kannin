import { Config, Effect, Redacted, Schema } from "effect";
import { CollectionResult, Query, QueryResult, Write } from "../src/protocol";

const url = new URL(Effect.runSync(Config.String("RAIO_URL")));
const token = Effect.runSync(Config.Redacted("RAIO_API_TOKEN"));
const namespace = `raio-gc-${crypto.randomUUID()}`;
const headers = {
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
};
for (const index of [0, 1, 2]) {
  const response = await fetch(new URL(`/v1/namespaces/${namespace}/write`, url), {
    method: "POST",
    headers,
    body: Schema.encodeSync(Schema.fromJsonString(Write))({
      requestId: `seed-${index}`,
      upserts: [{ id: String(index), text: "native retention proof", attributes: {} }],
      deletes: [],
    }),
  });
  if (!response.ok) throw new Error(`Native retention write failed: ${response.status}`);
}
const compacted = await fetch(new URL(`/v1/namespaces/${namespace}/compact`, url), {
  method: "POST",
  headers,
  body: "{}",
});
if (!compacted.ok) throw new Error(`Native retention compaction failed: ${compacted.status}`);
const outcomes: Array<typeof CollectionResult.Type> = [];
for (const attempt of [0, 1]) {
  const response = await fetch(new URL(`/v1/namespaces/${namespace}/collect`, url), {
    method: "POST",
    headers,
    body: "{}",
  });
  if (!response.ok) throw new Error(`Native retention collection failed: ${response.status}`);
  const result = Schema.decodeUnknownSync(CollectionResult)(await response.json());
  if (result.scanned !== 4 || result.pinned !== 1 || result.deleted !== 0 || result.cursor !== null)
    throw new Error("Native retention failed to protect committed and quarantined segments");
  if (attempt === 0 && result.marked !== 3)
    throw new Error("Native collection did not establish three retirement markers");
  if (attempt === 1 && result.marked !== 0)
    throw new Error("Native collection restarted existing retirement clocks");
  outcomes.push(result);
}
const response = await fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
  method: "POST",
  headers,
  body: Schema.encodeSync(Schema.fromJsonString(Query))({
    kind: "text",
    text: "native",
    topK: 10,
    filters: [],
  }),
});
if (!response.ok) throw new Error(`Native retained corpus query failed: ${response.status}`);
const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
if (result.rows.length !== 3) throw new Error("Native retained corpus lost live documents");
console.log(
  JSON.stringify(
    {
      namespace,
      outcomes,
      liveDocuments: result.rows.length,
      physicalDeletion: "pending-24-hour-grace",
    },
    null,
    2,
  ),
);
