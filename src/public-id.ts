import { Effect, Schema } from "effect";
import { CanonicalId, IdType, NativeJsonNumeric, PublicStringId } from "./protocol";

export const decodePublicId = Effect.fn("kannin.public.decodeId")(function* (
  policy: unknown,
  input: unknown,
) {
  const idType = yield* Schema.decodeUnknownEffect(IdType)(policy);
  if (idType === "string") return yield* Schema.decodeUnknownEffect(PublicStringId)(input);
  if (idType === "uuid")
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
