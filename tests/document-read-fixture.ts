import { Effect, Schema } from "effect";
import Worker, { Segments as CachedSegments } from "../src/worker";
import { SegmentRange } from "../src/protocol";
export { Terms, SearchNamespace } from "../src/worker";

const selected = new Set<string>();
const starts: Array<number> = [];
const pressure = { active: 0, peak: 0, completed: 0 };
const integers = Schema.fromJsonString(Schema.Array(Schema.Int));

export class Segments extends CachedSegments {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const identity = `${url.searchParams.get("key")}/${url.searchParams.get("offset")}/${url.searchParams.get("length")}`;
    if (url.pathname !== "/range" || !selected.has(identity)) return super.fetch(request);
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
    const [request] = args;
    if (new URL(request.url).pathname === "/fixture/documents") {
      const ranges = Schema.decodeUnknownSync(Schema.Array(SegmentRange))(await request.json());
      selected.clear();
      for (const range of ranges) selected.add(`${range.key}/${range.offset}/${range.length}`);
      starts.length = 0;
      pressure.peak = 0;
      pressure.completed = 0;
      return new Response(null, { status: 204 });
    }
    const response = await Worker.fetch(...args);
    const headers = new Headers(response.headers);
    headers.set("x-fixture-starts", Schema.encodeSync(integers)(starts));
    headers.set("x-fixture-peak", String(pressure.peak));
    return new Response(response.body, { status: response.status, headers });
  },
};
