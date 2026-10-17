import type { RpcCommand, RpcReply } from "./protocol";

export interface Binding {
  execute(command: typeof RpcCommand.Encoded): Promise<typeof RpcReply.Encoded>;
}

export type Entrypoint = Binding & Rpc.WorkerEntrypointBranded;
