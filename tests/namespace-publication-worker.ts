import type { Env } from "../alchemy.run";
import worker, { SearchNamespace as BaseNamespace } from "../src/worker";
import { namespaceCatalogPrefix } from "../src/namespaces";
export { Segments, Terms, KanninRpc } from "../src/worker";

export class SearchNamespace extends BaseNamespace {
  constructor(ctx: DurableObjectState, env: Env) {
    const storage = new Proxy(env.STORAGE, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (
              args[0].startsWith(namespaceCatalogPrefix) &&
              (await target.head("fixtures/fail-catalog")) !== null
            )
              return Promise.reject(new Error("private catalog publication failure"));
            return target.put(...args);
          };
        const value: unknown = Reflect.get(target, property);
        if (typeof value === "function") {
          const bound: unknown = value.bind(target);
          return bound;
        }
        return value;
      },
    });
    super(ctx, { ...env, STORAGE: storage });
  }
}

export default worker;
