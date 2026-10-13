import { Config, Effect, Redacted, Schema } from "effect";
import { NamespacePage, VectorRebuild, VectorRebuildResult } from "../src/protocol";

const url = new URL(Effect.runSync(Config.String("RAIO_URL")));
const token = Effect.runSync(Config.Redacted("RAIO_API_TOKEN"));
const headers = {
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
};
const page = { cursor: "", complete: false, namespaces: 0, submitted: 0 };
while (!page.complete) {
  const target = new URL("/admin/namespaces", url);
  if (page.cursor.length > 0) target.searchParams.set("cursor", page.cursor);
  const response = await fetch(target, { headers });
  if (!response.ok) throw new Error(`Namespace inventory failed: ${response.status}`);
  const inventory = Schema.decodeUnknownSync(NamespacePage)(await response.json());
  for (const namespace of inventory.names) {
    const progress = { cursor: Schema.decodeSync(VectorRebuild)({}), complete: false };
    while (!progress.complete) {
      const rebuilt = await fetch(new URL(`/v1/namespaces/${namespace}/vector-rebuild`, url), {
        method: "POST",
        headers,
        body: Schema.encodeSync(Schema.fromJsonString(VectorRebuild))(progress.cursor),
      });
      if (!rebuilt.ok) throw new Error(`Vector migration failed: ${rebuilt.status}`);
      const result = Schema.decodeUnknownSync(VectorRebuildResult)(await rebuilt.json());
      page.submitted += result.submitted;
      progress.complete = result.complete;
      if (!result.complete) {
        if (result.snapshot === null) throw new Error("Missing migration snapshot");
        progress.cursor = { snapshot: result.snapshot, segment: result.segment, row: result.row };
      }
    }
    page.namespaces += 1;
  }
  if (inventory.cursor === null) page.complete = true;
  else page.cursor = inventory.cursor;
}
console.log(
  JSON.stringify({
    namespaces: page.namespaces,
    submitted: page.submitted,
    visibility: "vectorize-eventual",
  }),
);
