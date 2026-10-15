import { Effect } from "effect";
import worker, { Terms as CachedTerms } from "../src/worker";
export { SearchNamespace, Segments } from "../src/worker";
export class Terms extends CachedTerms {
  override async fetch(request: Request) {
    await Effect.runPromise(Effect.sleep("31000 millis"));
    return super.fetch(request);
  }
}
export default worker;
