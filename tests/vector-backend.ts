import { WorkerEntrypoint } from "cloudflare:workers";

const vectors = new Map<string, VectorizeVector>();
const pending: VectorizeVector[] = [];
const control = { fail: false, deferred: false };

export class VectorBackend extends WorkerEntrypoint {
  async upsert(input: VectorizeVector[]) {
    if (control.fail) throw new Error("Injected Vectorize failure");
    for (const vector of input) {
      if (control.deferred) pending.push(vector);
      else vectors.set(vector.id, vector);
    }
    return { mutationId: crypto.randomUUID() };
  }

  async deleteByIds(ids: string[]) {
    if (control.fail) throw new Error("Injected Vectorize failure");
    for (const id of ids) vectors.delete(id);
    return { mutationId: crypto.randomUUID() };
  }

  async query(values: number[], options: VectorizeQueryOptions) {
    if (control.fail) throw new Error("Injected Vectorize failure");
    if (options.returnMetadata === "all" && (options.topK ?? 5) > 50)
      throw new Error("Vectorize topK with all metadata is limited to 50");
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    const matches = [...vectors.values()]
      .filter((vector) => vector.namespace === options.namespace)
      .map((vector) => {
        const magnitude = Math.sqrt(
          [...vector.values].reduce((sum, value) => sum + value * value, 0),
        );
        const dot = [...vector.values].reduce(
          (sum, value, index) => sum + value * values[index],
          0,
        );
        return {
          id: vector.id,
          namespace: vector.namespace,
          metadata: vector.metadata,
          score: dot / (norm * magnitude),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK);
    return { matches, count: matches.length };
  }

  async describe() {
    return {
      dimensions: 768,
      vectorCount: vectors.size,
      processedUpToDatetime: Date.now(),
      processedUpToMutation: 0,
    };
  }
}

export default {
  fetch(request: Request) {
    const operation = new URL(request.url).pathname;
    control.fail = operation === "/fail";
    control.deferred = operation === "/defer";
    if (operation === "/commit-reversed")
      for (const vector of pending.splice(0).toReversed()) vectors.set(vector.id, vector);
    return Response.json({ vectors: vectors.size, pending: pending.length });
  },
};
