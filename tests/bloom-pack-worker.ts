import { Schema } from "effect";
import worker, {
  Segments as CachedSegments,
  SearchNamespace as Namespace,
  Terms,
} from "../src/worker";
import { NamespaceName } from "../src/protocol";
import type { Env } from "../alchemy.run";

const BloomPackRead = Schema.Struct({
  key: Schema.String,
  offset: Schema.NullOr(Schema.Int),
  length: Schema.NullOr(Schema.Int),
});
const FixtureStats = Schema.Struct({
  segmentGets: Schema.Int,
  bloomPackGets: Schema.Int,
  bloomPackReads: Schema.Array(BloomPackRead),
});
const states = new Map<string, { value: typeof FixtureStats.Type }>();
const wrapped = new WeakSet<R2Bucket>();

function emptyStats(): typeof FixtureStats.Type {
  return { segmentGets: 0, bloomPackGets: 0, bloomPackReads: [] };
}

function stateFor(key: string) {
  const match = key.match(/^namespaces\/([^/]+)\//);
  if (match === null) return undefined;
  const namespace = Schema.decodeUnknownSync(NamespaceName)(match[1]);
  const state = states.get(namespace) ?? { value: emptyStats() };
  states.set(namespace, state);
  return state;
}

function wrap(bucket: R2Bucket) {
  if (wrapped.has(bucket)) return;
  wrapped.add(bucket);
  const get = bucket.get.bind(bucket);
  Object.defineProperty(bucket, "get", {
    value: async (...args: Parameters<R2Bucket["get"]>) => {
      const key = args[0];
      const state = stateFor(key);
      if (state !== undefined && key.includes("/segments/"))
        state.value = { ...state.value, segmentGets: state.value.segmentGets + 1 };
      if (state !== undefined && key.includes("/bloom-packs/")) {
        const range = args[1]?.range;
        const normalizedRange = (() => {
          if (range === undefined || !("offset" in range)) return null;
          return { offset: range.offset, length: range.length ?? null };
        })();
        state.value = {
          ...state.value,
          bloomPackGets: state.value.bloomPackGets + 1,
          bloomPackReads: [
            ...state.value.bloomPackReads,
            {
              key,
              offset: normalizedRange?.offset ?? null,
              length: normalizedRange?.length ?? null,
            },
          ],
        };
      }
      return get(...args);
    },
  });
}

export class SearchNamespace extends Namespace {
  override async fetch(request: Request) {
    wrap(this.env.STORAGE);
    const url = new URL(request.url);
    if (url.pathname !== "/fixture/reset" && url.pathname !== "/fixture/stats")
      return super.fetch(request);
    const namespace = Schema.decodeUnknownSync(NamespaceName)(url.searchParams.get("namespace"));
    if (url.pathname === "/fixture/reset") {
      states.set(namespace, { value: emptyStats() });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/stats") {
      const state = states.get(namespace)?.value ?? emptyStats();
      return Response.json(Schema.encodeSync(FixtureStats)(state));
    }
    return new Response(null, { status: 404 });
  }
}

export class Segments extends CachedSegments {
  override async fetch(request: Request) {
    wrap(this.env.STORAGE);
    return super.fetch(request);
  }
}

export { Terms };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/reset" || url.pathname === "/fixture/stats") {
      const namespace = Schema.decodeUnknownSync(NamespaceName)(url.searchParams.get("namespace"));
      return env.NAMESPACES.get(env.NAMESPACES.idFromName(namespace)).fetch(request);
    }
    return worker.fetch(request, env, ctx);
  },
};
