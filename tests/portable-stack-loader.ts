import { Effect } from "effect";

Bun.plugin({
  name: "reject-cloudflare-provisioning",
  setup(builder) {
    builder.onResolve({ filter: /^@alchemy\.run\/cloudflare(?:\/|$)/ }, ({ path }) => {
      throw new Error(`Portable stack loaded Cloudflare provisioning: ${path}`);
    });
  },
});

const stack = (await import("../alchemy.run")).default;
if (!Effect.isEffect(stack)) throw new Error("Selected stack is not an Alchemy effect");
console.log(stack.stackName);
