/**
 * livePipStore — who owns the Live's external window.
 *
 * It used to be the component that opened it, and a component unmounts: the Live icon inside a session
 * sits in a popover that closes (or a route that changes) a moment after the click, and its cleanup closed
 * the window — "it shows for seconds and then closes". The window now belongs to this module and a host
 * mounted once in the app (`LivePipHost`), so no route, popover or session switch can take it down. Only
 * the person closing it (or the browser) does.
 */

import { useSyncExternalStore } from 'react'

export interface PipState { win: Window; taskIds: readonly string[] }

let state: PipState | null = null
const subs = new Set<() => void>()
const emit = () => { for (const f of subs) f() }

export const getPip = (): PipState | null => state
export const subscribePip = (fn: () => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn) } }

/** Take ownership of an opened window. A second one replaces (and closes) the first: there is one external window. */
export function registerPip(win: Window, taskIds: readonly string[]): void {
  if (state && state.win !== win) { try { state.win.close() } catch { /* already closed */ } }
  state = { win, taskIds }
  const gone = () => { if (state?.win === win) { state = null; emit() } }
  try { win.addEventListener('pagehide', gone) } catch { /* a window we cannot listen to */ }
  emit()
}

/** The person's own close (the host's `onClose`, or a button): releases the window and closes it. */
export function closePip(): void {
  const w = state?.win
  state = null
  emit()
  try { w?.close() } catch { /* already closed */ }
}

export const usePip = (): PipState | null => useSyncExternalStore(subscribePip, getPip, getPip)

/** Test seam: forget the window without closing it. */
export function resetPipForTest(): void { state = null; subs.clear() }
