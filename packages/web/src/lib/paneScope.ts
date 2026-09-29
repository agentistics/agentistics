/**
 * paneScope.ts — WHICH SIDE of the split view a piece of the sessions workspace belongs to.
 *
 * The workspace shows one session, or two side by side (desktop only). Each side carries the FULL
 * per-session layout — its own chat, artifacts rail, bottom band and floating windows — so every
 * store that used to assume "the one open session" (`panelSlots`, `floatingPanels`,
 * `artifactsStore`'s focus request, the shell band's prefs) keeps one state PER PANE.
 *
 * Two ways a store learns the pane:
 * - **a hook reads it from context** (`usePaneId`). Everything rendered inside a pane is wrapped
 *   in `<PaneScope pane=…>`, and outside any split this is `'main'`, which is exactly today.
 * - **an imperative call made outside React** (a keyboard shortcut, `openArtifacts` from a chat
 *   note, the Studio's search request) takes the ACTIVE pane — the one the person last pressed or
 *   focused in. Each pane marks itself active in the CAPTURE phase of its own pointer, focus and
 *   key events, so the mark is set before any handler inside it runs.
 */

import { createContext, createElement, useContext, type ReactNode } from 'react'

export type PaneId = 'main' | 'split'
export const PANE_IDS: readonly PaneId[] = ['main', 'split']

const PaneContext = createContext<PaneId>('main')

export function PaneScope({ pane, children }: { pane: PaneId; children: ReactNode }) {
  return createElement(PaneContext.Provider, { value: pane }, children)
}

/** The pane this component is rendered in — `'main'` outside any split. */
export function usePaneId(): PaneId {
  return useContext(PaneContext)
}

let active: PaneId = 'main'
const activeListeners = new Set<() => void>()

/** The pane the person is working in right now. */
export function getActivePane(): PaneId {
  return active
}

export function setActivePane(pane: PaneId): void {
  if (pane === active) return
  active = pane
  for (const l of activeListeners) l()
}

export function subscribeActivePane(cb: () => void): () => void {
  activeListeners.add(cb)
  return () => { activeListeners.delete(cb) }
}

/**
 * A storage key for a pane. The MAIN pane keeps the historical key untouched, so a browser that
 * never opens a split reads and writes exactly what it always has.
 */
export function paneStorageKey(base: string, pane: PaneId): string {
  return pane === 'main' ? base : `${base}:${pane}`
}

/**
 * A DOM id for a pane — the workspace looks some of its gaps up by id, and two panes must not
 * share one. The main pane keeps the historical id.
 */
export function paneDomId(base: string, pane: PaneId): string {
  return pane === 'main' ? base : `${base}-${pane}`
}

/** For tests. */
export function resetActivePane(): void {
  active = 'main'
}
