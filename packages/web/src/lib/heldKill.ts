/**
 * heldKill.ts — an "End anyway?" question whose asker is gone.
 *
 * Ending a session something live is using is refused once, and the refusal is a QUESTION that the
 * row menu's own dialog asks. On a phone the menu lives inside the drawer, and pressing End marks the
 * session as ending, which closes the drawer — unmounting the menu before the refusal arrives, so the
 * dialog never opened and the way to end it on purpose was unreachable. A menu that finds itself
 * unmounted when the refusal lands hands the question here, and one always-mounted host asks it.
 * Transient request state: in memory, never persisted.
 */
import { useSyncExternalStore } from 'react'

export interface HeldKill { id: string; message: string }

let current: HeldKill | null = null
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function offerHeldKill(held: HeldKill): void { current = held; emit() }
export function clearHeldKill(): void { if (current !== null) { current = null; emit() } }
export function peekHeldKill(): HeldKill | null { return current }
export function useHeldKill(): HeldKill | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}
