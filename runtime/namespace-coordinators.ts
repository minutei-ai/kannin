import { Cause } from "effect";

type WaitUntil = (promise: Promise<unknown>) => void;

export class NamespaceCoordinators<Actor> {
  private readonly entries = new Map<string, { actor: Actor; activity: { count: number } }>();

  constructor(
    private readonly create: (waitUntil: WaitUntil) => Actor,
    private readonly waitUntil: WaitUntil,
    private readonly capacity = 1024,
  ) {}

  private acquire(name: string) {
    const existing = this.entries.get(name);
    if (existing !== undefined) return existing;
    if (this.entries.size >= this.capacity)
      for (const [key, entry] of this.entries)
        if (entry.activity.count === 0) {
          this.entries.delete(key);
          break;
        }
    if (this.entries.size >= this.capacity)
      throw new Cause.UnknownError(new Error("Namespace coordination capacity exceeded"));
    const activity = { count: 0 };
    const actor = this.create((promise) => {
      activity.count += 1;
      this.waitUntil(
        promise.finally(() => {
          activity.count -= 1;
        }),
      );
    });
    const owned = { actor, activity };
    this.entries.set(name, owned);
    return owned;
  }

  async run<Result>(name: string, operation: (actor: Actor) => Promise<Result>) {
    const owned = this.acquire(name);
    owned.activity.count += 1;
    return Promise.resolve()
      .then(() => operation(owned.actor))
      .finally(() => {
        owned.activity.count -= 1;
      });
  }

  clear() {
    this.entries.clear();
  }
}
