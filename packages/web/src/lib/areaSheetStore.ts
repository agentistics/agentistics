import { useSyncExternalStore } from 'react'

/**
 * Whether the phone's area sheet is open. It used to be `useState` in `AppLayout`, so opening or
 * closing the sheet re-rendered the whole shell and every routed page under it (a second of work on
 * a phone, for a flag only the update card reads). A store lets just that card follow it.
 */
let open = false
const listeners = new Set<() => void>()

export function setAreaSheetOpen(next: boolean): void {
  if (open === next) return
  open = next
  listeners.forEach(l => l())
}

export function getAreaSheetOpen(): boolean { return open }

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function useAreaSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, getAreaSheetOpen, () => false)
}
