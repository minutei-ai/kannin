# Alchemy provider packaging patch

Kannin uses `alchemy@2.0.0-beta.84` and `@alchemy.run/cloudflare@2.0.0-beta.84`.

The resolved Cloudflare provider includes the native `Vectorize.Index -> Vectorize` mapping and the native WorkerEntrypoint resource guard. The former beta.83 patch is removed; `tests/entrypoint.test.ts` exercises callable foreign references and self bindings against the upstream implementation.

The published beta.84 provider imports `Queues/LocalQueueGateway.ts` from `WriteQueueLocal.ts`, but ships neither that source nor its emitted JavaScript module. Importing the provider fails before the stack or entrypoint tests can run. The Bun-declared [packaging patch](../patches/@alchemy.run%252Fcloudflare@2.0.0-beta.84.patch) adds that gateway using the installed runtime's native `Queue.local` and scoped `PlatformProxy.open`, following the provider's existing R2 gateway pattern. It uses the same local runtime directory and retains native failures as `SendError` causes. It adds no HTTP transport or alternative broker. The JavaScript addition is generated from the TypeScript source with Bun's native transpiler.

Remove this patch when the published provider supplies its gateway and both provider imports and the entrypoint regression pass without it. Workerd application tests exercise the application's native queue bindings; they do not prove this optional deploy-time gateway's delivery behavior or hosted Vectorize behavior.
