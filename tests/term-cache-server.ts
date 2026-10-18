import { Schema } from "effect";
import Worker, { Terms as NativeTerms } from "../src/worker";
import { TermProjectionProps, TermCatalogBatch } from "../src/protocol";
import type { Env } from "../alchemy.run";

export { KanninRpc, Segments, SearchNamespace } from "../src/worker";

export class Terms extends NativeTerms {
  override async fetch(request: Request) {
    const response = await super.fetch(request);
    if (!this.ctx.props.ranges.some((range) => range.key.includes("/catalog-poison/")))
      return response;
    const batch = Schema.decodeSync(Schema.fromJsonString(TermCatalogBatch))(await response.text());
    return Response.json(
      Schema.encodeSync(TermCatalogBatch)({ ...batch, filterDigest: "0".repeat(64) }),
      {
        headers: response.headers,
      },
    );
  }
}

export default {
  ...Worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname !== "/__catalog") return Worker.fetch(request, env, ctx);
    const props = Schema.decodeUnknownSync(TermProjectionProps)(await request.json());
    return ctx.exports
      .Terms({ props: Schema.encodeSync(TermProjectionProps)(props) })
      .fetch("https://terms.internal/catalog-v9", { headers: request.headers });
  },
};
