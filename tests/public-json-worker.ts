import { Effect, Schema } from "effect";
import { IdType } from "../src/protocol";
import { decodePublicId, encodePublicId } from "../src/public-id";
import { decodePublicJson, encodePublicJson } from "../src/public-json";

export default {
  async fetch(request: Request): Promise<Response> {
    const input = await request.text();
    const decoded = await Effect.runPromise(decodePublicJson(input));
    const policy = new URL(request.url).searchParams.get("id_type");
    if (policy !== null) {
      const idType = Schema.decodeUnknownSync(IdType)(policy);
      const output = await Effect.runPromise(
        decodePublicId(idType, decoded).pipe(
          Effect.flatMap(encodePublicId),
          Effect.flatMap(encodePublicJson),
        ),
      );
      return new Response(output, { headers: { "content-type": "application/json" } });
    }
    const output = await Effect.runPromise(encodePublicJson(decoded));
    return new Response(output, { headers: { "content-type": "application/json" } });
  },
};
