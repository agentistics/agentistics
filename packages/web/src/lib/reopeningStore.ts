/**
 * reopeningStore.ts — which session rows are being REOPENED right now.
 *
 * A reopen takes seconds (the old process is ended, the new one is spawned and must settle) and
 * mints a new id, so a button pressed on one surface left every other surface — the aside row, the
 * chat's composer, the picker — looking idle while it ran. Reported as "I click reopen and it just
 * freezes". The set is keyed by the id the reopen was asked ABOUT, and a surface clears it when the
 * request settles; `withReopening` is that pairing, so a caller cannot forget the clear.
 *
 * In-memory, same shape as `pendingSessionStore.ts`: a reload has nothing left to be reopening.
 */
import { useSyncExternalStore } from 'react'

let ids: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

function set(next: ReadonlySet<string>): void { ids = next; emit() }

export function markReopening(...add: string[]): void {
  const next = new Set(ids)
  for (const id of add) if (id) next.add(id)
  set(next)
}
export function clearReopening(...rm: string[]): void {
  const next = new Set(ids)
  for (const id of rm) next.delete(id)
  set(next)
}

/** Run `fn` with `targets` marked as reopening, and clear them however it ends. */
export async function withReopening<T>(targets: readonly string[], fn: () => Promise<T>): Promise<T> {
  markReopening(...targets)
  try { return await fn() } finally { clearReopening(...targets) }
}

export const getReopening = (): ReadonlySet<string> => ids
export function useReopening(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getReopening, getReopening)
}

/** The in-progress label — one wording for every surface. */
export const reopeningLabel = (pt: boolean): string => (pt ? 'Reabrindo…' : 'Reopening…')
