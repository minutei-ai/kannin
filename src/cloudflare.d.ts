import type * as Worker from "./worker";
import type { Env as WorkerEnv } from "../alchemy.run";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof Worker;
      durableNamespaces: "SearchNamespace";
    }
  }
}
