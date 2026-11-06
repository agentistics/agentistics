/**
 * inputQuiet.ts — let a background refresh land BETWEEN the person's keystrokes, not under them.
 *
 * APP.LENTO (owner, 06/11: "as digitações têm travado"). While sessions work the server pushes a data
 * patch after every rebuild, every few seconds, and swapping `data` re-runs the dashboard's whole
 * derivation (`computeDerivedStats` over every stored session) — a ~300 ms task React cannot split.
 * Landing inside a sentence, that is a keystroke that appears 300 ms late. The data is a background
 * fact with no deadline measured in milliseconds; a keystroke has one. So a refresh that finds the
 * person typing waits until the input has been quiet for `QUIET_MS`, and never longer than
 * `MAX_WAIT_MS` (so a long dictation cannot freeze the numbers indefinitely). Several refreshes that
 * arrive while waiting collapse into one: only the latest is rendered.
 */
export const QUIET_MS = 900
export const MAX_WAIT_MS = 8_000

/** PURE: how long a queued render must still wait (0 = now). */
export function quietDelay(now: number, lastInputAt: number, queuedAt: number, quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS): number {
  const quietIn = lastInputAt + quietMs - now
  const deadlineIn = queuedAt + maxWaitMs - now
  return Math.max(0, Math.min(quietIn, deadlineIn))
}

let lastInputAt = -Infinity
let installed = false
function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const mark = () => { lastInputAt = Date.now() }
  for (const type of ['keydown', 'input', 'compositionupdate'] as const) window.addEventListener(type, mark, { capture: true, passive: true })
}

let pending: { run: () => void; queuedAt: number; timer: ReturnType<typeof setTimeout> | null } | null = null

/** Run `render` now if nobody is typing, else once the input is quiet; a newer call replaces an older one. */
export function renderWhenInputQuiet(render: () => void): void {
  install()
  const queuedAt = pending?.queuedAt ?? Date.now()
  if (pending?.timer) clearTimeout(pending.timer)
  pending = { run: render, queuedAt, timer: null }
  const tick = () => {
    if (!pending) return
    const wait = quietDelay(Date.now(), lastInputAt, pending.queuedAt)
    if (wait > 0) { pending.timer = setTimeout(tick, wait); return }
    const run = pending.run
    pending = null
    run()
  }
  tick()
}

/** Tests only. */
export function resetInputQuiet(): void {
  if (pending?.timer) clearTimeout(pending.timer)
  pending = null
  lastInputAt = -Infinity
}
/** Tests only. */
export function markInputForTest(at: number): void { lastInputAt = at }
