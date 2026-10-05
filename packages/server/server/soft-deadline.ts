/**
 * soft-deadline.ts — wait for a piece of work for at most `ms`, and WITHOUT cancelling it.
 *
 * The build asks git about every project. Almost every answer costs milliseconds; one huge or slow
 * repository (a 287 MB pack under WSL2 measured 18.5 s for one walk) used to hold the whole
 * `/api/data` build — and with it the app's first screen — for as long as git took. A hard timeout is
 * the wrong cure: it throws the half-finished walk away, so the next build pays the full price again,
 * every time (git.ts records exactly that storm).
 *
 * A soft deadline instead stops WAITING, not WORKING: the build moves on with `fallback` and reports
 * the path as deferred, while the walk keeps running and lands in git.ts's memo and on-disk cache.
 * `onLate` fires when the work finally settles, so the caller can rebuild once and pick the answer up
 * from that cache — "report it, skip it, retry later".
 *
 * The timer is cleared the moment the work settles (with-timeout.ts records why a timer left armed is
 * a leak), and `onLate` never fires for work that beat its deadline.
 */
import type { TimerFns } from './with-timeout'

const REAL_TIMERS: TimerFns = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export async function softDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  onLate: (outcome: 'resolved' | 'rejected') => void,
  timers: TimerFns = REAL_TIMERS,
): Promise<{ value: T; late: boolean }> {
  let late = false
  let settled = false
  let handle: unknown
  const deadline = new Promise<{ value: T; late: boolean }>(resolve => {
    handle = timers.set(() => { if (!settled) { late = true; resolve({ value: fallback, late: true }) } }, ms)
  })
  const done = work.then(
    value => { settled = true; timers.clear(handle); if (late) onLate('resolved'); return { value, late: false } },
    () => { settled = true; timers.clear(handle); if (late) onLate('rejected'); return { value: fallback, late: false } },
  )
  return Promise.race([done, deadline])
}
