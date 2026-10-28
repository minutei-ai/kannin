# Portable API runtime

The root `Dockerfile` packages the complete native Kannin HTTP API, the shared TypeScript/Effect core and the Rust/WASM engine. It runs unchanged on Docker and Railway. It requires a strongly consistent S3-compatible bucket and a Qdrant collection, without Cloudflare credentials or services. `crates/native/Dockerfile` is a separate internal ranker.

Build with the declared Bun/Rust toolchain:

```sh
bun install --frozen-lockfile
bun run build
```

Supply configuration from an external environment file or secret manager. Never commit a deployment environment file. The bucket must already exist; startup checks existing canonical Roots and fails on unavailable or invalid storage.

| Variable                           | Purpose                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `RAIO_API_TOKEN`                   | Nonempty bearer token for every public namespace request                             |
| `KANNIN_STORAGE_ENDPOINT`          | S3-compatible HTTP(S) endpoint                                                       |
| `KANNIN_STORAGE_BUCKET`            | Dedicated canonical bucket                                                           |
| `KANNIN_STORAGE_REGION`            | Signing region, default `us-east-1`                                                  |
| `KANNIN_STORAGE_ACCESS_KEY_ID`     | External object-storage credential                                                   |
| `KANNIN_STORAGE_SECRET_ACCESS_KEY` | External object-storage credential                                                   |
| `KANNIN_VECTOR_ENDPOINT`           | Qdrant HTTP(S) endpoint                                                              |
| `KANNIN_VECTOR_COLLECTION`         | Collection name, default `kannin_vectors`                                            |
| `KANNIN_VECTOR_API_KEY`            | Qdrant credential; absence is allowed only for deliberately unsecured local backends |
| `HOST` / `PORT`                    | Listener, defaults `0.0.0.0:3000`                                                    |
| `KANNIN_WASM_PATH`                 | Native build artifact, default `./dist/wasm/raio_engine_bg.wasm`                     |

The server creates a missing Qdrant collection with 768-dimensional cosine vectors and validates an existing collection. Use the same bucket and vector configuration across replicas. No app volume is required. Persist and back up the object-storage service independently; ephemeral backend containers in the test suite are disposable fixtures, not production durability.

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

The scripts already include `--profile minutei`. Railway uses the local Docker context containing the generated artifacts, external backend variables, port 3000 and `/health`. Its native provider credentials come from the selected Alchemy profile. Docker uses the native provider's CLI selection (`DOCKER_BIN=podman` is supported upstream). These commands provision real resources; Railway has no complete local platform emulator. Build and inspect a plan before deployment. Keep Alchemy state, credentials and environment-specific values outside the tracked tree.

`bun run check` includes real RustFS/Qdrant conformance and OCI image execution through Podman. Install Podman before running the gate. Test fixtures bind backend ports to loopback, enforce CPU/memory caps and remove only their own containers/images. The OCI test uses host networking to reach those loopback fixtures; production networking is configured by the selected host.

Test containers also have a three-minute native Podman timeout, so an interrupted
test runner cannot leave them running indefinitely. On shared development hosts,
run heavy commands through the host's `resource-run` wrapper and use CI when the
full gate exceeds its resource budget. Do not create a fresh package cache or copy
Rust targets into each test attempt.

The portable image currently disables the optional HTTP cache and preserves the legacy native `vectorize-eventual` wire consistency label while identifying Qdrant correctly in health. Local tests establish only their asserted behavior. They do not establish hosted Railway behavior, real Vectorize behavior, performance parity or complete Turbopuffer compatibility. See [architecture gates](architecture.md#cloud-portability-gates) and the [public compatibility contract](turbopuffer-contracts.md).
