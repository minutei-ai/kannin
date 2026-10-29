import { Effect, Schema } from "effect";
import module from "raio:wasm";
import { initSync, word_v4 } from "../dist/wasm/raio_engine";
import { AnalyzedTokens, WordV4Config } from "../src/protocol";

initSync({ module });

export default {
  fetch() {
    return Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* Schema.encodeEffect(Schema.fromJsonString(WordV4Config))({
          max_token_length: 39,
          case_sensitive: false,
          stopwords: "english",
          stemming: "english",
          ascii_folding: false,
        });
        const tokens = yield* Effect.try(() => word_v4(config, '["The running foxes", "CAFÉ"]'));
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(AnalyzedTokens), {
          onExcessProperty: "error",
        })(tokens);
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(AnalyzedTokens))(decoded);
        return new Response(body, { headers: { "content-type": "application/json" } });
      }),
    );
  },
};
