import { expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { Id } from "../src/protocol";
import { decodePublicId, encodePublicId } from "../src/public-id";
import { decodePublicJson, encodePublicJson } from "../src/public-json";

const decode = (text: string) =>
  Effect.runSync(
    decodePublicJson(text).pipe(Effect.flatMap((value) => decodePublicId("uint", value))),
  );

test("public integer IDs retain exact uint64 tokens through the canonical ID owner", () => {
  for (const value of ["0", "2", "10", "9007199254740993", "18446744073709551615"]) {
    const id = decode(value);
    expect(id).toEqual({ kind: "uint", value });
    expect(Effect.runSync(encodePublicId(id).pipe(Effect.flatMap(encodePublicJson)))).toBe(value);
  }
});

test("public ID decoding never guesses a namespace policy from the value", () => {
  const uuid = "00112233-4455-6677-8899-aabbccddeeff";
  expect(Effect.runSync(decodePublicId("string", uuid))).toBe(uuid);
  expect(Effect.runSync(decodePublicId("uuid", uuid))).toEqual({ kind: "uuid", value: uuid });
  expect(Effect.runSync(decodePublicId("string", "18446744073709551615"))).toBe(
    "18446744073709551615",
  );
  for (const invalid of [
    1,
    18446744073709551615n,
    "1",
    { rawJSON: "1" },
    { kind: "uint", value: "1" },
  ])
    expect(Exit.isFailure(Effect.runSyncExit(decodePublicId("uint", invalid)))).toBe(true);
});

test("unsupported integer spellings and out-of-range public IDs fail closed", () => {
  for (const text of ["-1", "-0", "1.5", "1.0", "1e0", "18446744073709551616"])
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          decodePublicJson(text).pipe(Effect.flatMap((value) => decodePublicId("uint", value))),
        ),
      ),
    ).toBe(true);
});

test("public string IDs enforce UTF-8 bytes without narrowing the native ID contract", () => {
  for (const id of ["a".repeat(64), "é".repeat(32), "😀".repeat(16)])
    expect(Effect.runSync(decodePublicId("string", id))).toBe(id);
  for (const id of ["a".repeat(65), "é".repeat(33), "😀".repeat(17), "\ud800"])
    expect(Exit.isFailure(Effect.runSyncExit(decodePublicId("string", id)))).toBe(true);
  expect(Exit.isFailure(Effect.runSyncExit(encodePublicId("a".repeat(65))))).toBe(true);
  expect(Schema.is(Id)("a".repeat(65))).toBe(true);
});

test("public ID decoding validates the namespace policy at its boundary", () => {
  for (const policy of ["integer", "UINT", "", null, undefined, 1, { type: "uint" }])
    expect(Exit.isFailure(Effect.runSyncExit(decodePublicId(policy, JSON.rawJSON("1"))))).toBe(
      true,
    );
});
