import type { Env } from "../alchemy.run";
import { Effect, Match, Option, Schema } from "effect";
import { type Directory, PreparedQuery } from "../dist/wasm/raio_engine";
import { LocatedDocument, SegmentDocument, RankingInput } from "../src/protocol";
import { withDirectory, clearImmutableCache } from "../src/storage";
import {
  DocumentDirectoryProbe,
  DocumentDirectoryArm,
  DocumentDirectoryResult,
  DocumentDirectoryState,
} from "./document-directory-contract";
export { Segments, Terms, SearchNamespace, KanninRpc } from "../src/worker";
const state = {
  key: "",
  segment: "",
  outcome: "present",
  holdGet: false,
  holdUse: false,
  commonStarted: 0,
  commonFinished: 0,
  fullReads: 0,
  canonicalReads: 0,
  lookupStarted: 0,
  useStarted: 0,
};
const wrapped = new WeakSet<R2Bucket>();
function instrument(bucket: R2Bucket) {
  if (wrapped.has(bucket)) return;
  wrapped.add(bucket);
  const get = bucket.get.bind(bucket);
  Object.defineProperty(bucket, "get", {
    value: async (...args: Parameters<R2Bucket["get"]>) => {
      if (args[0] === state.key) {
        state.commonStarted += 1;
        await Effect.runPromise(
          Effect.sleep("5 millis").pipe(Effect.repeat({ while: () => state.holdGet })),
        );
        state.commonFinished += 1;
        if (state.outcome === "missing") return null;
        if (state.outcome === "failure")
          return Promise.reject(new Error("Injected common R2 read failure"));
      }
      if (args[0] === state.segment) state.canonicalReads += 1;
      if (args[0].startsWith("cache/directory-v6/")) state.fullReads += 1;
      return get(...args);
    },
  });
}
const project = Effect.fn("fixture.project")(
  (directory: Directory, input: typeof DocumentDirectoryProbe.Type) =>
    Effect.gen(function* () {
      const complete = yield* Effect.try(() =>
        directory.compressed_frame(input.source.headerBytes),
      ).pipe(Effect.option);
      const ids = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
        input.ids,
      );
      const dead = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Int)))(
        input.dead,
      );
      const rows = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Int)))(
        input.rows,
      );
      return {
        partial: Option.isNone(complete),
        lookup: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
          directory.lookup(ids, dead),
        ),
        rows: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(LocatedDocument)))(
          directory.rows(rows),
        ),
        vectors: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(SegmentDocument)))(
          directory.vectors(dead),
        ),
      };
    }),
);
export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
      return new Response(null, { status: 401 });
    instrument(env.STORAGE);
    const path = new URL(request.url).pathname;
    if (path === "/state")
      return new Response(Schema.encodeSync(Schema.fromJsonString(DocumentDirectoryState))(state), {
        headers: { "content-type": "application/json" },
      });
    if (path === "/release-get") {
      state.holdGet = false;
      return new Response(null, { status: 204 });
    }
    if (path === "/release-use") {
      state.holdUse = false;
      return new Response(null, { status: 204 });
    }
    if (path === "/clear") {
      clearImmutableCache(state.segment);
      return new Response(null, { status: 204 });
    }
    if (path === "/arm") {
      const input = Schema.decodeUnknownSync(DocumentDirectoryArm)(await request.json());
      state.segment = input.source.key;
      state.key = `cache/directory-common-v4/${input.source.key}/${input.source.headerBytes}`;
      state.outcome = input.outcome;
      state.holdGet = input.holdGet;
      state.holdUse = input.holdUse;
      state.commonStarted = 0;
      state.commonFinished = 0;
      state.fullReads = 0;
      state.canonicalReads = 0;
      state.lookupStarted = 0;
      state.useStarted = 0;
      clearImmutableCache(state.segment);
      return new Response(null, { status: 204 });
    }
    if (path === "/lookup" || path === "/warm") {
      const input = Schema.decodeUnknownSync(DocumentDirectoryProbe)(await request.json());
      using query = new PreparedQuery(
        Schema.encodeSync(Schema.fromJsonString(RankingInput))(input.ranking),
      );
      if (path === "/lookup") state.lookupStarted += 1;
      const held = { count: 0 };
      const operation = withDirectory(
        input.source.key,
        input.source.headerBytes,
        (directory) =>
          Effect.gen(function* () {
            const first = yield* project(directory, input);
            if (path === "/lookup") {
              state.useStarted += 1;
              yield* Effect.sleep("5 millis").pipe(Effect.repeat({ while: () => state.holdUse }));
            }
            const second = yield* project(directory, input);
            return { first, second, held: held.count };
          }),
        undefined,
        false,
        false,
        Match.value(path).pipe(
          Match.when("/warm", () => query),
          Match.orElse(() => undefined),
        ),
        path === "/lookup",
      );
      const saturate = (index: number): typeof operation => {
        if (index === 64) return operation;
        return withDirectory(
          input.source.key.replace(/[^/]+$/, `hold-${index}.rsix`),
          input.source.headerBytes,
          () =>
            Effect.gen(function* () {
              held.count += 1;
              return yield* saturate(index + 1);
            }),
          undefined,
          true,
        );
      };
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          if (input.saturate) return yield* saturate(0);
          return yield* operation;
        }),
      );
      return new Response(
        Schema.encodeSync(Schema.fromJsonString(DocumentDirectoryResult))(result),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  },
};
