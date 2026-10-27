import worker, { SearchNamespace as Namespace } from "../src/worker";
import { Schema } from "effect";
import { MigrationRaceArm, MigrationRaceStats } from "./root-migration-race-contract";
import { NamespaceName } from "../src/protocol";
import type { Env } from "../alchemy.run";

export { Segments, Terms } from "../src/worker";

const race = {
  arm: Schema.decodeSync(MigrationRaceArm)({ key: "", replacement: "", phase: "cas-put" }),
  fired: false,
  listed: false,
  bodyReads: 0,
};
const wrapped = new WeakSet<R2Bucket>();

function wrap(bucket: R2Bucket) {
  if (wrapped.has(bucket)) return;
  wrapped.add(bucket);
  const put = bucket.put.bind(bucket);
  const list = bucket.list.bind(bucket);
  const get = bucket.get.bind(bucket);
  Object.defineProperty(bucket, "list", {
    value: async (...args: Parameters<R2Bucket["list"]>) => {
      const page = await list(...args);
      if (page.objects.some((object) => object.key === race.arm.key)) race.listed = true;
      return page;
    },
  });
  Object.defineProperty(bucket, "get", {
    value: async (...args: Parameters<R2Bucket["get"]>) => {
      if (
        !race.fired &&
        race.listed &&
        race.arm.phase === "capture-after-list" &&
        args[0] === race.arm.key
      ) {
        race.fired = true;
        await put(args[0], race.arm.replacement);
      }
      const object = await get(...args);
      if (object !== null && args[0] === race.arm.key && "arrayBuffer" in object) {
        const read = object.arrayBuffer.bind(object);
        Object.defineProperty(object, "arrayBuffer", {
          value: async () => {
            race.bodyReads += 1;
            return read();
          },
        });
      }
      return object;
    },
  });
  Object.defineProperty(bucket, "put", {
    value: async (...args: Parameters<R2Bucket["put"]>) => {
      const condition = args[2]?.onlyIf;
      if (
        !race.fired &&
        race.arm.phase === "cas-put" &&
        args[0] === race.arm.key &&
        condition !== undefined &&
        "etagMatches" in condition &&
        condition.etagMatches !== undefined
      ) {
        race.fired = true;
        await put(args[0], race.arm.replacement);
      }
      return put(...args);
    },
  });
}

export class SearchNamespace extends Namespace {
  override async fetch(request: Request) {
    wrap(this.env.STORAGE);
    const path = new URL(request.url).pathname;
    if (path === "/fixture/arm-race") {
      race.arm = Schema.decodeUnknownSync(MigrationRaceArm)(await request.json());
      race.fired = false;
      race.listed = false;
      race.bodyReads = 0;
      return new Response(null, { status: 204 });
    }
    if (path === "/fixture/race-stats")
      return Response.json(
        Schema.encodeSync(MigrationRaceStats)({
          fired: race.fired,
          listed: race.listed,
          bodyReads: race.bodyReads,
        }),
      );
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/arm-race" || url.pathname === "/fixture/race-stats") {
      const namespace = Schema.decodeUnknownSync(NamespaceName)(url.searchParams.get("namespace"));
      return env.NAMESPACES.get(env.NAMESPACES.idFromName(namespace)).fetch(request);
    }
    return worker.fetch(request, env, ctx);
  },
};
