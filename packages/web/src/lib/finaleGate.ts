/**
 * finaleGate.ts — what the boot of the bundle that an in-app UPDATE just arrived on must know about
 * that update. Two facts, both decided once, at module load, from the restore snapshot the old page
 * left for THIS tab (`peekRestore`):
 *
 *   - IS THE FINALE ON SCREEN? `FinaleHost` draws it from the first frame and ends it here. While it
 *     is up the app beneath it is hidden, so it must not do its heavy first work there — the full
 *     payload (9 MB on a real machine), the derived stats and the whole dashboard's first render are
 *     long tasks, and a long task is a frame the finale's canvas does not get. That is the stutter at
 *     the end of the update: the app booting on the same thread as the animation.
 *   - HOW LONG AGO DID THE SERVER COME BACK? The old page reloaded seconds after the NEW server first
 *     answered `/api/version`; the server is then still building its first data (~11 s measured,
 *     with a ~5 s finalize), and may not answer a probe within its deadline. That is a server known
 *     to be up and starting — never "can't reach agentistics", which is what the boot screen said
 *     (`startupLoad.ts` `bootWatchdog` / `holdLoadError`).
 *
 * A plain reload has no snapshot, so both are inert and the boot is exactly what it was.
 */
import { useSyncExternalStore } from 'react'
import { BUNDLE_VERSION } from './bundleVersion'
import { peekRestore } from './upgradeFlow'

function arrivedFromUpdate(): boolean {
  try { return BUNDLE_VERSION ? peekRestore(BUNDLE_VERSION) !== null : false } catch { return false }
}

const fromUpdate = arrivedFromUpdate()
let active = fromUpdate
/** When this bundle booted after an update; `null` when it did not. */
let updatedAt: number | null = fromUpdate ? Date.now() : null
const listeners = new Set<() => void>()
const waiting = new Set<() => void>()

/** The finale is on screen. */
export function finaleActive(): boolean { return active }

/** Milliseconds since this bundle booted from an update, or `null` for an ordinary boot. */
export function sinceUpdate(now = Date.now()): number | null {
  return updatedAt === null ? null : Math.max(0, now - updatedAt)
}

/** The finale has left (by itself, a tap or Escape). Idempotent. */
export function endFinale(): void {
  if (!active) return
  active = false
  for (const fn of listeners) fn()
  const run = [...waiting]
  waiting.clear()
  for (const fn of run) fn()
}

/** Run `fn` once the finale has left — now, when it is not on screen. Returns a canceller. */
export function afterFinale(fn: () => void): () => void {
  if (!active) { fn(); return () => {} }
  waiting.add(fn)
  return () => { waiting.delete(fn) }
}

function subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
export function useFinaleActive(): boolean {
  return useSyncExternalStore(subscribe, finaleActive, finaleActive)
}

/** Test seam: the module state is process-wide. */
export function setFinaleForTest(next: { active: boolean; updatedAt: number | null }): void {
  active = next.active
  updatedAt = next.updatedAt
  waiting.clear()
  for (const fn of listeners) fn()
}
