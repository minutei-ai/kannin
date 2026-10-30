# Portable API runtime

The root `Dockerfile` packages the complete native Kannin HTTP API, the shared TypeScript/Effect core and the Rust/WASM engine. It runs unchanged on Docker and Railway. It requires a strongly consistent S3-compatible bucket, without Cloudflare credentials or an external vector database. `crates/native/Dockerfile` is a separate internal ranker.

Build with the declared Bun/Rust toolchain:

```sh
bun install --frozen-lockfile
bun run build
```

Supply configuration from an external environment file or secret manager. Never commit a deployment environment file. The bucket must already exist; startup checks existing canonical Roots and fails on unavailable or invalid storage. The Root7 candidate reuses the bounded `migrate-root` operation during startup for supported older Root formats, then rereads the committed Root before resuming background jobs. Compare-and-swap conflicts are retried at most six times, preserving current manifests and immutable legacy logs/receipts. Root6-to-7 conversion is schema-only; older physical migrations retain their existing bounds and retirement policy. Malformed or unavailable canonical state still fails startup. This upgrade path remains pending the full gate.

The S3 adapter selects addressing through `KANNIN_STORAGE_URL_STYLE`: `path` preserves the existing default, while `virtual` selects virtual-hosted addressing. Railway documents virtual-hosted addressing for new buckets and path-style addressing for some older buckets; see [Railway URL styles](https://docs.railway.com/storage-buckets#url-style). The configuration tests and adapter change passed the [complete gate](https://github.com/minutei-ai/kannin/actions/runs/40877887921). Native Railway bucket wiring is present; hosted conditional-write conformance remains open; local path-style RustFS checks do not validate a new Railway bucket.

| Variable                           | Purpose                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `RAIO_API_TOKEN`                   | Nonempty bearer token for every public namespace request         |
| `KANNIN_STORAGE_ENDPOINT`          | S3-compatible HTTP(S) endpoint                                   |
| `KANNIN_STORAGE_BUCKET`            | Dedicated canonical bucket                                       |
| `KANNIN_STORAGE_REGION`            | Signing region, default `us-east-1`                              |
| `KANNIN_STORAGE_ACCESS_KEY_ID`     | External object-storage credential                               |
| `KANNIN_STORAGE_SECRET_ACCESS_KEY` | External object-storage credential                               |
| `HOST` / `PORT`                    | Listener, defaults `0.0.0.0:3000`                                |
| `KANNIN_WASM_PATH`                 | Native build artifact, default `./dist/wasm/raio_engine_bg.wasm` |

The Rust/WASM engine performs exact cosine search over the canonical vector frames in immutable segments. The native API accepts client-generated vectors with `schema.vectorDimensions` from 1 to 10,752, defaulting to 768. Dimension changes require reset; this extension passed the complete gate at `3f56aa6`. Portable coordination drops its current Root and receipt cache before releasing the operation semaphore, on success or failure. Queries retain their captured Root through a process-local reader lease until completion, protecting it from collection in that same coordinator; immutable byte/structure caches keep their separate budgets. This prevents idle actors from owning the last decoded manifest indefinitely. No RSS reduction has been measured for this change. The coordinator pool retains at most 1,024 namespace owners and only evicts owners with no foreground or background activity. If all owners are active, new-namespace admission fails with a retriable backend error instead of dropping an active owner and its reader leases. Pure admission tests cover active requests, background work, idle eviction and failure release; the real-S3 paused-reader regression passed the [complete gate at a4a1b3f](https://github.com/minutei-ai/kannin/actions/runs/40877887921). Use the same bucket configuration across replicas. No app volume or vector-service credentials are required. Persist and back up the object-storage service independently; ephemeral test backends are disposable fixtures, not production durability.

Reader leases are not shared across replicas. Strong queries now have a 30-second core deadline, captured before reading the Root and measured with both wall and monotonic clocks. Expiry returns HTTP 504 and releases the process-local pin; a late Root response cannot repopulate the coordinator's manifest cache. The portable adapter propagates cancellation into object acquisition and body streaming. Native R2 can leave one physical read in flight after cancellation, so the core also rejects late results before using them. Collection retains unreferenced segments for at least 24 hours. The bounded-reader changes passed the [complete gate at 4ec0fe7](https://github.com/minutei-ai/kannin/actions/runs/40933769064): 132 Rust tests and 537 Bun/workerd tests, including real S3 streaming cancellation, fast clock-controlled lease expiry and cache fill after caller cancellation. This does not establish hosted multi-replica conformance.

HTTP query cancellation propagates through the gateway and portable coordinator to the query fiber, including while the Root is loading or the query is waiting for admission. It does not wait for the 30-second deadline. The portable strong-reader regression includes a caller abort while the backend deliberately ignores cancellation; this case still requires the complete gate.

An immutable cache fill has its own 30-second origin budget and can finish in background after the caller's shorter cache lookup expires. This permits a slow successful origin read to populate the shared cache. Cache publication has a separate five-second budget. Query cancellation cancels its own range waiters; it cancels a coalesced producer only when no other waiter or non-cancellable caller still needs it.

Run the built server with the external variables already loaded:

```sh
bun run start
```

Run the same image with Docker:

```sh
docker build -t kannin-api .
docker run --rm --memory=512m --memory-swap=512m --cpus=1 \
  --env-file /absolute/external/path/kannin.env -p 3000:3000 kannin-api
```

`GET /health` is public. Namespace endpoints require `Authorization: Bearer <token>`. API shapes and limits remain in [api.md](api.md). The native in-process binding is also available from `portableApplication().binding`; authorize callers before handing them that capability.

Alchemy selects the target before loading its stack. It defaults to Railway:

The stacks live in `infra/railway.ts`, `infra/docker.ts` and `infra/cloudflare.ts`.
The entrypoint dynamically imports only the selected stack; choosing Railway or
Docker does not load the Cloudflare provider. The portable bundle has a regression
test that rejects Cloudflare runtime and Alchemy provisioning imports.

```sh
KANNIN_TARGET=railway bun run plan --stage railway
KANNIN_TARGET=railway bun run deploy --stage railway
KANNIN_TARGET=docker bun run deploy --stage docker
KANNIN_TARGET=cloudflare bun run deploy --stage prod
```

Railway keeps externally configured S3 storage as the default (`KANNIN_RAILWAY_STORAGE=external`). Selecting `KANNIN_RAILWAY_STORAGE=managed` declares a native Alchemy `Railway.Bucket` in the same project and passes its bucket name, endpoint, signing region, URL style and redacted credentials to the unchanged API image. Managed mode needs the service API token and native Railway provider authentication; it does not require external `KANNIN_STORAGE_*` credentials. Optional cache configuration still requires its own credential. The storage outputs are decoded before use, and a missing URL style fails rather than guessing. The project and canonical bucket use Alchemy’s native retain policy, preserving their physical resources when a declaration is removed or replaced; the API service keeps its normal lifecycle. This provisioning branch passed static checks and its configuration tests in the complete gate; no hosted bucket has been provisioned or validated here.

The scripts already include `--profile minutei`. Railway uses the local Docker context containing the generated artifacts, external backend variables, port 3000 and `/health`. Its native provider credentials come from the selected Alchemy profile. Docker uses the native provider's CLI selection (`DOCKER_BIN=podman` is supported upstream). These commands provision real resources; Railway has no complete local platform emulator. Build and inspect a plan before deployment. Keep Alchemy state, credentials and environment-specific values outside the tracked tree.

`bun run check` includes real RustFS conformance and native vector regressions and OCI image execution through Podman and the local default Docker Engine context. Both engines are prerequisites for the gate. Test fixtures bind backend ports to loopback, enforce CPU/memory caps and remove only their own containers/images. The OCI test transfers one native-built image through a temporary Docker archive, checks identical runtime configuration, operating system, architecture and ordered root-filesystem layer digests in both engines, then checks writes and text/vector reads after restarting each container. The transfer archive is removed after loading and the fixture scopes remove their own images/containers. The [complete gate at a4a1b3f](https://github.com/minutei-ai/kannin/actions/runs/40877887921) passed these Docker/Podman restart cases and the native-vector regressions. Tests use host networking to reach loopback fixtures; production networking is configured by the selected host.

Test containers also have a three-minute lifetime: native Podman timeout or GNU timeout inside the Docker test image, so an interrupted
test runner cannot leave them running indefinitely. On shared development hosts,
run heavy commands through the host's `resource-run` wrapper and use CI when the
full gate exceeds its resource budget. Do not create a fresh package cache or copy
Rust targets into each test attempt.

The portable image uses the optional immutable CDN cache when `KANNIN_CACHE_ENDPOINT` and `KANNIN_CACHE_TOKEN` are configured. Vector/hybrid queries report strong consistency against their captured canonical Root; health identifies `rust-wasm-object-storage`. The complete gate for this native-vector path passed at `a4a1b3f`. Local tests do not establish hosted Railway behavior, performance parity or complete Turbopuffer compatibility. See [architecture gates](architecture.md#cloud-portability-gates) and the [public compatibility contract](turbopuffer-contracts.md).

## Self-hosted immutable CDN cache

The Docker Alchemy stack creates a private cache service from `Dockerfile.cache`, based on the [official Varnish image](https://hub.docker.com/_/varnish) at version `9.1.0`, pinned by its multi-platform digest. A TypeScript/Effect gateway implements the existing internal `CacheProvider.open` and `CachePort.match/put/delete` contract. This is a single self-hosted cache location; geographic distribution requires deploying additional locations. Cloudflare keeps its native Cache API adapter.

The cache sits beside the API and accelerates immutable object reads. It does not proxy the public search API or handle S3 credentials. Each namespace request is still authenticated by the application. The application sends a separate service credential to the gateway; user Authorization and cookies are rejected as cache keys and response headers. The Docker stack publishes only the API port, with the cache reachable through the private network alias `http://kannin-cache:3000`.

For an existing Docker or Railway API deployment, supply `KANNIN_CACHE_ENDPOINT` and a separate nonempty `KANNIN_CACHE_TOKEN` through an external secret manager. An endpoint without a token is a startup configuration error. The default cache request budget is 250 ms (`KANNIN_CACHE_TIMEOUT_MS`); optional writes have a one-second minimum budget. A failed or unavailable cache leaves the existing canonical object-store fallback in control.

The private gateway protocol uses `GET`, `PUT` and `DELETE` at `/v1/cache/<cache-name>/<sha256-key>`, authenticated with `x-kannin-cache-token`. PUT includes the original immutable response headers encoded as base64 JSON in `x-kannin-cache-headers` and the body digest in `x-kannin-cache-sha256`. Transport responses use `Cache-Control: no-store`; only the internal client reconstructs the cached response. Direct access to the private Varnish or temporary fill origin is unavailable outside the container.

Only the four versioned immutable cache families are allowed: segments, overview batches, text plans and vector materializations. Keys include the object-store endpoint/bucket scope, cache family and complete internal versioned URL. Snapshot caches are disabled for this adapter, so mutable Roots and strong-read manifests never enter Varnish. This implements the immutable subset Kannin consumes from the [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/); it does not promise every browser Cache API option or Cloudflare network behavior.

PUT stages bounded bytes, warms a unique Varnish generation and publishes its metadata only after validation. DELETE removes the metadata pointer before acknowledging; an in-flight older fill cannot republish after deletion or replace a newer generation. Unreachable old generations expire or are evicted from the bounded Varnish cache. Body checksums and original response headers are validated at the adapter boundary. Eviction, restart, invalid data and network failure recover through canonical object storage.

Varnish uses a 64 MiB malloc cache and a 16 MiB shared log. The gateway caps entries at 8 MiB, staging at 32 MiB, metadata at 8 MiB, entry count at 4096, lifetime at one day and concurrent operations at four. The Alchemy Docker stack applies native 512 MiB memory, zero-swap and 0.5 CPU limits to both owned app and cache containers before starting them. No canonical state or persistent cache volume is added. Varnish's bounded working files remain in the container writable layer; standalone deployments can put them on an executable tmpfs:

```sh
docker build -f Dockerfile.cache -t kannin-cache .
docker run --rm --memory=512m --memory-swap=512m --cpus=0.5 --pids-limit=128 \
  --tmpfs /var/lib/varnish/varnishd:rw,exec,size=64m,mode=1777 \
  --network <private-app-network> --network-alias kannin-cache \
  --env-file /absolute/external/path/kannin-cache.env kannin-cache
```

The external cache environment file contains `KANNIN_CACHE_TOKEN`, matching the API's cache service credential. Do not publish the gateway port on a public interface. `GET /health` is public for container health checks. Build artifacts are generated by `bun run build`; no dependencies are installed when the container starts. Cache conformance covers the HTTP adapter and a real Varnish OCI image, including restart invalidation. These checks remain distinct from the complete `bun run check` gate and hosted deployment proof.

Portable segment migrations now use the same fresh immutable identity policy as ordinary writes. A retry creates a new segment key instead of republishing a deterministic key that another replica may already have captured for collection. Cloudflare keeps its existing serialized deterministic policy. The regression creates an abandoned migration through a rejected Root compare-and-swap, retries from another API instance, deletes the abandoned object and checks a strong read of the committed result. This correction and regression still require the full gate; they are not hosted multi-replica evidence.

## Bounded object-store deployment probe

The candidate `tooling/check-storage.ts` runs the same Effect object-store probe as the real RustFS test. It uses the runtime's shared `KANNIN_STORAGE_*` configuration and needs no API token, WASM build or Cloudflare account. It checks conditional create, a stale ETag, two concurrent conditional writers, range bytes and identity, opaque dot-segment keys, pagination, UTF-8 checkpoint expiry metadata and deletion visibility. It does not benchmark throughput or certify the public API, replica lifecycle or every S3 operation.

Supply credentials only through an external environment file or secret manager. On this shared host, invoke it through the resource guard:

```sh
/home/yorizel/.local/bin/resource-run bun --env-file /secure/kannin-storage.env tooling/check-storage.ts
```

The probe creates three tiny objects under its own random `kannin-conformance/<uuid>/` prefix. A successful conditional create establishes ownership. An ambiguous initial failure triggers a bounded metadata check and removes the control object only if its independent probe-owner token matches; a determinate precondition rejection never deletes it. Scoped finalizers attempt every owned deletion on success, failure and interruption, with a five-second budget per removal; cleanup failures remain failures. A successful report is emitted only after a final listing confirms the owned prefix is empty. The scenario has a 30-second budget, with five-second budgets for the initial create, each cleanup fiber and the final listing. The CLI races its scoped Effect against explicit SIGINT/SIGTERM handlers, waits for scoped finalization and exits nonzero when interrupted. Cleanup runs in fresh fibers so a pending caller interrupt does not skip DELETE. A server that commits after a cancelled request and after the ownership check may still leave a control object; an interrupted or failed run never emits a verified report. Do not treat a failed or interrupted probe as proof of complete cleanup when its backend is unavailable.

This probe and its failure/interruption/ambiguous-create cleanup regressions are source-only and await the complete gate. The probe requires lexicographic listing and immediate read/deletion visibility. The S3 adapter retries the specific `409 ConditionalRequestConflict` response at most twice for conditional writes, keeping the original ETag/precondition and bytes on every attempt. It never adopts a new ETag while retrying a stale manifest. Persistent conflicts and unrelated failures preserve their native causes. This follows the documented transient conflict category in the [S3 PutObject contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html); the HTTP-boundary tests remain separate from hosted conformance. No hosted bucket has been accessed with it; Railway conditional-write and metadata conformance remain unverified.
