import { Clock, Config, Effect, Redacted, Schema } from "effect";
import { Metadata, NamespaceName, Query, QueryResult, Row } from "../src/protocol";

class LoadFailure extends Schema.TaggedError<LoadFailure>()("LoadFailure", {
  message: Schema.String,
  status: Schema.optional(Schema.Int),
  body: Schema.optional(Schema.String),
  query: Schema.optional(Query),
  serverTiming: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  ray: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
}) {}

const url = new URL(Effect.runSync(Config.String("RAIO_URL")));
const namespace = Effect.runSync(Config.schema(NamespaceName, "RAIO_LOAD_NAMESPACE"));
const token = Effect.runSync(Config.Redacted("RAIO_API_TOKEN"));
const samples = Effect.runSync(Config.Int("RAIO_LOAD_REQUESTS").pipe(Config.withDefault(128)));
Schema.decodeSync(Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 10000 })))(samples);
const headers = {
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
};
const metadataResponse = await fetch(new URL(`/v1/namespaces/${namespace}/metadata`, url), {
  headers,
});
if (!metadataResponse.ok) throw new Error(`Load metadata failed: ${metadataResponse.status}`);
const metadata = Schema.decodeUnknownSync(Metadata)(await metadataResponse.json());
const queries = [
  { kind: "text", text: "unique42", topK: 10, filters: [] },
  { kind: "text", text: "group42", topK: 10, filters: [] },
  { kind: "text", text: "cloudflare rust", topK: 10, filters: [] },
  {
    kind: "text",
    text: "cloudflare",
    topK: 10,
    filters: [{ field: "group", op: "eq", value: 42 }],
  },
].map((query) => Schema.decodeUnknownSync(Query)(query));
const baselines: string[] = [];
for (const query of queries) {
  const response = await fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
    method: "POST",
    headers,
    body: Schema.encodeSync(Schema.fromJsonString(Query))({
      ...query,
      minimumSequence: metadata.sequence,
    }),
  });
  if (!response.ok) throw new Error(`Load baseline failed: ${response.status}`);
  const result = Schema.decodeUnknownSync(QueryResult)(await response.json());
  if (result.rows.length === 0) throw new Error("Load requires a populated benchmark corpus");
  baselines.push(Schema.encodeSync(Schema.fromJsonString(Schema.Array(Row)))(result.rows));
}
const reports = [];
for (const concurrency of [1, 4, 16]) {
  const started = Effect.runSync(Clock.currentTimeNanos);
  const results = await Effect.runPromise(
    Effect.forEach(
      Array.from({ length: samples }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          const query = queries[index % queries.length];
          const baseline = baselines[index % queries.length];
          if (query === undefined || baseline === undefined)
            return yield* new LoadFailure({ message: "Missing load case" });
          const begin = yield* Clock.currentTimeNanos;
          const startedAt = yield* Clock.currentTimeMillis;
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Query))({
            ...query,
            consistency: "edge-eventual",
            minimumSequence: metadata.sequence,
          });
          const response = yield* Effect.tryPromise(() =>
            fetch(new URL(`/v1/namespaces/${namespace}/query`, url), {
              method: "POST",
              headers,
              body: encoded,
            }),
          );
          const body = yield* Effect.tryPromise(() => response.text());
          if (!response.ok)
            return yield* new LoadFailure({
              message: `Load query failed: ${response.status}`,
              status: response.status,
              body: body.slice(0, 1024),
              query,
              serverTiming: response.headers.get("server-timing"),
              ray: response.headers.get("cf-ray"),
            });
          const result = yield* Schema.decodeEffect(Schema.fromJsonString(QueryResult))(body);
          const rows = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Row)))(
            result.rows,
          );
          if (rows !== baseline || result.sequence !== metadata.sequence)
            return yield* new LoadFailure({
              message: "Concurrent load changed ranking or corpus sequence",
            });
          const ended = yield* Clock.currentTimeNanos;
          return {
            case: index % queries.length,
            startedAt,
            endedAt: yield* Clock.currentTimeMillis,
            ms: Number(ended - begin) / 1e6,
            serverTiming: response.headers.get("server-timing"),
            ray: response.headers.get("cf-ray"),
          };
        }),
      { concurrency },
    ),
  );
  const ended = Effect.runSync(Clock.currentTimeNanos);
  const elapsedMs = Number(ended - started) / 1e6;
  const durations = results.map((result) => result.ms);
  const ordered = durations.toSorted((a, b) => a - b);
  const report = {
    concurrency,
    requests: results.length,
    elapsedMs,
    requestsPerSecond: (results.length * 1000) / elapsedMs,
    p50: ordered[Math.floor((ordered.length - 1) * 0.5)],
    p95: ordered[Math.floor((ordered.length - 1) * 0.95)],
    p99: ordered[Math.floor((ordered.length - 1) * 0.99)],
    samples: durations,
    serverTimings: results.map((result) => result.serverTiming),
    observations: results,
  };
  reports.push(report);
  console.error(
    JSON.stringify({
      concurrency,
      requests: report.requests,
      p50: report.p50,
      p95: report.p95,
      requestsPerSecond: report.requestsPerSecond,
    }),
  );
}
console.log(
  JSON.stringify(
    {
      namespace,
      documents: metadata.documents,
      sequence: metadata.sequence,
      consistency: "edge-eventual with acknowledged sequence barrier",
      resultCheck: "every response equals the strong baseline",
      reports,
    },
    null,
    2,
  ),
);
