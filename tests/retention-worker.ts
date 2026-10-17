import { Schema } from "effect";
import worker, { SearchNamespace as Namespace } from "../src/worker";
import { NamespaceName } from "../src/protocol";
import type { Env } from "../alchemy.run";
export { Segments, Terms } from "../src/worker";

const aged = new Map<string, string>();
const wrapped = new WeakSet<R2Bucket>();

function wrap(bucket: R2Bucket) {
  if (wrapped.has(bucket)) return;
  wrapped.add(bucket);
  const list = bucket.list.bind(bucket);
  Object.defineProperty(bucket, "list", {
    value: async (...args: Parameters<R2Bucket["list"]>) => {
      const page = await list(...args);
      return {
        ...page,
        objects: page.objects.map(
          (object) =>
            new Proxy(object, {
              get(target, property) {
                if (property === "uploaded" && aged.get(target.key) === target.version)
                  return new Date(0);
                const value: unknown = Reflect.get(target, property, target);
                return value;
              },
            }),
        ),
      };
    },
  });
}

export class SearchNamespace extends Namespace {
  override fetch(request: Request) {
    wrap(this.env.STORAGE);
    return super.fetch(request);
  }
}

export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__retention_age") {
      if (request.headers.get("authorization") !== "Bearer local-test-token")
        return new Response("Unauthorized", { status: 401 });
      const namespace = Schema.decodeSync(Schema.fromJsonString(NamespaceName))(
        await request.text(),
      );
      const page = await env.STORAGE.list({
        prefix: `namespaces/${namespace}/segments/`,
        limit: 1000,
      });
      if (page.truncated) return new Response("Aging exceeds fixture budget", { status: 503 });
      for (const object of page.objects) aged.set(object.key, object.version);
      return new Response(null, { status: 204 });
    }
    wrap(env.STORAGE);
    return worker.fetch(request, env, ctx);
  },
};
