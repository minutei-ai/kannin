import { Effect, Schema } from "effect";
import type { Cause } from "effect";
import { NativeJsonNumeric } from "./protocol";

const isNativeJsonNumeric = Schema.is(NativeJsonNumeric);

export function decodePublicJson(text: string): Effect.Effect<unknown, Cause.UnknownError> {
  return Effect.try(() =>
    JSON.parse(text, (_key, value: unknown, context?: { readonly source?: string }) => {
      if (typeof value !== "number") return value;
      const source = context?.source;
      if (source === undefined) throw new TypeError("Native JSON numeric source unavailable");
      return JSON.rawJSON(source);
    }),
  );
}

export function encodePublicJson(value: unknown) {
  return Effect.try(() => {
    const encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return JSON.rawJSON(item.toString());
      if (typeof item === "number" && !Number.isFinite(item))
        throw new TypeError("Non-finite JSON numbers are unsupported");
      if (JSON.isRawJSON(item) && !isNativeJsonNumeric(item))
        throw new TypeError("Only numeric native raw JSON values are supported");
      return item;
    });
    if (encoded === undefined) throw new TypeError("Value is not JSON serializable");
    return encoded;
  });
}
