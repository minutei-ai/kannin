import { expect, test } from "bun:test";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

test("named service bindings preserve lazy references to another stack", () => {
  const target = Effect.runSync(Cloudflare.Worker.ref("Search", { stack: "Raio", stage: "prod" }));
  const binding = Cloudflare.WorkerEntrypoint(target, "KanninRpc");
  expect(binding.worker).toBe(target);
  expect(binding.entrypoint).toBe("KanninRpc");
  const self = Cloudflare.WorkerEntrypoint("Terms");
  expect(self.worker).toBeUndefined();
  expect(self.entrypoint).toBe("Terms");
  const configured = Cloudflare.WorkerEntrypoint({
    entrypoint: "Segments",
    props: { source: "immutable" },
  });
  expect(configured.worker).toBeUndefined();
  expect(configured.entrypoint).toBe("Segments");
  expect(configured.props).toEqual({ source: "immutable" });
});
