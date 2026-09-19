/**
 * artifactsStore.ts — the artifacts panel's open state and its count, shared by two components that
 * do not contain one another.
 *
 * The BUTTON lives in the unified header (`App.tsx`'s sessions strip, beside the Chat/Terminal
 * tabs); the PANEL and the list it counts live in `SessionsPage`. Neither is an ancestor of the
 * other, so the state has to sit beside them both.
 *
 * An external store rather than a context, matching `notifications.ts` — the alternative is
 * threading two values and a setter through the page shell, the strip and the panel, which is four
 * files that must agree about a boolean. Kept deliberately small: an open flag, a count, and which
 * session they describe.
 *
 * `sessionId` is on the record for a reason. The count belongs to ONE conversation, and a stale
 * count on the header of a different session is exactly the class of confident-wrong-answer this
 * codebase refuses elsewhere — so a reader that does not recognise the session shows nothing rather
 * than the last session's number.
 */

import { useSyncExternalStore } from 'react'
import { getPanelLayout, hidePanel, rightSlotShowing, showPanel } from './panelSlots'

export interface ArtifactsState {
  /** Which session the count and the open flag describe. `null` before one is selected. */
  sessionId: string | null
  open: boolean
  /** How many files that session has touched, for the header's badge. */
  count: number
  /**
   * The person closed it for THIS session.
   *
   * Kept so the panel does not open itself again while the same session keeps writing — see
   * `shouldAutoOpen`. Cleared by selecting a different session, because a decision about one
   * conversation says nothing about the next.
   */
  dismissed: boolean
  /**
   * WHICH TAB an opener asked for, and when it asked.
   *
   * The panel remembers the tab the reader last chose, which is right for the header's button —
   * you press it to go back to what you were looking at. It is wrong for the edge marker, whose
   * whole sentence is "the harness is running something": pressing that and landing on the file
   * list is an answer to a question nobody asked.
   *
   * The `at` stamp is what makes it a REQUEST rather than a setting. Without it the panel could
   * never leave the requested tab — the reader clicks Files, the prop still says `live`, and the
   * next render puts them back. Asking twice for the same tab is two requests, so the stamp changes
   * even when the tab does not.
   */
  tabRequest: { tab: string; at: number; ref?: string } | null
}

const EMPTY: ArtifactsState = {
  sessionId: null, open: false, count: 0, dismissed: false, tabRequest: null,
}

let state: ArtifactsState = EMPTY
const listeners = new Set<() => void>()

function emit(next: ArtifactsState): void {
  // Reference equality is what `useSyncExternalStore` compares, so an unchanged state must keep the
  // same object or every poll re-renders both consumers.
  if (
    next.sessionId === state.sessionId && next.open === state.open &&
    next.count === state.count && next.dismissed === state.dismissed &&
    next.tabRequest === state.tabRequest
  ) return
  state = next
  for (const l of listeners) l()
}

/** The current record. Exists for tests and for callers that read once rather than subscribe. */
export function getArtifacts(): ArtifactsState {
  return state
}

export function useArtifacts(): ArtifactsState {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => state,
    () => EMPTY,
  )
}

/** The panel's page reports which session it is showing and how many files it found. */
export function setArtifactCount(sessionId: string, count: number): void {
  emit(state.sessionId === sessionId
    ? { ...state, count }
    // A different session: the count is its own, and so is the decision to have closed the panel.
    : { sessionId, count, open: false, dismissed: false, tabRequest: null })
}

