/**
 * The idle-sessions switch, its two thresholds and the "keep" marks. SERVER-SIDE through
 * `createSharedPref` (like session groups): a keep is a fact about the work, and must read the same
 * from a phone. Absent reads as ENABLED — the feature only suggests; nothing ends unconfirmed.
 */
import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'

export interface IdleSessionsPrefs {
  enabled: boolean
  thresholdMin: number
  pressureThresholdMin: number
  /** Warn when one reply resends more than this many tokens (0 = off). Lives here to ride the registered `idleSessions` key. */
  replyCostThreshold: number
  kept: Record<string, number>
}

export const DEFAULT_IDLE_PREFS: IdleSessionsPrefs = { enabled: true, thresholdMin: 120, pressureThresholdMin: 30, replyCostThreshold: 300_000, kept: {} }

const posInt = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v) : fallback

export function parseIdlePrefs(raw: unknown): IdleSessionsPrefs | null {
  if (raw === undefined || raw === null) return { ...DEFAULT_IDLE_PREFS, kept: {} }
  if (typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kept: Record<string, number> = {}
  if (r.kept && typeof r.kept === 'object') {
    for (const [k, v] of Object.entries(r.kept as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) kept[k] = v
    }
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_IDLE_PREFS.enabled,
    thresholdMin: posInt(r.thresholdMin, DEFAULT_IDLE_PREFS.thresholdMin),
    pressureThresholdMin: posInt(r.pressureThresholdMin, DEFAULT_IDLE_PREFS.pressureThresholdMin),
    replyCostThreshold: typeof r.replyCostThreshold === 'number' && Number.isFinite(r.replyCostThreshold) && r.replyCostThreshold >= 0 ? Math.round(r.replyCostThreshold) : DEFAULT_IDLE_PREFS.replyCostThreshold,
    kept,
  }
}

// NOTE on the `parse(undefined)` contract (see the task-4 report for the full reasoning): the
// generic `createSharedPref`/`adopt` never actually CALLS `parse` with `undefined` — it special-cases
// that branch itself (`raw === undefined ? fallback : parse(raw)`), exactly as `sessionUserGroups.ts`
// relies on. `parseIdlePrefs(undefined)` returning the defaults is therefore only exercised directly
// by this module's own test (matching the brief's required behaviour), never by the store's adopt
// path — so this store clobbers a local-only value back to defaults on the same schedule every other
// `createSharedPref` store does (the first successful load after a value was set locally but never
// reached the server), and not any differently.
const store = createSharedPref<IdleSessionsPrefs>({
  key: 'agentistics-idle-sessions',
  prefKey: 'idleSessions',
  fallback: DEFAULT_IDLE_PREFS,
  parse: parseIdlePrefs,
})

export function useIdlePrefs(): IdleSessionsPrefs {
  return useSyncExternalStore(store.subscribe, store.get, store.serverSnapshot)
}

export function setIdlePrefs(patch: Partial<IdleSessionsPrefs>): void {
  store.set({ ...store.get(), ...patch })
}

export function keepSessions(keys: string[], at: number): void {
  const cur = store.get()
  store.set({ ...cur, kept: { ...cur.kept, ...Object.fromEntries(keys.map(k => [k, at])) } })
}

/** Drop keep marks for sessions no longer in the fleet, so the document does not grow forever. */
export function pruneKept(liveKeys: ReadonlySet<string>): void {
  const cur = store.get()
  const kept = Object.fromEntries(Object.entries(cur.kept).filter(([k]) => liveKeys.has(k)))
  if (Object.keys(kept).length !== Object.keys(cur.kept).length) store.set({ ...cur, kept })
}
