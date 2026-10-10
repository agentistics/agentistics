/**
 * upgradeFlow.ts — the ONE install flow every update surface starts: the popup in the Nay window,
 * the bell's sheet (`UpdateModal`) and nothing else. Module scope, like `centralMachinePick.ts`,
 * because three components draw it and two copies of "is an upgrade running" is how a loader ends
 * up on screen twice.
 *
 * It owns no rule. WHEN to offer is `updateToast.ts`, WHICH step is `upgradeSteps.ts`, the words
 * are `updateI18n.ts`, and arriving is `appReload.ts`'s `upgradeArrived` + `clearAppCaches`, the
 * same pair the modal used before this module existed. What it adds is the sequence:
 *
 *   press → remember where the person is (`snapshotRestore`, sessionStorage: THIS tab only)
 *         → POST /api/upgrade (the server's refusal sentence is shown verbatim)
 *         → poll /api/upgrade/status + /api/version, folding each answer into the step
 *         → on arrival, hold "power" a beat, empty the service worker's caches, reload
 *   boot  → `consumeRestore` reads the snapshot on the bundle that arrived and hands the finale
 *           its version (`App.tsx` puts the route and the scroll back).
 *
 * The snooze ("remind me later") is per PERSON on the server — `/api/user-prefs`, key
 * `updateSnooze` — so dismissing it on the phone dismisses it on the desktop too.
 */

import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'
import { UPGRADE_POLL_MS, UPGRADE_WAIT_MS, browserReloadEnv, clearAppCaches, upgradeArrived, upgradeStalled } from './appReload'
import { measureRate, type ByteSample } from './updateAnim'
import { restartStep, type RestartPhase } from './upgradeRestart'
import { advance, rawStep, type ServerProgress, type StepView } from './upgradeSteps'
import {
  RESTORE_KEY, decodeRestore, encodeRestore, parseSnooze, snapshotRestore, snoozeFor, type RestoreState, type Snooze,
} from './updateToast'

// ---- remind me later, per person ----------------------------------------------------------------

const snoozeStore = createSharedPref<Snooze | null>({
  key: 'agentistics-update-snooze', prefKey: 'updateSnooze', fallback: null, parse: parseSnooze,
})

export function getUpdateSnooze(): Snooze | null { return snoozeStore.get() }
export function snoozeUpdate(version: string, critical: boolean, now = Date.now()): void {
  snoozeStore.set(snoozeFor(version, critical, now))
}
export function useUpdateSnooze(): Snooze | null {
  return useSyncExternalStore(snoozeStore.subscribe, snoozeStore.get, snoozeStore.serverSnapshot)
}

// ---- the flow ------------------------------------------------------------------------------------

export type FlowPhase = 'idle' | 'running' | 'arrived' | 'failed' | 'timeout'

export interface FlowState {
  phase: FlowPhase
  target: string
  /** The version this page was on when install was pressed (the title's origin); '' when unknown. */
  from: string
  startedAt: number
  view: StepView | null
  /** The last REAL byte count and the measured rate — what the scene estimates between polls from. */
  bytes: ByteSample | null
  rate: number | null
  /** The server's own refusal sentence, when it refused the press. */
  message: string | null
  /** Readiness is separate from the visual phase so the overlay survives the server restart. */
  restartPhase: RestartPhase | null
  /**
   * On a stop: the new version IS installed on disk and only the restart is missing (`/api/version`'s
   * `restartNeeded`). The failure screen then offers "Restart now" — pressing it restarts the server
   * onto the binary already there — instead of "Try again" over the claim that nothing was replaced.
   */
  restartReady?: boolean
}

const IDLE: FlowState = { phase: 'idle', target: '', from: '', startedAt: 0, view: null, bytes: null, rate: null, message: null, restartPhase: null }
let state: FlowState = IDLE
const listeners = new Set<() => void>()
const set = (next: Partial<FlowState>) => { state = { ...state, ...next }; for (const fn of listeners) fn() }

