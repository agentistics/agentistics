/**
 * with-timeout.ts — bound a promise by a deadline, and DISARM the deadline when the promise settles.
 *
 * The shape this replaces is `Promise.race([work, new Promise((_, reject) => setTimeout(reject, ms))])`,
 * which looks free and is not: the timer stays armed until it fires, and its closure chain (the
 * timer -> `reject` -> the race's reaction -> the race promise) keeps the race's SETTLED VALUE alive
 * for the whole of `ms`. `_buildApiResponseCore` raced every build against a 5-minute timer, so
 * every build's full ApiResponse (~7.7 MB on a real machine) stayed reachable for five minutes after
 * it was done — and builds fire as often as anything invalidates them. That is what took
 * `agentop server` to 7.4 GB RSS and an OOM kill on 2026-09-26: measured, one live Timeout per
 * build, and the heap fell 481 MB -> 12 MB at the exact moment the timers expired.
 *
 * Clearing in `finally` releases the chain the instant the work settles, either way. The timer
 * functions are injectable so the test can see exactly what is armed and what is cleared.
 */

export interface TimerFns {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIMERS: TimerFns = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** `work`'s outcome, or a rejection with `message` once `ms` has passed — whichever comes first. */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
  timers: TimerFns = REAL_TIMERS,
): Promise<T> {
  let handle: unknown
  const deadline = new Promise<never>((_, reject) => {
    handle = timers.set(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    timers.clear(handle)
  }
}
