import { Effect, Schema } from "effect";
import module from "raio:wasm";
import {
  initSync,
  segment_build_text_fields,
  segment_local_field_statistics,
  segment_rank_fields,
} from "../dist/wasm/raio_engine";
import { CorpusStatistics, FieldBuild, FieldRankHit, FieldStatisticsQuery } from "../src/protocol";

initSync({ module });

export default {
  fetch() {
    return Effect.runPromise(
      Effect.gen(function* () {
        const documents = [
          {
            id: "one",
            revision: 0,
            roles: { title: "red fox", text: "quiet" },
            attributes: { tags: "blue fox" },
          },
          {
            id: "two",
            revision: 0,
            roles: { title: "quiet", text: "red fox" },
            attributes: { tags: "red fox" },
          },
        ];
        const fields = [{ source: "attribute", name: "tags" }] as const;
        const build = yield* Schema.encodeEffect(Schema.fromJsonString(FieldBuild))({
          documents,
          text_fields: [{ name: "tags" }],
        });
        const bytes = yield* Effect.try(() => segment_build_text_fields(build));
        const query = yield* Schema.encodeEffect(Schema.fromJsonString(FieldStatisticsQuery))({
          fields,
          text: "red fox",
          mode: "all",
        });
        const statsJson = yield* Effect.try(() => segment_local_field_statistics(bytes, query));
        const stats = yield* Schema.decodeEffect(Schema.fromJsonString(CorpusStatistics), {
          onExcessProperty: "error",
        })(statsJson);
        const rankJson = yield* Effect.try(() =>
          segment_rank_fields(
            bytes,
            JSON.stringify({ fields, text: "red fox", mode: "all", statistics: stats }),
          ),
        );
        const hits = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(FieldRankHit)), {
          onExcessProperty: "error",
        })(rankJson);
        const unsafeRejected = yield* Effect.try(() =>
          segment_rank_fields(
            bytes,
            JSON.stringify({
              fields,
              text: "red fox",
              mode: "all",
              statistics: { documents: Number.MAX_SAFE_INTEGER + 1, fields: [] },
            }),
          ),
        ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
        return Response.json({
          documents: stats.documents,
          hitRows: hits.map(({ row }) => row),
          unsafeRejected,
        });
      }),
    );
  },
};
