import { Schema } from "effect";
import { RankingInput, TermProjectionRange } from "../src/protocol";

export const QueryRankerProbe = Schema.Struct({
  source: TermProjectionRange,
  query: RankingInput,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })),
});
