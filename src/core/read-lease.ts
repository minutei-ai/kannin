import { Cause, Clock, Duration, Effect, Schema } from "effect";
import { Rejected } from "../protocol";

export const STRONG_QUERY_READER_MS = 30_000;
const READER_LIMIT_NANOS = BigInt(STRONG_QUERY_READER_MS) * 1_000_000n;

export type ReaderLeaseStart = {
  readonly wallNanos: bigint;
  readonly monotonicNanos: bigint;
};

export const captureReaderLease = Effect.gen(function* () {
  const wallNanos = yield* Clock.currentTimeNanos;
  const monotonicNanos = yield* Clock.monotonicTimeNanos;
  return { wallNanos, monotonicNanos };
});

export function readerLeaseExpired(
  started: ReaderLeaseStart,
  wallNanos: bigint,
  monotonicNanos: bigint,
) {
  const wall = wallNanos - started.wallNanos;
  const monotonic = monotonicNanos - started.monotonicNanos;
  if (wall < 0n || wall >= READER_LIMIT_NANOS) return true;
  if (monotonic < 0n || monotonic >= READER_LIMIT_NANOS) return true;
  return false;
}

export function strongQueryDeadline() {
  return new Rejected({
    status: 504,
    message: "Strong query exceeded its 30-second reader lease",
  });
}

export function strongQueryFailure(cause: unknown) {
  if (Schema.is(Rejected)(cause)) return cause;
  if (Cause.isUnknownError(cause)) return cause;
  return new Cause.UnknownError(cause);
}

export function ownedRead<A>(read: (signal: AbortSignal) => Promise<A>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (owner) =>
      Effect.tryPromise({
        try: (signal) => read(AbortSignal.any([owner.signal, signal])),
        catch: strongQueryFailure,
      }),
    (owner) => Effect.sync(() => owner.abort()),
  );
}

export function rejectExpiredReader(started: ReaderLeaseStart) {
  return Effect.gen(function* () {
    const wallNanos = yield* Clock.currentTimeNanos;
    const monotonicNanos = yield* Clock.monotonicTimeNanos;
    if (readerLeaseExpired(started, wallNanos, monotonicNanos)) return yield* strongQueryDeadline();
    return undefined;
  });
}

export function readerBudgetMillis(started: ReaderLeaseStart) {
  return Effect.gen(function* () {
    const wallNanos = yield* Clock.currentTimeNanos;
    const monotonicNanos = yield* Clock.monotonicTimeNanos;
    if (readerLeaseExpired(started, wallNanos, monotonicNanos)) return 0;
    const wallRemaining = READER_LIMIT_NANOS - (wallNanos - started.wallNanos);
    const monotonicRemaining = READER_LIMIT_NANOS - (monotonicNanos - started.monotonicNanos);
    const remaining = { nanos: wallRemaining };
    if (monotonicRemaining < remaining.nanos) remaining.nanos = monotonicRemaining;
    const budget = { value: Number(remaining.nanos / 1_000_000n) };
    if (budget.value > STRONG_QUERY_READER_MS) budget.value = STRONG_QUERY_READER_MS;
    if (budget.value <= 0) return 0;
    return budget.value;
  });
}

export function finishStrongRead<A, E, R>(
  started: ReaderLeaseStart,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const budget = yield* readerBudgetMillis(started);
    if (budget <= 0) return yield* strongQueryDeadline();
    const value = yield* effect.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(budget),
        orElse: () => Effect.fail(strongQueryDeadline()),
      }),
    );
    yield* rejectExpiredReader(started);
    return value;
  });
}
