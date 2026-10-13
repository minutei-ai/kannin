# Alchemy native Vectorize inference patch

Version: `alchemy@2.0.0-beta.83`.

The installed `WorkerAsyncBindings` recognizes a `Cloudflare.Vectorize.Index` and emits the native `vectorize` binding using its index name. The installed `InferEnv.GetBindingType` has no matching Vectorize branch. A Worker declaring `env: { VECTORS: index }` therefore infers the provisioning `Index` resource instead of the native Cloudflare `Vectorize` client, rejecting `env.VECTORS.query`, `upsert`, and `deleteByIds` at typecheck.

The package-manager-declared patch adds `Index -> Vectorize` to the owning mapping in both source and distributed declarations. It changes no runtime code. The application imports native inferred environment types, without casts or an alternate production client. `bun run check` typechecks the actual application calls; local transport tests separately exercise the same method contracts. The patch can be removed when the resolved upstream Alchemy version includes this inference branch. Installed-file edits are not the deliverable; `patches/alchemy@2.0.0-beta.83.patch` and the Bun manifest/lockfile carry the change.
