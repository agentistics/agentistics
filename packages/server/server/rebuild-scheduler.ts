/**
 * rebuild-scheduler.ts — when `/api/data` is rebuilt after the files under it change (PERF.1 step 4).
 *
 * Before: a file change marked the cache stale and told every client `change` two seconds later; the
 * client's refetch was then answered from the STALE cache (stale-while-revalidate) while the rebuild
 * started, and nothing announced the rebuild when it landed. Every dashboard sat one change behind.
 *
 * Now a change schedules a rebuild (`debounceMs`, so a burst of writes is one build), clients are told
 * `change` only when the NEW data exists, changes that arrive during a build are coalesced into ONE
 * build after it, and builds start at most every `minGapMs` so a session writing constantly cannot
 * keep the machine rebuilding back to back.
 */
export interface RebuildScheduler {
  /** Something under the data changed. */
  changed(): void
  /** For tests and status: a build is running / queued. */
  state(): { running: boolean; pending: boolean }
}

export function createRebuildScheduler(o: {
  build: () => Promise<void>
  /** Called after a build that succeeded: the data is new. */
  onRebuilt: () => void
  debounceMs: number
  minGapMs: number
  now?: () => number
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): RebuildScheduler {
  const now = o.now ?? Date.now
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let running = false
  let pending = false
  let lastStart = -Infinity

  function arm(ms: number) {
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => { timer = null; void run() }, Math.max(0, ms))
  }

  async function run() {
    if (running) { pending = true; return }
    const wait = lastStart + o.minGapMs - now()
    if (wait > 0) { arm(wait); return }
    running = true
    pending = false
    lastStart = now()
    let ok = false
    try { await o.build(); ok = true } catch { /* the previous data keeps being served */ }
    running = false
    if (ok) o.onRebuilt()
    if (pending) arm(o.debounceMs)
  }

  return {
    changed() {
      if (running) { pending = true; return }
      arm(o.debounceMs)
    },
    state: () => ({ running, pending: pending || timer !== null }),
  }
}
