/**
 * endingSessions.ts — which sessions are being ENDED right now.
 *
 * Opening a session has a state of its own (`SessionCreating`); ending one had none, so pressing
 * "End session" left the conversation and its composer looking alive for the seconds the kill takes
 * — indistinguishable from a click that did nothing. The mark is set the instant a `kill` is sent
 * (`useFleet`'s `act`, the ONE door every surface ends a session through, the header menu and the
 * aside row menu alike) and cleared when that call settles, success or refusal: on success the
 * caller steps away from the row, on failure the view is restored and the verb's own sentence says
 * why. It is a fact about a request in flight, so it is held in memory and never persisted.
 */
import { useSyncExternalStore } from 'react'

const ending = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void { version++; for (const l of listeners) l() }

export function markEnding(id: string): void {
  if (ending.has(id)) return
  ending.add(id)
  emit()
}

export function unmarkEnding(id: string): void {
  if (ending.delete(id)) emit()
}

export function isEnding(id: string | undefined): boolean {
  return id !== undefined && ending.has(id)
}

/** Test seam: forget everything. */
export function resetEnding(): void {
  ending.clear()
  emit()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** True while `id` has a `kill` in flight. */
export function useEnding(id: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0)
  return isEnding(id)
}
