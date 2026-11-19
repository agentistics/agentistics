/**
 * browserDrawer.ts — whether the phone's full-screen browser (the person's own, prototype `b1-open-390`) is
 * open. A tiny store because it has two doors: the globe+search button in the session header and the
 * "Navegador" entry of the `MobileAreaBar` sheet (the only way in outside /sessions). One state, one drawer
 * mounted at the app root; the desktop never reads it (its browser is a rail panel).
 */
import { useSyncExternalStore } from 'react'

let open = false
const subs = new Set<() => void>()
const emit = () => { for (const s of subs) s() }

export function setBrowserDrawerOpen(v: boolean): void {
  if (open === v) return
  open = v
  emit()
}
export const getBrowserDrawerOpen = (): boolean => open
export function subscribeBrowserDrawer(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
export function useBrowserDrawerOpen(): boolean {
  return useSyncExternalStore(subscribeBrowserDrawer, getBrowserDrawerOpen, () => false)
}
