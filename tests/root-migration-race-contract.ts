import { Schema } from "effect";

export const MigrationRaceArm = Schema.Struct({
  key: Schema.String,
  replacement: Schema.String,
  phase: Schema.Literals(["cas-put", "capture-after-list"]),
});
export const MigrationRaceStats = Schema.Struct({
  fired: Schema.Boolean,
  listed: Schema.Boolean,
  bodyReads: Schema.Int,
});
