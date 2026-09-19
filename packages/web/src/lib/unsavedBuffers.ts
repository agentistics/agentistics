/**
 * unsavedBuffers.ts — which Studio buffers hold typing that exists nowhere else, and the ONE
 * question asked before anything drops them.
 *
 * WHY THIS EXISTS. The Studio keeps its Monaco buffers mounted through every gesture INSIDE the
 * artifacts panel (switching tabs, back to the tree, leaving the Studio for the aside), and asks
 * before closing ONE dirty tab. None of that reached the level that actually unmounts it:
 * `SessionsPage` drops the whole pane when the panel closes (`artShell === 'none'`), when the page
 * navigates to another session or another screen, and on a phone while a new session is arriving.
 * Autosave is OFF by default, so: type three lines, press Contents, press the panel's close — and
 * 260 ms later the text was gone, with no prompt, from a panel whose own header says leaving the
 * Studio changes nothing. Closing one tab asked; closing the panel holding N asked nothing.
 *
 * So the Studio REPORTS its dirty paths here, and every way the page drops the pane goes through
 * `holdIfUnsaved` first: the panel's close (`artifactsStore.closeArtifacts`) and every router
 * navigation (`unsavedLeave.ts`'s `guardNavigator`). Holding is not keeping — the pane is still
 * unmounted the moment the reader says so; nothing here keeps a closed panel alive, which a previous
 * change deliberately stopped doing on a phone.
 *
 * An external store rather than a context, for the reason `artifactsStore.ts` gives: the reporter
 * (the Studio, deep inside `ArtifactsAside`) and the askers (the store's close, the router guard, the
 * page's modal) do not contain one another.
 *
 * ONE PENDING QUESTION, AND ITS ANSWER DOES WHAT IT WAS ASKED ABOUT. A second drop asked while one
 * is pending is HELD AND FORGOTTEN — it neither replaces what proceeding does nor re-renders. It used
 * to replace it, so a second navigation while the modal was up silently re-pointed "Leave anyway" at a
 * destination the reader never chose (and a navigation under a pending CLOSE turned "Close anyway"
 * into a leave). Not re-rendering still matters: an effect that navigates on every render would
 * otherwise loop against the modal it opened.
 */

import { useSyncExternalStore } from 'react'

/** What is about to drop the buffers — decides only the wording of the question. */
export type DropCause = 'close' | 'leave'

export interface UnsavedState {
  /** Every dirty path, across whatever reported them. Empty is "nothing can be lost". */
  files: readonly string[]
  /** The drop that is being held, until the reader answers. */
  question: { cause: DropCause } | null
}

const EMPTY: UnsavedState = { files: [], question: null }

let state: UnsavedState = EMPTY
/** Per reporter, so a Studio unmounting cannot clear what its successor has just reported. */
const byOwner = new Map<string, readonly string[]>()
/** Kept out of `state`: a function in a snapshot would make every held drop a new object. */
let proceed: (() => void) | null = null
const listeners = new Set<() => void>()

function emit(next: UnsavedState): void {
  if (next.files === state.files && next.question === state.question) return
  state = next
  for (const l of listeners) l()
}

function recount(): void {
  const files = [...byOwner.values()].flat()
  const same = files.length === state.files.length && files.every((f, i) => f === state.files[i])
  // Nothing left to lose while a drop was being held: the reader's answer no longer matters (an
  // autosave landed, the buffer was saved by hand), so the drop they asked for simply happens.
  if (files.length === 0 && state.question !== null) {
    const go = proceed
    proceed = null
    emit({ files: same ? state.files : files, question: null })
    go?.()
    return
  }
  if (!same) emit({ ...state, files })
}

export function reportUnsaved(owner: string, paths: readonly string[]): void {
  if (paths.length === 0) byOwner.delete(owner)
  else byOwner.set(owner, [...paths])
  recount()
}

export function clearUnsaved(owner: string): void {
  byOwner.delete(owner)
  recount()
}

export function getUnsaved(): UnsavedState {
  return state
}

export function useUnsaved(): UnsavedState {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => state,
    () => EMPTY,
  )
}

/**
 * The gate every drop goes through. `false` means nothing is unsaved and the caller drops at once;
 * `true` means the drop is HELD and `proceed` runs only if the reader chooses to discard.
 */
export function holdIfUnsaved(cause: DropCause, run: () => void): boolean {
  if (state.files.length === 0) return false
  if (state.question !== null) return true
  proceed = run
  emit({ ...state, question: { cause } })
  return true
}

/** The reader's answer. Discarding runs the held drop; keeping forgets it. */
export function answerUnsaved(discard: boolean): void {
  const go = proceed
  proceed = null
  emit({ ...state, question: null })
  if (discard) go?.()
}

/** For tests: forget everything. */
export function resetUnsaved(): void {
  byOwner.clear()
  proceed = null
  state = EMPTY
  for (const l of listeners) l()
}
