import { Effect, Exit } from "effect";
import {
  decodePublicAttributes,
  decodePublicCell,
  encodePublicAttributes,
  encodePublicCell,
} from "../src/public-cell";
import { decodePublicJson, encodePublicJson } from "../src/public-json";
import { decodePublicSchema, encodePublicSchema } from "../src/public-schema";
import { decodePublicColumns, decodePublicRows } from "../src/public-rows";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const options = { nullable: url.searchParams.get("nullable") === "true" };
    const text = await request.text();
    const program = Effect.gen(function* () {
      const input = yield* decodePublicJson(text);
      const rows = url.searchParams.get("rows") === "true";
      const columns = url.searchParams.get("columns") === "true";
      if (rows || columns) {
        const declaration = yield* decodePublicSchema({
          title: { type: "string" },
          text: { type: "string" },
          count: { type: "int" },
          note: { type: "string" },
        });
        if (columns) return JSON.stringify(yield* decodePublicColumns("uint", declaration, input));
        return JSON.stringify(yield* decodePublicRows("uint", declaration, input));
      }
      if (url.searchParams.get("schema") === "true") {
        const declaration = yield* decodePublicSchema(input);
        const schema = yield* encodePublicSchema(declaration);
        return JSON.stringify({ declaration, schema });
      }
      if (url.searchParams.get("attributes") === "true") {
        const declaration = {
          columns: [
            { name: "count", type: "u64" },
            { name: "note", type: "string", nullable: true },
            { name: "missing", type: "bool", nullable: true },
          ],
        };
        const cell = yield* decodePublicAttributes(declaration, input);
        const wire = yield* encodePublicAttributes(declaration, cell);
        return JSON.stringify({ cell, wire: yield* encodePublicJson(wire) });
      }
      const cell = yield* decodePublicCell(url.searchParams.get("type"), input, options);
      const wire = yield* encodePublicCell(url.searchParams.get("type"), cell, options);
      return JSON.stringify({ cell, wire: yield* encodePublicJson(wire) });
    });
    const exit = await Effect.runPromiseExit(program);
    if (Exit.isSuccess(exit))
      return new Response(exit.value, { headers: { "content-type": "application/json" } });
    return new Response("rejected", { status: 422 });
  },
};
