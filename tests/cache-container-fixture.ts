import { Cause, Effect, Exit, Redacted, Schedule, Schema } from "effect";
import { containerCommand } from "./container-command";

export const portableCacheToken = "container-cache-secret";
const cacheImageTag = `localhost/kannin-cache-contract:${crypto.randomUUID()}`;
const cacheImageName = Schema.String.check(
  Schema.isPattern(
    /^localhost\/kannin-cache-contract:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  ),
);
const containerId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const loopbackAddress = Schema.String.check(Schema.isPattern(/^127\.0\.0\.1:\d+$/));
const tcpPort = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const containerLogs = Schema.String.check(Schema.isMaxLength(8192));

const explainReadiness = Effect.fn("kannin.portableCache.logs")(function* (
  id: string,
  cause: unknown,
) {
  const collected = yield* containerCommand(["podman", "logs", id], "combined").pipe(
    Effect.map((logs) => logs.slice(0, 8192)),
    Effect.flatMap((logs) => Schema.decodeEffect(containerLogs)(logs)),
    Effect.exit,
  );
  if (Exit.isFailure(collected))
    return yield* new Cause.UnknownError(cause, "CDN log collection failed");
  return yield* new Cause.UnknownError(cause, collected.value);
});

const waitUntilReady = Effect.fn("kannin.portableCache.ready")(function* (
  endpoint: string,
  id: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${endpoint}/health`);
      await response.arrayBuffer();
      if (!response.ok) throw new Error("CDN is not ready");
    },
    catch: (cause) => new Cause.UnknownError(cause),
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
    Effect.tapError((error) => explainReadiness(id, error.cause)),
  );
});

export const portableCacheImage = Effect.acquireRelease(
  containerCommand([
    "podman",
    "build",
    "--memory=512m",
    "--memory-swap=512m",
    "--cpu-period=100000",
    "--cpu-quota=50000",
    "--file",
    "Dockerfile.cache",
    "--tag",
    cacheImageTag,
    ".",
  ]).pipe(Effect.as(cacheImageTag)),
  (image) => containerCommand(["podman", "image", "rm", image]).pipe(Effect.orDie),
);

export const startPortableCacheContainer = Effect.fn("kannin.portableCache.container")(function* (
  image: string,
) {
  const checkedImage = yield* Schema.decodeEffect(cacheImageName)(image);
  const owned = yield* Effect.acquireRelease(
    containerCommand([
      "podman",
      "run",
      "--timeout=180",
      "--detach",
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=0.5",
      "--pids-limit=128",
      "--tmpfs=/var/lib/varnish/varnishd:rw,exec,size=64m,mode=1777",
      "--publish=127.0.0.1::3000",
      `--env=KANNIN_CACHE_TOKEN=${portableCacheToken}`,
      checkedImage,
    ]),
    (id) => containerCommand(["podman", "rm", "--force", "--time", "10", id]).pipe(Effect.orDie),
  );
  const id = yield* Schema.decodeEffect(containerId)(owned);
  const address = yield* containerCommand(["podman", "port", id, "3000/tcp"]).pipe(
    Effect.flatMap(Schema.decodeEffect(loopbackAddress)),
  );
  const port = yield* Schema.decodeEffect(tcpPort)(address.slice("127.0.0.1:".length));
  const endpoint = `http://127.0.0.1:${port}`;
  yield* waitUntilReady(endpoint, id);
  const restart = containerCommand(["podman", "restart", "--time", "10", id]).pipe(
    Effect.andThen(waitUntilReady(endpoint, id)),
  );
  return { endpoint, token: Redacted.make(portableCacheToken), restart };
});
