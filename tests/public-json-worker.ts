import { Effect } from "effect";
import { decodePublicJson, encodePublicJson } from "../src/public-json";

export default {
  async fetch(request: Request): Promise<Response> {
    const input = await request.text();
    const decoded = await Effect.runPromise(decodePublicJson(input));
    const output = await Effect.runPromise(encodePublicJson(decoded));
    return new Response(output, { headers: { "content-type": "application/json" } });
  },
};
