# Effect SDK over Worker bindings

Install the public Git repository at a reviewed commit:

```sh
bun add kannin@github:minutei-ai/kannin#COMMIT_SHA
```

The package root exports Effect operations; `kannin/protocol` owns their Schemas, and `kannin/rpc` exports the binding contract. Effect is a peer dependency compatible with Effect 4, including Minutei's 4.0.0. The SDK has no Worker runtime, WASM, Alchemy or HTTP client imports. It does not provision infrastructure when imported.

Bind the deployed Search Worker's **KanninRpc** entrypoint. With Alchemy, resolve the existing Worker from its owning stack and state store:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Entrypoint } from "kannin/rpc";

const search =
  yield *
  Cloudflare.Worker.ref("Search", {
    stack: "Raio",
    stage: "prod",
  });

KANNIN: Cloudflare.WorkerEntrypoint<Entrypoint>(search, "KanninRpc");
```

The example targets `@alchemy.run/cloudflare@2.0.0-beta.84`. Its native resource guard recognizes lazy callable `Worker.ref` values; no package patch is needed. The regression is covered by `tests/entrypoint.test.ts`. Consumers on older Alchemy versions must independently check their resolved provider before configuring production bindings.

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

List namespaces through the same native binding, without HTTP:

```ts
const page = Search.namespaces({ prefix: "legal-", page_size: 100 }).pipe(
  Effect.provideService(Search.Kannin, env.KANNIN),
);
```

The result contains `namespaces` and an optional `next_cursor`. Pass it back as `cursor` with the same prefix. The same migration readiness, catalog validation and page limits as the public listing apply; the namespace coordinator is not acquired for this global operation.

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

The namespace owns this schema in R2. Other attributes remain stored and returned but cannot be filtered. Declarations allow up to 64 names and queries up to 16 predicates; bounded native Root eligibility models support query subsets, with canonical catalog fallback when a model is unavailable. Declare the schema on the first write to keep unselected attributes out of new segment headers; compaction also applies this projection when it rewrites segments. Later writes can omit `schema`; changing it requires an explicit reset and reimport. See [schema and migration semantics](api.md). BM25 still uses `title` and `text`; arbitrary full-text columns remain a delivery gate.

`query`, `write`, `metadata`, `compact`, `collect`, `rebuild`, `migrateRoot`, `synchronizeVectors` and `rebuildVectors` return Effects. Input and result types come from the same Schemas as the server. `Rejected` failures retain their status and message and can be handled with `Effect.catchTag("Rejected", ...)`; invalid contracts fail with `SchemaError`, and native binding failures retain their cause in `UnknownError`. No operation retries automatically: retain the same write `requestId` when retrying an uncertain write. An Effect interruption cannot roll back a remote mutation that has already committed.

The SDK decodes reply framing and declared failures, then validates a successful payload once against the invoked operation's concrete result Schema. It does not normalize the payload through the union of every operation result first. If an extended payload satisfies more than one operation shape, the invoked operation determines the returned fields; union member order does not select the result. Invalid framing, invalid operation payloads and malformed declared failures remain Schema errors. The wire contract is unchanged. The server validates query results through QueryResult before wrapping RPC success, so it does not traverse those rows again through the generic result union. Both strong coordinator and edge-eventual query paths retain that concrete validation; maintenance and failure encoding keep their existing contracts.

`migrateRoot(namespace)` returns `RootMigrationResult` with `version: 5` through the same native binding. It converts legacy Root v1–v4 data and unexpired rebuild checkpoints, including converted immutable segments, remapped common-leader ranges and Bloom segment keys. Versions 1/2 derive eligibility once; versions 3/4 preserve existing models. Inline Bloom versions publish verified packs; v4 reuses pack bytes and digests. Sequence, document revisions, vector epochs, jobs and absolute checkpoint expiry survive conversion. Checkpoint ETag commits precede Root activation. Ordinary reads require the current persisted format. See [migration ownership](architecture.md).

Both Worker-to-Worker and Worker-to-coordinator calls use native RPC, with structured records rather than Request/Response transport. The namespace coordinator owns the same mutation lock, read leases, sequence barriers, ranking and R2 persistence as the HTTP API. Explicit edge-eventual text queries retain the bounded-age snapshot path and recover through coordinator RPC. Vector visibility remains eventual.

A service binding is an account-controlled capability granting access to all Kannin namespaces. It does not use the public HTTP bearer token. Minutei must authorize the actor and workspace and select the permitted namespace on the server before invoking the SDK. Do not expose the binding or arbitrary namespace selection to a browser. The public HTTP API retains its existing authentication.

The workerd integration test connects two Workers and disables HTTP on both the search Worker and its coordinator. It checks writes, idempotency/conflicts, filters, reads, deletions, namespace isolation, sequence barriers and maintenance operations. A separate native Cloudflare canary verified the service binding destination, writes, idempotency/conflicts, filtered and edge queries, deletion and typed failures. Its namespace was reset to zero documents and zero vector-outbox entries, and its temporary Worker was removed. Neither check configures Minutei's production binding or establishes a network latency improvement.

The local same-backend transport comparison preserves all 32 responses/16 pairs through this native SDK and service-binding HTTP. It does not establish a native RPC speedup: dense cold/warm medians are 825.41/27.98 ms versus 765.27/21.28 ms for the local HTTP binding arm. Public network and Cloudflare production latency remain unmeasured. See [method and limits](performance.md#native-binding-transport-on-the-same-backend).
