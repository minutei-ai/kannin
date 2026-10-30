import { expect, test } from "bun:test";
import { Cause, Clock, Deferred, Duration, Effect } from "effect";
import {
  STRONG_QUERY_READER_MS,
  finishStrongRead,
  ownedRead,
  readerLeaseExpired,
  strongQueryFailure,
  type ReaderLeaseStart,
} from "../src/core/read-lease";
import { Rejected } from "../src/protocol";

const limit = BigInt(STRONG_QUERY_READER_MS) * 1_000_000n;
const started: ReaderLeaseStart = { wallNanos: 0n, monotonicNanos: 0n };
const deadline = "Strong query exceeded its 30-second reader lease";

test("a failed read branch cancels its still-running sibling before returning the failure", async () => {
  const stopped = Deferred.makeUnsafe<void>();
  const failure = new Rejected({ status: 503, message: "vector branch failed" });
  const pending = Effect.runPromise(
    ownedRead((signal) =>
      Promise.all([
        Effect.runPromise(
          Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
          { signal },
        ),
        Promise.reject(failure),
      ]),
    ),
  );
  expect(await pending.catch((cause: unknown) => cause)).toBe(failure);
  await Effect.runPromise(Deferred.await(stopped).pipe(Effect.timeout("1 second")));
});

test("successful read scopes also release their producer controller", async () => {
  const observed: { signal?: AbortSignal } = {};
  expect(
    await Effect.runPromise(
      ownedRead((signal) => {
        observed.signal = signal;
        return Promise.resolve("complete");
      }),
    ),
  ).toBe("complete");
  expect(observed.signal?.aborted).toBe(true);
});

test("backend abort failures retain their native causes instead of becoming lease timeouts", () => {
  for (const cause of [
    new DOMException("backend aborted its own request", "AbortError"),
    new Error("All fibers interrupted without error"),
  ]) {
    const failure = strongQueryFailure(cause);
    expect(Cause.isUnknownError(failure)).toBe(true);
    if (!Cause.isUnknownError(failure)) throw new Error("Native backend failure was reclassified");
    expect(failure.cause).toBe(cause);
    expect(strongQueryFailure(failure)).toBe(failure);
  }
  const declared = new Rejected({ status: 503, message: "Native backend unavailable" });
  expect(strongQueryFailure(declared)).toBe(declared);
});

type ManualClock = {
  wall: bigint;
  monotonic: bigint;
  readonly slept: { count: number };
  release: (() => void) | undefined;
};

function clockFor(state: ManualClock) {
  const currentTimeMillisUnsafe = () => Number(state.wall / 1_000_000n);
  const currentTimeNanosUnsafe = () => state.wall;
  const monotonicTimeNanosUnsafe = () => state.monotonic;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe,
    currentTimeNanosUnsafe,
    monotonicTimeNanosUnsafe,
    currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
    currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
    monotonicTimeNanos: Effect.sync(monotonicTimeNanosUnsafe),
    sleep: (duration) =>
      Effect.sync(() => {
        state.slept.count += 1;
        state.slept.count += Number(Duration.toMillis(duration) < 0);
        const release = state.release;
        if (release !== undefined) release();
      }).pipe(Effect.andThen(Effect.never)),
  };
  return clock;
}

function freshClock() {
  const state: ManualClock = {
    wall: 0n,
    monotonic: 0n,
    slept: { count: 0 },
    release: undefined,
  };
  return { state, clock: clockFor(state) };
}

async function observe(effect: Effect.Effect<string, Rejected>, clock: Clock.Clock) {
  return Effect.runPromise(
    Effect.provideService(
      effect.pipe(
        Effect.map((value) => ({ failed: false, message: "", value })),
        Effect.catch((error) =>
          Effect.succeed({ failed: true, message: error.message, value: "" }),
        ),
      ),
      Clock.Clock,
      clock,
    ),
  );
}

test("reader lease expires on either clock, backwards time, and the exact 30 second bound", () => {
  expect(readerLeaseExpired(started, limit, 0n)).toBe(true);
  expect(readerLeaseExpired(started, limit - 1_000_000n, 0n)).toBe(false);
  expect(readerLeaseExpired(started, 0n, limit)).toBe(true);
  expect(readerLeaseExpired(started, 0n, limit - 1_000_000n)).toBe(false);
  expect(readerLeaseExpired(started, -1n, 0n)).toBe(true);
  expect(readerLeaseExpired(started, 0n, -1n)).toBe(true);
  expect(readerLeaseExpired(started, 1n, 1n)).toBe(false);
});

test("a fast strong read succeeds inside the reader lease", async () => {
  const { clock } = freshClock();
  const observed = await observe(finishStrongRead(started, Effect.succeed("ok")), clock);
  expect(observed).toEqual({ failed: false, message: "", value: "ok" });
});

test("an exhausted reader budget does not run the query effect", async () => {
  const manual = freshClock();
  manual.state.wall = limit;
  const ran = { value: false };
  const observed = await observe(
    finishStrongRead(
      started,
      Effect.sync(() => {
        ran.value = true;
        return "late";
      }),
    ),
    manual.clock,
  );
  expect(ran.value).toBe(false);
  expect(manual.state.slept.count).toBe(0);
  expect(observed.failed).toBe(true);
  expect(observed.message).toBe(deadline);
});

test("a late success is discarded when the timeout sleep never wins", async () => {
  const manual = freshClock();
  const observed = await observe(
    finishStrongRead(
      started,
      Effect.callback((resume, signal) => {
        manual.state.release = () => {
          if (signal.aborted) return;
          manual.state.wall = limit;
          manual.state.monotonic = limit;
          resume(Effect.succeed("late"));
        };
      }),
    ),
    manual.clock,
  );
  expect(manual.state.slept.count).toBe(1);
  expect(observed.failed).toBe(true);
  expect(observed.message).toBe(deadline);
  expect(observed.value).toBe("");
});

test("wall movement during suspension expires the lease while monotonic time stays put", async () => {
  const manual = freshClock();
  const observed = await observe(
    finishStrongRead(
      started,
      Effect.callback((resume, signal) => {
        manual.state.release = () => {
          if (signal.aborted) return;
          manual.state.wall = limit;
          resume(Effect.succeed("suspended"));
        };
      }),
    ),
    manual.clock,
  );
  expect(observed.failed).toBe(true);
  expect(observed.message).toBe(deadline);
});

test("a backwards wall clock and a backwards monotonic clock reject the read", async () => {
  const backwardsWall = freshClock();
  const wall = await observe(
    finishStrongRead(
      started,
      Effect.callback((resume, signal) => {
        backwardsWall.state.release = () => {
          if (signal.aborted) return;
          backwardsWall.state.wall = -1n;
          resume(Effect.succeed("backwards"));
        };
      }),
    ),
    backwardsWall.clock,
  );
  expect(wall.failed).toBe(true);
  expect(wall.message).toBe(deadline);
  const backwardsMonotonic = freshClock();
  const monotonic = await observe(
    finishStrongRead(
      started,
      Effect.callback((resume, signal) => {
        backwardsMonotonic.state.release = () => {
          if (signal.aborted) return;
          backwardsMonotonic.state.monotonic = -1n;
          resume(Effect.succeed("backwards"));
        };
      }),
    ),
    backwardsMonotonic.clock,
  );
  expect(monotonic.failed).toBe(true);
  expect(monotonic.message).toBe(deadline);
});
