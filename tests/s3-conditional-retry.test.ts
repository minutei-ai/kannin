import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { s3ObjectStore } from "../runtime/s3-object-store";
import { ObjectStore } from "../src/object-store";
import { ObjectStoreFailure } from "../src/protocol";
import type { ObjectWriteCondition } from "../src/protocol";

type Reply = { status: 200; etag: string } | { status: 409 | 412 | 500; code: string };

const scenario = Effect.fn("kannin.test.conditionalRetry")(function* (
  replies: readonly Reply[],
  condition: typeof ObjectWriteCondition.Type,
) {
  const requests: Array<{ body: string; match: string | null; create: string | null }> = [];
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const reply = replies[requests.length];
          requests.push({
            body: await request.text(),
            match: request.headers.get("if-match"),
            create: request.headers.get("if-none-match"),
          });
          if (reply === undefined) return new Response("Unexpected request", { status: 500 });
          if (reply.status === 200) return new Response(null, { headers: { etag: reply.etag } });
          return new Response(
            `<Error><Code>${reply.code}</Code><Message>conditional fixture</Message></Error>`,
            {
              status: reply.status,
              headers: { "content-type": "application/xml" },
            },
          );
        },
      }),
    ),
    (owned) => Effect.promise(() => owned.stop(true)),
  );
  const context = yield* Layer.build(
    s3ObjectStore({
      bucket: "conditional-contract",
      endpoint: `http://127.0.0.1:${server.port}`,
      region: "us-east-1",
      urlStyle: "path",
      accessKeyId: Redacted.make("conditional-fixture-access"),
      secretAccessKey: Redacted.make("conditional-fixture-secret"),
    }),
  );
  const store = yield* ObjectStore.pipe(Effect.provideContext(context));
  const result = yield* store
    .write("conditions/root.json", new TextEncoder().encode("stable"), condition)
    .pipe(Effect.exit);
  return { result, requests };
});

const conflict = { status: 409, code: "ConditionalRequestConflict" } as const;

function nativeFailure(exit: Exit.Exit<unknown, ObjectStoreFailure>) {
  if (Exit.isSuccess(exit)) throw new Error("Expected native conditional write failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("Native write failure was lost");
  return Schema.decodeUnknownSync(ObjectStoreFailure)(failure.value.cause).cause;
}

test("conditional S3 retries retain the exact original precondition and bytes", async () => {
  const conditions: ReadonlyArray<typeof ObjectWriteCondition.Type> = [
    { ifMatch: '"captured"' },
    { ifNoneMatch: "*" },
  ];
  for (const condition of conditions) {
    const { result, requests } = await Effect.runPromise(
      Effect.scoped(scenario([conflict, { status: 200, etag: '"committed"' }], condition)),
    );
    if (Exit.isFailure(result))
      throw new Error("Transient conditional conflict did not recover", { cause: result.cause });
    expect(Option.getOrUndefined(result.value)).toEqual({ etag: '"committed"' });
    expect(requests).toEqual(
      Array.from({ length: 2 }, () => ({
        body: "stable",
        match: condition.ifMatch ?? null,
        create: condition.ifNoneMatch ?? null,
      })),
    );
  }
});

test("a winner changing the ETag leaves a retried conditional writer uncommitted", async () => {
  const { result, requests } = await Effect.runPromise(
    Effect.scoped(
      scenario([conflict, { status: 412, code: "PreconditionFailed" }], { ifMatch: '"captured"' }),
    ),
  );
  if (Exit.isFailure(result))
    throw new Error("Precondition rejection became a backend failure", { cause: result.cause });
  expect(Option.isNone(result.value)).toBe(true);
  expect(requests.map((request) => request.match)).toEqual(['"captured"', '"captured"']);
});

test("conditional retries are bounded and preserve the native S3 failure", async () => {
  const { result, requests } = await Effect.runPromise(
    Effect.scoped(scenario([conflict, conflict, conflict], { ifMatch: '"captured"' })),
  );
  expect(requests).toHaveLength(3);
  expect(nativeFailure(result)).toMatchObject({
    name: "ConditionalRequestConflict",
    $metadata: { httpStatusCode: 409 },
  });
});

test("unconditional writes and unrelated failures are not retried", async () => {
  const inputs: ReadonlyArray<{
    reply: Exclude<Reply, { status: 200 }>;
    condition: typeof ObjectWriteCondition.Type;
  }> = [
    { reply: conflict, condition: {} },
    {
      reply: { status: 409, code: "BucketAlreadyExists" } as const,
      condition: { ifMatch: '"captured"' },
    },
    { reply: { status: 500, code: "InternalError" } as const, condition: { ifNoneMatch: "*" } },
  ];
  for (const input of inputs) {
    const { result, requests } = await Effect.runPromise(
      Effect.scoped(scenario([input.reply], input.condition)),
    );
    expect(requests).toHaveLength(1);
    expect(nativeFailure(result)).toMatchObject({ name: input.reply.code });
  }
});
