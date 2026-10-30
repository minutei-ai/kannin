import { Effect, Exit } from "effect";
import { decodePublicCell, encodePublicCell } from "../src/public-cell";
import { decodePublicJson, encodePublicJson } from "../src/public-json";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const options = { nullable: url.searchParams.get("nullable") === "true" };
    const program = decodePublicJson(await request.text()).pipe(
      Effect.flatMap((wire) => decodePublicCell(url.searchParams.get("type"), wire, options)),
      Effect.flatMap((cell) =>
        encodePublicCell(url.searchParams.get("type"), cell, options).pipe(
          Effect.map((wire) => ({ cell, wire })),
        ),
      ),
      Effect.flatMap(({ cell, wire }) =>
        encodePublicJson(wire).pipe(Effect.map((text) => JSON.stringify({ cell, wire: text }))),
      ),
    );
    const exit = await Effect.runPromiseExit(program);
    if (Exit.isSuccess(exit))
      return new Response(exit.value, { headers: { "content-type": "application/json" } });
    return new Response("rejected", { status: 422 });
  },
};