export function getFlow(): FlowState { return state }
export function subscribeFlow(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
// The server snapshot is the live state too: there is no SSR here, and the tests render with
// `renderToStaticMarkup`, which reads it.
export function useUpgradeFlow(): FlowState { return useSyncExternalStore(subscribeFlow, getFlow, getFlow) }

/** Close the loader after a failure or a timeout. A running upgrade is never closed from here. */
export function dismissFlow(): void {
  if (state.phase !== 'failed' && state.phase !== 'timeout') return
  state = IDLE
  for (const fn of listeners) fn()
}

/** Test seams: the module state is process-wide. */
export function resetFlow(): void { state = IDLE; runId++ }
export function setFlowForTest(next: FlowState): void { state = next; for (const fn of listeners) fn() }
export { IDLE as IDLE_FLOW }

/** How long the last step is held on screen before the reload — long enough to read "power on". */
export const ARRIVAL_HOLD_MS = 1100

let runId = 0
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    return r.ok ? await r.json() as T : null
  } catch { return null }
}

/** Ask the active worker to check for its replacement before we ever swap the document. */
async function updateReady(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const registration = await navigator.serviceWorker.ready
      await registration.update().catch(() => {})
      const pending = registration.installing ?? registration.waiting
      if (pending) {
        await Promise.race([
          new Promise<void>(resolve => {
            const done = () => { pending.removeEventListener('statechange', done); resolve() }
            pending.addEventListener('statechange', done)
          }),
          sleep(2500),
        ])
      }
      await navigator.serviceWorker.ready
    }
  } catch { /* browsers without a usable worker still have a network bundle */ }
  try {
    const response = await fetch(`/index.html?ag-update=${Date.now()}`, { cache: 'no-store' })
    return response.ok
  } catch { return false }
}

function rememberWhereIAm(target: string, from: string): void {
  try {
    const snap = snapshotRestore(window.location, window.scrollY, target, Date.now(), from)
    sessionStorage.setItem(RESTORE_KEY, encodeRestore(snap))
  } catch { /* storage blocked: the reload keeps the URL anyway, only the scroll is lost */ }
}

/** "Já está atualizado": no install ran, so no finale — the page simply reloads onto a fresh
 *  bundle. The restore snapshot taken above is dropped so a later reload does not replay one. */
async function reloadOntoCurrent(): Promise<void> {
  try { sessionStorage.removeItem(RESTORE_KEY) } catch { /* blocked */ }
  set({ phase: 'idle' })
  await clearAppCaches(browserReloadEnv())
  window.location.reload()
}

/** Is an in-app upgrade in flight? It reloads the page itself when the new version arrives. */
/** `/api/version` says the new binary is on disk and only a restart is missing. */
export function restartPending(info: { restartNeeded?: unknown } | null): boolean {
  return info?.restartNeeded === true
}

export function upgradeInFlight(): boolean {
  return state.phase === 'running' || state.phase === 'arrived'
}

/**
 * Start the install. Idempotent while one is running. `lang` picks the language of the server's
 * refusal sentence.
 */
