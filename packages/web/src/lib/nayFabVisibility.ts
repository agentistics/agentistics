/**
 * nayFabVisibility.ts — whether the floating Nay button shows INSIDE a session on a phone.
 *
 * On a phone the button sat on top of the session's composer and covered its send button (owner,
 * 2026-09-29). So inside a session it is HIDDEN by default there, and the session header's ⋯ menu
 * carries "Show floating chat" to bring it back. Desktop is unaffected: this value is only ever
 * read on a phone.
 *
 * A tiny external store (the `useSyncExternalStore` shape `notifications.ts` uses) because the
 * toggle lives in the session page's menu while the button lives in the app-wide dock, and neither
 * is inside the other. Per viewer, in `localStorage`, every access guarded: a private window makes
 * the accessor itself throw, and the answer is then the default.
 */

import { useSyncExternalStore } from 'react'

const KEY = 'agentistics-nay-fab-in-session-mobile'
const listeners = new Set<() => void>()

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

let current = typeof window === 'undefined' ? false : read()

export function nayFabShownInSession(): boolean {
  return current
}

export function setNayFabShownInSession(shown: boolean): void {
  current = shown
  try { localStorage.setItem(KEY, shown ? '1' : '0') } catch { /* a convenience, never required */ }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function useNayFabShownInSession(): boolean {
  return useSyncExternalStore(subscribe, nayFabShownInSession, () => false)
}

/** Pure: does the floating button render here? Only a phone inside a session can hide it. */
export function nayFabVisible(opts: { isMobile: boolean; inSession: boolean; shownInSession: boolean }): boolean {
  return !opts.isMobile || !opts.inSession || opts.shownInSession
}
