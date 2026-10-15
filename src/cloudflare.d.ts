import type * as Worker from "./worker";
import type { Env as WorkerEnv } from "../alchemy.run";
import type { SubtleCrypto as CloudflareSubtleCrypto } from "@cloudflare/workers-types";

declare global {
  interface SubtleCrypto extends Pick<CloudflareSubtleCrypto, "timingSafeEqual"> {}
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof Worker;
      durableNamespaces: "SearchNamespace";
    }
  }
}
