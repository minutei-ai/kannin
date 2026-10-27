import { Effect } from "effect";
import { Segments as CachedSegments } from "../src/worker";
export { default, SearchNamespace } from "./range-fixture";

export class Segments extends CachedSegments {
  override async fetch(request: Request) {
    await Effect.runPromise(Effect.sleep("800 millis"));
    return super.fetch(request);
  }
}
