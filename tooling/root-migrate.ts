import { Config, Effect, Redacted, Schema } from "effect";
import { NamespacePage, RootMigrationResult, NamespaceCatalogActivation } from "../src/protocol";

const url = new URL(Effect.runSync(Config.String("RAIO_URL")));
const token = Effect.runSync(Config.Redacted("RAIO_API_TOKEN"));
const headers = { authorization: `Bearer ${Redacted.value(token)}` };
const progress = { cursor: "", complete: false, namespaces: 0, roots: 0, snapshots: 0, expired: 0 };
while (!progress.complete) {
  const target = new URL("/admin/namespaces", url);
  if (progress.cursor.length > 0) target.searchParams.set("cursor", progress.cursor);
  const listed = await fetch(target, { headers });
  if (!listed.ok) throw new Error(`Root migration inventory failed: ${listed.status}`);
  const page = Schema.decodeUnknownSync(NamespacePage)(await listed.json());
  for (const namespace of page.names) {
    const response = await fetch(new URL(`/v1/namespaces/${namespace}/migrate-root`, url), {
      method: "POST",
      headers,
    });
    if (!response.ok) throw new Error(`Root migration failed: ${response.status}`);
    const result = Schema.decodeUnknownSync(RootMigrationResult)(await response.json());
    progress.namespaces += 1;
    if (result.rootRewritten) progress.roots += 1;
    progress.snapshots += result.migratedSnapshots;
    progress.expired += result.expiredSnapshots;
  }
  if (page.cursor === null) progress.complete = true;
  else progress.cursor = page.cursor;
}
const activated = await fetch(new URL("/admin/namespaces/catalog", url), {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: Schema.encodeSync(Schema.fromJsonString(NamespaceCatalogActivation))({ version: 1 }),
});
if (!activated.ok) throw new Error(`Namespace catalog activation failed: ${activated.status}`);
Schema.decodeUnknownSync(NamespaceCatalogActivation)(await activated.json());
console.log(
  JSON.stringify({
    namespaces: progress.namespaces,
    roots: progress.roots,
    snapshots: progress.snapshots,
    expired: progress.expired,
  }),
);