export function openArtifacts(tab?: string, ref?: string): void {
  // THE STUDIO IS NO LONGER A MODE OF THIS PANEL — see `panelSlots.ts`. This is kept as a thin
  // compatibility shim so the header button and the mobile session menu (which both still call
  // `openArtifacts('studio')`) need no second import: a request for it opens the STUDIO panel in
  // its own slot and touches nothing here. This store's `open`/`dismissed`/`tabRequest` describe the
  // CONTENTS panel alone, exactly as `contents` is its own `PanelId` in the new model.
  if (tab === 'studio') { showPanel('studio'); return }
  const show = () => emit({
    ...state, open: true,
    // `ref` names a STEP to open once the tab is there — the edge strip names an action, and
    // pressing it should land on that row rather than on the top of a feed to be searched.
    ...(tab === undefined ? {} : { tabRequest: { tab, at: Date.now(), ...(ref ? { ref } : {}) } }),
  })
  // CONTENTS AND WHATEVER ELSE HOLDS THE RIGHT SLOT SHARE IT. Opening Contents while ANY panel sits
  // there — the Studio, and now `cli`/`shell` too (C2, this defect's second showing: I2 fixed it for
  // the Studio alone and the same gap reopened the moment `cli`/`shell` could reach the slot) — must
  // DISPLACE it, asking first only when the Studio is dirty, through the very `hidePanel` that
  // already asks for a direct close — or Contents lights as "open" behind a panel the reader never
  // left: the header's button, a note chip's `openArtifacts('live', ref)`, the metrics card's
  // `openArtifacts('metrics')` and the right switcher's own "Conteúdo" tab all go through this one
  // function. `after` is what fixes the second half of that: Contents opens only once the occupant
  // has actually gone, whether that is immediate (nothing dirty) or after the reader answers
  // "discard" — never eagerly, which is what let it light up behind a Studio kept via "Continuar
  // editando". `hidePanel` only ever asks for the Studio (`panelSlots.hidePanel`'s own studio-only
  // hold) — displacing `cli`/`shell` here asks nothing, which is correct: nothing of theirs is
  // dropped by leaving the slot.
  const occupant = getPanelLayout().right
  if (occupant !== null) { hidePanel(occupant, show); return }
  show()
}

/**
 * Closing is also a DECISION not to be reopened automatically — see `ArtifactsState.dismissed`.
 *
 * IT NO LONGER ASKS ABOUT THE STUDIO. This panel used to unmount the Studio along with itself — one
 * DOM tree, one close — so a close with dirty Monaco buffers was a silent discard, and the question
 * was asked here, in the one function every close went through. The Studio is now its OWN panel
 * (`panelSlots.ts`), placed in its own slot independently of this one: closing Contents no longer
 * touches it at all, so asking about its buffers here would hold a close that drops nothing. The
 * hold moved with the buffers — `panelSlots.ts`'s `showPanel` / `hidePanel` ask before the Studio
 * itself is displaced or closed, through the very same `unsavedBuffers.ts`.
 */
export function closeArtifacts(): void {
  closeNow()
}

function closeNow(): void {
  emit({ ...state, open: false, dismissed: true })
}

/**
 * TOGGLE READS THE SAME "WHAT IS SHOWN" SELECTOR THE HEADER'S `aria-pressed` DOES (C2), not this
 * store's own `open` flag in isolation. Found live, after the displacement fix above: `state.open`
 * stays whatever it last was set to by THIS store alone, and `cli`/`shell` reaching the right slot
 * through the switcher's own tab (which calls `panelSlots.openPanel` directly, never
 * `openArtifacts`/`closeArtifacts`) does not touch it. So opening Contents, then picking `cli` from
 * the switcher, left `state.open === true` while the slot showed the terminal — and the header
 * button's NEXT press, reading only `state.open`, called `closeArtifacts()` instead of displacing
 * `cli`: the button visibly did nothing (the terminal stayed, `aria-pressed` stayed `false`, which
 * was already correct) and it took a THIRD press to actually reach Contents. `rightSlotShowing` is
 * the one place that already reconciles the slot's own occupant with this store's flag; reading it
 * here as well is what makes one press behave like Contents is either showing or it is not.
 */
export function toggleArtifacts(): void {
  if (rightSlotShowing(getPanelLayout(), state.open) === 'contents') closeArtifacts(); else openArtifacts()
}

/** For tests: forget everything. */
export function resetArtifacts(): void {
  state = EMPTY
  for (const l of listeners) l()
}
