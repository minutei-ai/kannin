# Deployment

Alchemy declares the Worker, R2 bucket, coordinator namespace, 768-dimensional cosine Vectorize index, vector and compaction job queues with dedicated dead-letter queues. Alchemy owns deployment; there is no Wrangler infrastructure configuration. Local `dev` stages use local infrastructure state. Other stages use Alchemy's Cloudflare state store.

The public project is Kannin. The existing `Raio` Alchemy stack, `RAIO_*` configuration keys, Rust artifact names and internal cache identifiers retain their deployment identity so renaming the repository does not recreate infrastructure or abandon data.

Commands default to the native Alchemy `minutei` profile. Configure Cloudflare credentials through Alchemy and supply `RAIO_API_TOKEN` privately:

```sh
bun run plan --stage prod
bun run deploy --stage prod
```

The API token becomes the Worker's secret binding. Do not publish it or put it in the repository. Alchemy development still needs native provider authentication for capabilities that Cloudflare does not emulate, including Vectorize. `bun run test` runs offline after dependency installation.
