import { Effect, Schema } from "effect";
import { CanonicalId, NativeJsonNumeric, PublicStringId } from "./protocol";
import type { IdType } from "./protocol";

export const decodePublicId = Effect.fn("kannin.public.decodeId")(function* (
  policy: typeof IdType.Type,
  input: unknown,
) {
  if (policy === "string") return yield* Schema.decodeUnknownEffect(PublicStringId)(input);
  if (policy === "uuid")
    return yield* Schema.decodeUnknownEffect(CanonicalId)({ kind: "uuid", value: input });
  const numeric = yield* Schema.decodeUnknownEffect(NativeJsonNumeric)(input);
  return yield* Schema.decodeUnknownEffect(CanonicalId)({ kind: "uint", value: numeric.rawJSON });
});

export const encodePublicId = Effect.fn("kannin.public.encodeId")(function* (
  input: typeof CanonicalId.Type,
) {
  const id = yield* Schema.decodeEffect(CanonicalId)(input);
  if (typeof id === "string") return yield* Schema.decodeEffect(PublicStringId)(id);
  if (id.kind === "uuid") return id.value;
  return yield* Effect.try(() => JSON.rawJSON(id.value));
});
