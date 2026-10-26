/**
 * billingNotices — the save state of first-detection notice answers, kept OUTSIDE any component.
 *
 * An answer is optimistic in App's settings while its PUT is in flight; the notice must stay visible
 * (`saving`, then `failed`) until the write is acknowledged, whichever path made the edit (the notice's
 * own buttons or the period drawer) and even if the Billing page unmounts and remounts meanwhile.
 * When a write is acknowledged, every account whose own plan is in the stored snapshot is settled —
 * including answers whose own call failed but were carried by a later queued write.
 */
import { useSyncExternalStore } from 'react'
import type { BillingSettings } from '@agentistics/core'

export type NoticeSaveState = 'saving' | 'failed'

let state: Record<string, NoticeSaveState> = {}
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

export const billingNotices = {
  get: () => state,
  mark(id: string, s: NoticeSaveState) { state = { ...state, [id]: s }; emit() },
  clear(id: string) { if (!(id in state)) return; const { [id]: _gone, ...rest } = state; state = rest; emit() },
  /** A snapshot was stored: settle every account whose own plan it carries. */
  reconcile(stored: BillingSettings) {
    const next = Object.fromEntries(Object.entries(state).filter(([key]) => !stored.accountProfiles?.[key] && !stored.accountProfiles?.[key.slice(key.indexOf(':') + 1)]))
    if (Object.keys(next).length === Object.keys(state).length) return
    state = next; emit()
  },
  /** Drop a `failed` answer whose account no longer needs a plan (a default was registered since). */
  prune(needPlanIds: ReadonlySet<string>) {
    const next = Object.fromEntries(Object.entries(state).filter(([id, s]) => s !== 'failed' || needPlanIds.has(id)))
    if (Object.keys(next).length === Object.keys(state).length) return
    state = next; emit()
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  reset() { state = {}; emit() },
}

export function useNoticeSaveState(): Record<string, NoticeSaveState> {
  return useSyncExternalStore(billingNotices.subscribe, billingNotices.get, billingNotices.get)
}
