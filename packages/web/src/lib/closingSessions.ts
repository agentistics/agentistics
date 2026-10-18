/**
 * closingSessions — the ONE pending-close state: sessions whose end/kill was accepted and that have
 * not yet left the live list. Every surface (aside row, tab, the open conversation) reads it; the
 * fleet's `act` writes it, so no call site keeps a flag of its own.
 *
 * Entries leave when the session shows as ended/gone (`reconcileClosing`), when the request fails
 * (`clearClosing`), or after `CLOSING_MAX_MS` so a lost update can never dim a row forever.
 */
import { useSyncExternalStore } from 'react'

export const CLOSING_MAX_MS = 60_000

const since = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0
const emit = () => { version++; for (const l of listeners) l() }

export function isClosing(id: string): boolean { return since.has(id) }

/** Marks `id` closing. False when it already was — the caller must then ignore the click. */
export function beginClosing(id: string, now = Date.now()): boolean {
  if (since.has(id)) return false
  since.set(id, now)
  emit()
  return true
}

export function clearClosing(id: string): void {
  if (since.delete(id)) emit()
}

/** Drops entries whose row is ended or gone, or that outlived the cap. */
export function reconcileClosing(rows: readonly { id: string; state: string }[], ended: ReadonlySet<string>, now = Date.now()): void {
  if (since.size === 0) return
  const byId = new Map(rows.map(r => [r.id, r.state]))
  let changed = false
  for (const [id, t] of since) {
    const st = byId.get(id)
    if (st === undefined || ended.has(st) || now - t > CLOSING_MAX_MS) { since.delete(id); changed = true }
  }
  if (changed) emit()
}

export function resetClosing(): void { since.clear(); emit() }

export function useIsClosing(id: string): boolean {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => since.has(id),
    () => false,
  )
}
void version
