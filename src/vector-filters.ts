import { Effect, Schema } from "effect";
import { Scalar } from "./protocol";
import type { Attributes, Filter, VectorFilterFields } from "./protocol";
import { sha256 } from "./storage";

const scalarDigest = Effect.fn("raio.scalarDigest")(function* (value: typeof Scalar.Type) {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Scalar))(value);
  return yield* Effect.tryPromise(() => sha256(encoded));
});

export const vectorMetadata = Effect.fn("raio.vectorMetadata")(function* (
  attributes: typeof Attributes.Type,
  fields: typeof VectorFilterFields.Type,
) {
  const values = new Map(Object.entries(attributes));
  const metadata: Record<string, string | number> = {};
  for (const [index, field] of fields.entries()) {
    const value = values.get(field);
    if (value === undefined) continue;
    metadata[`e${index}`] = yield* scalarDigest(value);
    if (typeof value === "number") metadata[`n${index}`] = value;
  }
  return metadata;
});

export const vectorPrefilter = Effect.fn("raio.vectorPrefilter")(function* (
  filters: ReadonlyArray<typeof Filter.Type>,
  fields: typeof VectorFilterFields.Type,
) {
  const native: VectorizeVectorMetadataFilter = {};
  for (const [index, field] of fields.entries()) {
    const selected =
      filters.find((filter) => filter.field === field && filter.op === "eq") ??
      filters.find((filter) => filter.field === field && filter.op === "in") ??
      filters.find(
        (filter) => filter.field === field && ["gt", "gte", "lt", "lte"].includes(filter.op),
      );
    if (!selected) continue;
    const candidate: VectorizeVectorMetadataFilter = { ...native };
    if (selected.op === "eq") candidate[`e${index}`] = { $eq: yield* scalarDigest(selected.value) };
    else if (selected.op === "in")
      candidate[`e${index}`] = {
        $in: yield* Effect.forEach(selected.value, scalarDigest),
      };
    else {
      const lower = filters
        .flatMap((filter) => {
          if (filter.field !== field) return [];
          if (filter.op === "gt" || filter.op === "gte") return [filter];
          return [];
        })
        .toSorted((a, b) => {
          if (a.value !== b.value) return b.value - a.value;
          if (a.op === b.op) return 0;
          if (a.op === "gt") return -1;
          if (b.op === "gt") return 1;
          return 0;
        })[0];
      const upper = filters
        .flatMap((filter) => {
          if (filter.field !== field) return [];
          if (filter.op === "lt" || filter.op === "lte") return [filter];
          return [];
        })
        .toSorted((a, b) => {
          if (a.value !== b.value) return a.value - b.value;
          if (a.op === b.op) return 0;
          if (a.op === "lt") return -1;
          if (b.op === "lt") return 1;
          return 0;
        })[0];
      const bounds: Partial<Record<VectorizeVectorMetadataFilterOp, number>> = {};
      if (lower?.op === "gt") bounds.$gt = lower.value;
      if (lower?.op === "gte") bounds.$gte = lower.value;
      if (upper?.op === "lt") bounds.$lt = upper.value;
      if (upper?.op === "lte") bounds.$lte = upper.value;
      candidate[`n${index}`] = bounds;
    }
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength >= 2048) continue;
    Object.assign(native, candidate);
  }
  return native;
});
