/**
 * endingSessions.ts — which sessions are being ENDED right now.
 *
 * Opening a session has a state of its own (`SessionCreating`); ending one had none, so pressing
 * "End session" left the conversation and its composer looking alive for the seconds the kill takes
 * — indistinguishable from a click that did nothing. The mark is set the instant a `kill` is sent
 * (`useFleet`'s `act`, the ONE door every surface ends a session through, the header menu and the
 * aside row menu alike). A successful kill stays marked for at least 800 ms AND until the fleet
 * confirms it has left Active. The caller only navigates after both conditions hold. A refusal
 * clears the mark immediately so the mounted conversation and draft return. This is transient
 * request state, held in memory and never persisted.
 */
import { useRef, useSyncExternalStore } from 'react'

// A selection can keep this attempt after it leaves the map. That lets a successful loader
// survive the router's deferred navigation without retaining completed sessions globally.
interface EndingAttempt { succeeded: boolean }
const ending = new Map<string, EndingAttempt>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void { version++; for (const l of listeners) l() }

export function markEnding(id: string): void {
  if (ending.has(id)) return
  ending.set(id, { succeeded: false })
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

/** True while `id` is ending, including its minimum visible interval. */
export function useEnding(id: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0)
  return isEnding(id)
}

/** The in-progress label — one wording for the session view and the aside row. */
export const endingLabel = (pt: boolean): string => (pt ? 'Encerrando…' : 'Ending…')

export const ENDING_MIN_MS = 800

/** Keep success visible until both the reading interval and the fleet transition have finished. */
export async function withEnding<T extends { ok: boolean }>(id: string, action: () => Promise<T>, waitUntilInactive: () => Promise<void>): Promise<T> {
  const started = Date.now()
  markEnding(id)
  try {
    const result = await action()
    if (result.ok) {
      await Promise.all([
        waitUntilInactive(),
        new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ENDING_MIN_MS - (Date.now() - started)))),
      ])
      const attempt = ending.get(id)
      if (attempt) attempt.succeeded = true
    }
    return result
  } finally { unmarkEnding(id) }
}

/** Retain the selected view when a fast fleet update removes its row during the reading interval. */
export function useEndingSelection<T extends { id: string }>(route: string | undefined, row: T | undefined) {
  const held = useRef<{ route: string | undefined; row: T | undefined; attempt?: EndingAttempt }>({ route, row })
  const rowEnding = useEnding(row?.id)
  const heldEnding = useEnding(held.current.route === route ? held.current.row?.id : undefined)
  if (held.current.route !== route) held.current = { route, row }
  // Clearing request state is synchronous; navigation commits in a React transition. Keep the
  // successful attempt on THIS selection until that commit, so the chat never flashes between.
  const holding = rowEnding || heldEnding || held.current.attempt?.succeeded === true
  if (!holding) held.current = { route, row }
  else if (!held.current.attempt) {
    const id = rowEnding ? row?.id : held.current.row?.id
    if (id) held.current.attempt = ending.get(id)
  }
  return { row: holding ? held.current.row : row, ending: holding }
}
