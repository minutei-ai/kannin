import { env, exports, waitUntil } from "cloudflare:workers";
import module from "raio:wasm";
import { createStorage } from "../core/storage";
import type { SearchRuntime } from "../platform";

export const runtime: SearchRuntime = {
  env,
  cache: caches,
  engineModule: module,
  version: env.CF_VERSION_METADATA.id,
  freshRoots: false,
  immutableIdentity: (digest) => digest,
  engineName: "rust-wasm-r2",
  vectorName: "cloudflare-vectorize",
  equalBytes: (left, right) => crypto.subtle.timingSafeEqual(left, right),
  waitUntil,
  namespace: (name) => env.NAMESPACES.get(env.NAMESPACES.idFromName(name)),
  segments: (options) => exports.Segments(options),
  terms: (options) => exports.Terms(options),
};
export const storage = createStorage(runtime);
