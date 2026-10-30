import { Schema } from "effect";
import { DurableObject } from "cloudflare:workers";
import { createApplication } from "../src/core/application";
import { runtime, storage } from "../src/providers/cloudflare";
import { decodeRoot } from "../src/manifest";
import { NamespaceName } from "../src/protocol";
import type { Env } from "../alchemy.run";
export { Segments, Terms } from "../src/worker";

const aged = new Map<string, string>();
const wrapped = new WeakSet<R2Bucket>();
const segmentGate = { url: "", starts: new Map<string, number>() };
const Gate = Schema.Struct({ url: Schema.String, namespace: NamespaceName });

const application = createApplication(runtime, {
  ...storage,
  async range(...args: Parameters<typeof storage.range>) {
    const start = segmentGate.starts.get(args[0]);
    if (segmentGate.url !== "" && start !== undefined && args[1] >= start) {
      const response = await fetch(segmentGate.url);
      if (!response.ok) throw new Error("Injected canonical frame failure");
    }
    return storage.range(...args);
  },
});
const worker = application.handler;

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

export class SearchNamespace extends DurableObject<Env> {
  private readonly core = new application.SearchNamespace(this.ctx, this.env);
  override fetch(request: Request) {
    wrap(this.env.STORAGE);
    return this.core.fetch(request);
  }
}

export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__segment_gate") {
      if (request.headers.get("authorization") !== "Bearer local-test-token")
        return new Response("Unauthorized", { status: 401 });
      const gate = Schema.decodeSync(Schema.fromJsonString(Gate))(await request.text());
      segmentGate.url = gate.url;
      segmentGate.starts.clear();
      if (gate.url !== "") {
        const object = await env.STORAGE.get(`namespaces/${gate.namespace}/root.json`);
        if (object === null) return new Response("Missing gate root", { status: 404 });
        for (const segment of decodeRoot(await object.text()).segments)
          segmentGate.starts.set(segment.key, segment.metadataEnd);
      }
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__retention_age") {
      if (request.headers.get("authorization") !== "Bearer local-test-token")
        return new Response("Unauthorized", { status: 401 });
      const namespace = Schema.decodeSync(Schema.fromJsonString(NamespaceName))(
        await request.text(),
      );
      for (const phase of ["bloom-packs", "segments", "vector-rebuild"]) {
        const page = await env.STORAGE.list({
          prefix: `namespaces/${namespace}/${phase}/`,
          limit: 1000,
        });
        if (page.truncated) return new Response("Aging exceeds fixture budget", { status: 503 });
        for (const object of page.objects) aged.set(object.key, object.version);
      }
      return new Response(null, { status: 204 });
    }
    wrap(env.STORAGE);
    return worker.fetch(request, env, ctx);
  },
};
