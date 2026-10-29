import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, Schema } from "effect";
import { serverConfig } from "../runtime/server";
import { S3StoreConfig } from "../src/protocol";

const environment = {
  RAIO_API_TOKEN: "configuration-contract-token",
  KANNIN_STORAGE_BUCKET: "configuration-contract",
  KANNIN_STORAGE_ENDPOINT: "https://storage.example.test",
  KANNIN_STORAGE_ACCESS_KEY_ID: "fixture-access-key",
  KANNIN_STORAGE_SECRET_ACCESS_KEY: "fixture-secret-key",
};
function configuration(values: Record<string, string> = {}) {
  return serverConfig.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(Object.assign({}, environment, values)),
    ),
  );
}

test("S3 configuration preserves legacy addressing and accepts virtual-hosted buckets", async () => {
  const legacy = await Effect.runPromise(configuration());
  expect(legacy.objectStore.urlStyle).toBe("path");
  expect(legacy.objectStore.region).toBe("us-east-1");
  const virtual = await Effect.runPromise(
    configuration({ KANNIN_STORAGE_URL_STYLE: "virtual", KANNIN_STORAGE_REGION: "auto" }),
  );
  const decoded = Schema.decodeSync(S3StoreConfig, { onExcessProperty: "error" })(
    virtual.objectStore,
  );
  expect(decoded.urlStyle).toBe("virtual");
  expect(decoded.region).toBe("auto");
  expect(decoded.endpoint).toBe(environment.KANNIN_STORAGE_ENDPOINT);
  expect(decoded.bucket).toBe(environment.KANNIN_STORAGE_BUCKET);
});

test("unsupported S3 URL styles fail at configuration and adapter boundaries", async () => {
  const base = (await Effect.runPromise(configuration())).objectStore;
  for (const urlStyle of ["auto", "PATH", "virtual-hosted"]) {
    const invalid = await Effect.runPromiseExit(
      configuration({ KANNIN_STORAGE_URL_STYLE: urlStyle }),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
    expect(Schema.is(S3StoreConfig)({ ...base, urlStyle })).toBe(false);
  }
  expect(Schema.is(S3StoreConfig)({ ...base, urlStyle: "" })).toBe(false);
});