export async function startUpgrade(target: string, lang: 'pt' | 'en'): Promise<void> {
  if (state.phase === 'running' || state.phase === 'arrived') return
  const id = ++runId
  const startedAt = Date.now()
  const before = await getJson<{ current?: string }>('/api/version')
  const from = typeof before?.current === 'string' ? before.current : ''
  // A stale popup offering the version this server ALREADY runs: nothing to install and nothing to
  // restart (two needless restarts on 2026-10-04 took the app and the phone offline). The page is
  // the stale thing — drop its cached bundle and reload onto the server's.
  if (from && upgradeArrived(before, target)) { await reloadOntoCurrent(); return }
  set({ phase: 'running', target, from, startedAt, restartPhase: 'updating', view: rawStep({ startedAt, progress: null, quietPolls: 0, arrived: false }), bytes: null, rate: null, message: null, restartReady: false })
  rememberWhereIAm(target, from)

  try {
    const res = await fetch(`/api/upgrade?lang=${lang}`, { method: 'POST' })
    const body = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; alreadyCurrent?: boolean }
    if (!res.ok || !body.ok) { if (id === runId) set({ phase: 'failed', message: body.message ?? null }); return }
    if (body.alreadyCurrent) { await reloadOntoCurrent(); return }
    set({ restartPhase: 'restarting' })
  } catch {
    if (id === runId) set({ phase: 'failed', message: null })
    return
  }

  const until = startedAt + UPGRADE_WAIT_MS
  let quiet = 0
  let progress: ServerProgress | null = null
  let lastInfo: { current?: string; restartNeeded?: unknown } | null = null
  while (Date.now() < until) {
    await sleep(UPGRADE_POLL_MS)
    if (id !== runId) return
    const [status, info] = await Promise.all([
      getJson<{ progress: ServerProgress | null }>('/api/upgrade/status'),
      getJson<{ current?: string; restartNeeded?: unknown }>('/api/version'),
    ])
    if (info) lastInfo = info
    quiet = status || info ? 0 : quiet + 1
    if (status) progress = status.progress
    const arrived = upgradeArrived(info, target)
    const version = arrived ? 'new' : info ? 'old' : 'down'
    const waiting = restartStep(state.restartPhase ?? 'restarting', { type: 'poll', version })
    const view = advance(state.view, rawStep({ startedAt, progress, quietPolls: quiet, arrived }))
    // `failed` is never the last word when the server ALREADY runs the target: a restart verdict can
    // be wrong while the new version answers (2026-10-05) and the page then said "the update did not
    // finish" beside the very version it had asked for. `arrived` outranks it, as in `rawStep`.
    if (view.failed && !arrived) { set({ phase: 'failed', view, message: null, restartReady: restartPending(info) }); return }
    let bytes = state.bytes, rate = state.rate
    if (progress?.stage === 'downloading' && progress.total && progress.received !== undefined) {
      const next: ByteSample = { received: progress.received, total: progress.total, at: Date.now() }
      if (!bytes || next.received !== bytes.received) { rate = measureRate(bytes, next, rate); bytes = next }
    }
    set({ view, bytes, rate, restartPhase: waiting })
    if (!arrived && upgradeStalled(Date.now() - startedAt, progress?.stage)) { set({ phase: 'timeout', restartReady: restartPending(lastInfo) }); return }
    if (arrived) {
      const ready = await updateReady()
      const readyPhase = restartStep(waiting, { type: 'poll', version: 'new', serviceWorkerReady: ready, bundleReady: ready })
      if (readyPhase !== 'ready') continue
      set({ phase: 'arrived', restartPhase: readyPhase })
      await sleep(ARRIVAL_HOLD_MS)
      set({ restartPhase: restartStep(readyPhase, { type: 'swap' }) })
      await clearAppCaches(browserReloadEnv())
      window.location.reload()
      return
    }
  }
  if (id === runId) set({ phase: 'timeout', restartReady: restartPending(lastInfo) })
}

/**
 * On boot: the snapshot an upgrade left for THIS tab, if the bundle that arrived is the one it was
 * for. Read once and removed, so a later plain reload does not replay the finale.
 */
export function consumeRestore(currentVersion: string, now = Date.now()): RestoreState | null {
  let raw: string | null = null
  try { raw = sessionStorage.getItem(RESTORE_KEY) } catch { return null }
  const r = decodeRestore(raw, now, currentVersion)
  if (r) { try { sessionStorage.removeItem(RESTORE_KEY) } catch { /* blocked */ } }
  return r
}

/**
 * Like `consumeRestore` but READS ONLY: the finale is mounted by `FinaleHost` on the very first
 * render of the new bundle (before any data), while `App` still consumes the snapshot later to put
 * the route and scroll back. Peeking leaves the key for that one consumer.
 */
export function peekRestore(currentVersion: string, now = Date.now()): RestoreState | null {
  try { return decodeRestore(sessionStorage.getItem(RESTORE_KEY), now, currentVersion) } catch { return null }
}
