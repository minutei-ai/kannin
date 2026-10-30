import { Schema } from "effect";
import { DeploymentTarget } from "./src/protocol";

export type { Env } from "./infra/cloudflare";

const deploymentTarget = Schema.decodeUnknownSync(DeploymentTarget)(
  process.env["KANNIN_TARGET"] ?? "railway",
);
async function selectedStack() {
  if (deploymentTarget === "railway") return (await import("./infra/railway")).default();
  if (deploymentTarget === "docker") return (await import("./infra/docker")).default();
  return (await import("./infra/cloudflare")).default();
}
export default await selectedStack();
