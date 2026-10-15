import { Effect, Schema } from "effect";
import Worker, { Segments as CachedSegments } from "../src/worker";
export { Terms, SearchNamespace } from "../src/worker";

const starts: Array<number> = [];
const pressure = { active: 0, peak: 0, completed: 0 };
const integers = Schema.fromJsonString(Schema.Array(Schema.Int));

export class Segments extends CachedSegments {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname !== "/range") return super.fetch(request);
    starts.push(pressure.completed);
    pressure.active += 1;
    pressure.peak = Math.max(pressure.peak, pressure.active);
    const response = await super.fetch(request);
    await Effect.runPromise(Effect.sleep("100 millis"));
    pressure.active -= 1;
    pressure.completed += 1;
    return response;
  }
}

export default {
  async fetch(...args: Parameters<typeof Worker.fetch>) {
    starts.length = 0;
    pressure.peak = 0;
    pressure.completed = 0;
    const response = await Worker.fetch(...args);
    const headers = new Headers(response.headers);
    headers.set("x-fixture-starts", Schema.encodeSync(integers)(starts));
    headers.set("x-fixture-peak", String(pressure.peak));
    return new Response(response.body, { status: response.status, headers });
  },
};
