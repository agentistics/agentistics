/**
 * sessionTabsStore.ts — which sessions are open as tabs on THIS screen.
 *
 * Per BROWSER on purpose (`localStorage`): the set of conversations on a screen is a fact about the
 * screen, not about the work — a phone and a desktop should not fight over it (the line
 * `sharedPref.ts` draws). Pins, which ARE about the work, stay in `pinnedSessions.ts`.
 *
 * One list PER PANE (`paneScope.ts`): the main pane keeps the bare key, the split pane `…:split`.
 * Every read and write is guarded — a private window or blocked storage throws — and a corrupt
 * value reads as no tabs.
 */
import { useSyncExternalStore } from 'react'
import { paneStorageKey, usePaneId, type PaneId } from './paneScope'
import { parseTabs } from './sessionTabs'

export const SESSION_TABS_KEY = 'agentistics-session-tabs'

const listeners = new Set<() => void>()
const cache = new Map<string, string[]>()
const EMPTY: string[] = []

function read(pane: PaneId): string[] {
  const key = paneStorageKey(SESSION_TABS_KEY, pane)
  const hit = cache.get(key)
  if (hit) return hit
  let list: string[] = EMPTY
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) list = parseTabs(JSON.parse(raw))
  } catch { list = EMPTY }
  cache.set(key, list)
  return list
}

export function getOpenTabs(pane: PaneId = 'main'): string[] {
  return read(pane)
}

export function setOpenTabs(pane: PaneId, next: readonly string[]): void {
  const cur = read(pane)
  if (cur.length === next.length && cur.every((x, i) => x === next[i])) return
  const list = [...next]
  cache.set(paneStorageKey(SESSION_TABS_KEY, pane), list)
  try { localStorage.setItem(paneStorageKey(SESSION_TABS_KEY, pane), JSON.stringify(list)) } catch { /* a convenience */ }
  for (const l of listeners) l()
}

/** Read-modify-write against the CURRENT list, so two effects in one commit cannot clobber each other. */
export function updateOpenTabs(pane: PaneId, fn: (cur: string[]) => readonly string[]): void {
  setOpenTabs(pane, fn(read(pane)))
}

export function subscribeOpenTabs(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** The open tabs of the pane this component is rendered in. */
export function useOpenTabs(): string[] {
  const pane = usePaneId()
  return useSyncExternalStore(subscribeOpenTabs, () => read(pane), () => EMPTY)
}

/** For tests: forget the in-memory copy so the next read goes to storage again. */
export function resetOpenTabsCache(): void {
  cache.clear()
}
