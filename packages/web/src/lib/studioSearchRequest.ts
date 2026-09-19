/**
 * studioSearchRequest.ts — the signal that switches the mounted Studio to its whole-tree content
 * search (UX pass item 8), plus `runStudioShortcut`, which both new global shortcuts (item 8's
 * search and item 11's toggle) actually run once `lib/studioShortcuts.ts` has said which of them a
 * keystroke names.
 *
 * AN EXTERNAL STORE, not a prop: the Studio is mounted ONCE per session by `StudioHost` and
 * portaled into whichever slot currently shows it (`lib/panelSlots.ts`), while the two callers that
 * need to reach it — the global `document`-level listener (App.tsx) and each Monaco instance's own
 * registered command (`RepoFileEditor.tsx`) — are nowhere near it in the React tree. `tabRequest` on
 * `artifactsStore.ts` is the same shape for the same reason.
 */

import { useSyncExternalStore } from 'react'
import { getPanelLayout, hidePanel, isPanelShown, showPanel } from './panelSlots'
import type { StudioShortcutId } from './studioShortcuts'

let seq = 0
const listeners = new Set<() => void>()

/** The current request's own stamp — `0` means "none yet", and every real request is a NEW,
 *  strictly increasing number, so asking twice for search (already open, already on that view) is
 *  still a request the subscriber can act on rather than a no-op state that never re-fires. */
export function getStudioSearchRequest(): number {
  return seq
}

export function requestStudioSearch(): void {
  seq += 1
  for (const l of listeners) l()
}

export function subscribeStudioSearchRequest(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function useStudioSearchRequest(): number {
  return useSyncExternalStore(subscribeStudioSearchRequest, getStudioSearchRequest, () => 0)
}

/** For tests. */
export function resetStudioSearchRequest(): void {
  seq = 0
  for (const l of listeners) l()
}

/**
 * WHAT EACH SHORTCUT ACTUALLY DOES, once matched.
 *
 * `toggle` (item 11): closed anywhere → open in its last slot; open anywhere → close, asking first
 * when a buffer is dirty — `hidePanel`'s own hold, the same one every other close in this feature
 * goes through, so this shortcut asks no differently than the header switcher or the aside's close
 * button do. `search` (item 8): opens the Studio if it was not already shown (in its LAST slot —
 * `showPanel` with no explicit slot, exactly what the header switcher's own Studio tab does) and
 * then asks it to switch to search — `requestStudioSearch` fires regardless of whether the Studio
 * had to be opened, so pressing it a second time while already open and already searching is still
 * a request the mounted view can act on (moving focus back to the query field, say).
 */
export function runStudioShortcut(id: StudioShortcutId): void {
  if (id === 'toggle') {
    if (isPanelShown(getPanelLayout(), 'studio')) hidePanel('studio')
    else showPanel('studio')
    return
  }
  if (!isPanelShown(getPanelLayout(), 'studio')) showPanel('studio')
  requestStudioSearch()
}
