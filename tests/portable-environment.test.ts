import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import type { Config } from "effect";
import { portableEnvironment, portableServiceEnvironment } from "../infra/portable-environment";

function configuration<A>(config: Config.Config<A>, values: Record<string, string>) {
  return Effect.runPromise(
    config.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(values)),
    ),
  );
}

test("managed service configuration needs no external object-store credentials", async () => {
  const values = { RAIO_API_TOKEN: "fixture-api-token" };
  const service = await configuration(portableServiceEnvironment, values);
  expect(Object.keys(service)).toEqual(["RAIO_API_TOKEN"]);
  expect(Redacted.isRedacted(service.RAIO_API_TOKEN)).toBe(true);
  await expect(configuration(portableEnvironment, values)).rejects.toThrow();
  await expect(
    configuration(portableServiceEnvironment, {
      ...values,
      KANNIN_CACHE_ENDPOINT: "http://cache.internal:3000",
    }),
  ).rejects.toThrow();
  const cached = await configuration(portableServiceEnvironment, {
    ...values,
    KANNIN_CACHE_ENDPOINT: "http://cache.internal:3000",
    KANNIN_CACHE_TOKEN: "fixture-cache-token",
  });
  expect(cached.KANNIN_CACHE_ENDPOINT).toBe("http://cache.internal:3000");
  expect(Redacted.isRedacted(cached.KANNIN_CACHE_TOKEN)).toBe(true);
});

test("external backend configuration preserves credentials and explicit S3 addressing", async () => {
  const values = {
    RAIO_API_TOKEN: "fixture-api-token",
    KANNIN_STORAGE_BUCKET: "fixture-bucket",
    KANNIN_STORAGE_ENDPOINT: "https://storage.example.test",
    KANNIN_STORAGE_ACCESS_KEY_ID: "fixture-access-key",
    KANNIN_STORAGE_SECRET_ACCESS_KEY: "fixture-secret-key",
  };
  const legacy = await configuration(portableEnvironment, values);
  expect(legacy.KANNIN_STORAGE_URL_STYLE).toBe("path");
  expect(legacy.KANNIN_STORAGE_REGION).toBe("us-east-1");
  const virtual = await configuration(portableEnvironment, {
    ...values,
    KANNIN_STORAGE_URL_STYLE: "virtual",
    KANNIN_STORAGE_REGION: "auto",
  });
  expect(virtual.KANNIN_STORAGE_URL_STYLE).toBe("virtual");
  expect(virtual.KANNIN_STORAGE_REGION).toBe("auto");
  expect(Redacted.isRedacted(virtual.KANNIN_STORAGE_ACCESS_KEY_ID)).toBe(true);
  expect(Redacted.isRedacted(virtual.KANNIN_STORAGE_SECRET_ACCESS_KEY)).toBe(true);
  await expect(
    configuration(portableEnvironment, { ...values, KANNIN_STORAGE_URL_STYLE: "unknown" }),
  ).rejects.toThrow();
});
