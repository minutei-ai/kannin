# Effect SDK over Worker bindings

Install the public Git repository at a reviewed commit:

```sh
bun add kannin@github:minutei-ai/kannin#COMMIT_SHA
```

The package root exports Effect operations; `kannin/protocol` owns their Schemas, and `kannin/rpc` exports the binding contract. Effect is a peer dependency compatible with Effect 4, including Minutei's 4.0.0. The SDK has no Worker runtime, WASM, Alchemy or HTTP client imports. It does not provision infrastructure when imported.

Bind the deployed Search Worker's **KanninRpc** entrypoint. With Alchemy, resolve the existing Worker from its owning stack and state store:

```ts
import * as Cloudflare from "alchemy/Cloudflare";
import type { Entrypoint } from "kannin/rpc";

const search =
  yield *
  Cloudflare.Worker.ref("Search", {
    stack: "Raio",
    stage: "prod",
  });

KANNIN: Cloudflare.WorkerEntrypoint<Entrypoint>(search, "KanninRpc");
```

The Alchemy example requires the declared [entrypoint patch](../patches/alchemy@2.0.0-beta.83.patch) for beta.83. Its original guard recognizes only objects, while a lazy `Worker.ref` is a callable proxy. Without the fix, a foreign named binding silently becomes a binding to the consumer's default entrypoint. The patch accepts callable resource references in both the TypeScript and emitted runtime entry points. Carry the same fix at the consumer's package-manager patch owner when using an affected Alchemy version; installing the SDK does not patch the consumer's infrastructure dependencies. Remove this patch section when the resolved upstream implementation passes `entrypoint.test.ts` without it. Minutei's Alchemy version must be checked independently before configuring its production binding.

Use the consumer's existing process runtime and native environment. For example, at the service Layer that owns the binding:

```ts
import { Effect } from "effect";
import * as Search from "kannin";

const results = Search.query("legal-corpus", {
  kind: "text",
  text: "responsabilidade civil",
  topK: 10,
  filters: [],
  minimumSequence: 42,
}).pipe(Effect.provideService(Search.Kannin, env.KANNIN));
```

Declare filterable attributes through the same binding before querying them:

```ts
const configured = Search.write("legal-corpus", {
  requestId: "configure-schema-v1",
  schema: {
    filterable: ["authority", "year"],
    vectorFilterFields: ["authority", "year"],
  },
  upserts: [],
  deletes: [],
}).pipe(Effect.provideService(Search.Kannin, env.KANNIN));
```

The namespace owns this schema in R2. Other attributes remain stored and returned but cannot be filtered. Declare the schema on the first write to keep unselected attributes out of new segment headers; compaction also applies this projection when it rewrites segments. Later writes can omit `schema`; changing it requires an explicit reset and reimport. See [schema and migration semantics](api.md). BM25 still uses `title` and `text`; arbitrary full-text columns remain a delivery gate.

`query`, `write`, `metadata`, `compact`, `collect`, `rebuild`, `synchronizeVectors` and `rebuildVectors` return Effects. Input and result types come from the same Schemas as the server. `Rejected` failures retain their status and message and can be handled with `Effect.catchTag("Rejected", ...)`; invalid contracts fail with `SchemaError`, and native binding failures retain their cause in `UnknownError`. No operation retries automatically: retain the same write `requestId` when retrying an uncertain write. An Effect interruption cannot roll back a remote mutation that has already committed.

Both Worker-to-Worker and Worker-to-coordinator calls use native RPC, with structured records rather than Request/Response transport. The namespace coordinator owns the same mutation lock, read leases, sequence barriers, ranking and R2 persistence as the HTTP API. Explicit edge-eventual text queries retain the bounded-age snapshot path and recover through coordinator RPC. Vector visibility remains eventual.

A service binding is an account-controlled capability granting access to all Kannin namespaces. It does not use the public HTTP bearer token. Minutei must authorize the actor and workspace and select the permitted namespace on the server before invoking the SDK. Do not expose the binding or arbitrary namespace selection to a browser. The public HTTP API retains its existing authentication.

The workerd integration test connects two Workers and disables HTTP on both the search Worker and its coordinator. It checks writes, idempotency/conflicts, filters, reads, deletions, namespace isolation, sequence barriers and maintenance operations. A separate native Cloudflare canary verified the service binding destination, writes, idempotency/conflicts, filtered and edge queries, deletion and typed failures. Its namespace was reset to zero documents and zero vector-outbox entries, and its temporary Worker was removed. Neither check configures Minutei's production binding or establishes a network latency improvement.
