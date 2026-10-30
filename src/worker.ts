import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../alchemy.run";
import { createApplication } from "./core/application";
import { runtime, storage } from "./providers/cloudflare";
import type { RpcCommand, RpcReply, SegmentCacheProps, TermProjectionProps } from "./protocol";

const application = createApplication(runtime, storage);

export class Segments extends WorkerEntrypoint<Env, typeof SegmentCacheProps.Type> {
  override fetch(request: Request) {
    return new application.Segments(this.ctx, this.env).fetch(request);
  }
}
export class Terms extends WorkerEntrypoint<Env, typeof TermProjectionProps.Encoded> {
  override fetch(request: Request) {
    return new application.Terms(this.ctx, this.env).fetch(request);
  }
}
export class SearchNamespace extends DurableObject<Env> {
  private readonly core = new application.SearchNamespace(this.ctx, this.env);
  override fetch(request: Request) {
    return this.core.fetch(request);
  }
  execute(command: typeof RpcCommand.Encoded): Promise<typeof RpcReply.Encoded> {
    return this.core.execute(command);
  }
}
export class KanninRpc extends WorkerEntrypoint<Env> {
  private readonly core = new application.KanninRpc(this.ctx, this.env);
  execute(command: typeof RpcCommand.Encoded): Promise<typeof RpcReply.Encoded> {
    return this.core.execute(command);
  }
}
export default application.handler;
