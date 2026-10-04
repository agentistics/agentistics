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
 *
 * REBUILD STORM (v2.103.1, owner: "está mais lento ainda"): with ~10 live sessions writing, a change
 * lands during every build, and the gap was measured from the build's START — so a 1–2 s build met
 * a 2 s gap that had already elapsed, and the next build began the moment the last one ended:
 * `[data] built in …` every ~2 s, the server at 134 % CPU. The gap is now the IDLE time after a
 * build ENDS, and it GROWS WITH THE BUILD: `loadFactor × the last build's duration`, clamped to
 * `[minGapMs, maxGapMs]`. A 2 s build is followed by 8 s of idle at the default factor of 4, which
 * holds the rebuild duty cycle near 20 % however many sessions write; a fast build keeps the 2 s floor.
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
  /** The least idle time between one build ending and the next starting. */
  minGapMs: number
  /** The most idle time a slow build can impose (default: `minGapMs`, i.e. a fixed gap). */
  maxGapMs?: number
  /** Idle time per ms of the last build (default 0: the fixed `minGapMs`). */
  loadFactor?: number
  now?: () => number
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): RebuildScheduler {
  const now = o.now ?? Date.now
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  /** When the oldest change still waiting for a build arrived (null: none is waiting). */
  let waitingSince: number | null = null
  let running = false
  let pending = false
  let lastEnd = -Infinity
  let lastDuration = 0
  const maxGap = Math.max(o.minGapMs, o.maxGapMs ?? o.minGapMs)
  const gap = () => Math.min(maxGap, Math.max(o.minGapMs, (o.loadFactor ?? 0) * lastDuration))

  function arm(ms: number) {
    if (waitingSince === null) waitingSince = now()
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => { timer = null; void run() }, Math.max(0, ms))
  }

  async function run() {
    if (running) { pending = true; return }
    const wait = lastEnd + gap() - now()
    if (wait > 0) { arm(wait); return }
    running = true
    pending = false
    waitingSince = null
    const start = now()
    let ok = false
    try { await o.build(); ok = true } catch { /* the previous data keeps being served */ }
    running = false
    lastEnd = now()
    lastDuration = lastEnd - start
    if (ok) o.onRebuilt()
    // `run` re-checks the gap, so this only debounces; the idle time is enforced there.
    if (pending) arm(o.debounceMs)
  }

  return {
    changed() {
      if (running) { pending = true; return }
      // A debounce that every change RESETS never fires while changes keep coming — measured with
      // ten sessions writing twenty lines a second, the data was not rebuilt at all until they
      // stopped. Once a change has waited the gap, the timer already armed is left to fire.
      if (timer !== null && waitingSince !== null && now() - waitingSince >= Math.max(o.minGapMs, 4 * o.debounceMs)) return
      arm(o.debounceMs)
    },
    state: () => ({ running, pending: pending || timer !== null }),
  }
}
