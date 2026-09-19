/**
 * UnsavedChangesGuard — the question the Sessions page asks before it drops the Studio's unsaved
 * buffers, at the level where they are dropped.
 *
 * `SessionsPage` renders this beside the artifacts pane. It does three things, all conditional on
 * `unsavedBuffers.ts` reporting at least one dirty file (so a clean Studio costs nothing and asks
 * nothing):
 *
 *  1. Draws the pending question — raised by the panel's close (`artifactsStore.closeArtifacts`) or
 *     by a navigation held in (2) — in the same `ConfirmModal` the Studio uses for one tab.
 *  2. Wraps the router's navigator (`unsavedLeave.ts`'s `guardNavigator`) so a navigation that
 *     would unmount the pane — another session, the dedicated terminal, any other screen through
 *     `SideNav` or the bottom nav — is HELD until the reader answers. A navigation that keeps this
 *     session's page (a `?view=` switch) passes untouched, and so does a reopen of THIS session,
 *     whose row the server has already retired (`navigationRetiresStudio`).
 *  3. Arms the app's one `popstate` guard (`lib/historyPopGuard.ts`, registered by `main.tsx` before
 *     the router's listener) so the browser's own Back/Forward — the back gesture on a phone — is
 *     held the same way.
 *  4. Registers `beforeunload` for a reload, a closed tab or an external link — the pattern
 *     `pages/settings/Drawer.tsx` already uses.
 *
 * It never keeps a closed panel mounted: the answer "discard" drops the pane exactly as before.
 */

import { useContext, useEffect, useRef } from 'react'
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from 'react-router-dom'
import { ConfirmModal } from '../../pages/settings/primitives'
import { answerUnsaved, holdIfUnsaved, useUnsaved } from '../../lib/unsavedBuffers'
import {
  guardNavigator, historyIndexOf, navigationKeepsStudio, navigationRetiresStudio, pathnameOf,
  unsavedLeaveText, type GuardableNavigator,
} from '../../lib/unsavedLeave'
import { armHistoryPopGuard } from '../../lib/historyPopGuard'

export interface UnsavedChangesGuardProps {
  lang: 'pt' | 'en'
  /** Every id the open session answers to; empty when no session is open. */
  sessionKeys: readonly string[]
}

export function UnsavedChangesGuard({ lang, sessionKeys }: UnsavedChangesGuardProps) {
  const unsaved = useUnsaved()
  const dirty = unsaved.files.length > 0
  const navigation = useContext(UNSAFE_NavigationContext)
  const navigator = navigation?.navigator as unknown as GuardableNavigator | undefined

  // Read at CALL time, so a session switch that did not remount this component is judged against
  // the session now on screen rather than the one it was armed with.
  const keys = useRef(sessionKeys)
  keys.current = sessionKeys

  useEffect(() => {
    if (!navigator || typeof navigator.push !== 'function' || typeof navigator.replace !== 'function') return
    return guardNavigator(
      navigator,
      (to, state) => !navigationKeepsStudio(pathnameOf(to, window.location.pathname), keys.current)
        && !navigationRetiresStudio(state, keys.current),
      run => holdIfUnsaved('leave', run),
    )
  }, [navigator])

  // The index of the entry on SCREEN, refreshed after every navigation the router renders. A pop
  // cannot read it from `history.state`, which by then already names the destination.
  const location = useContext(UNSAFE_LocationContext)?.location
  const shownIndex = useRef<number | null>(null)
  useEffect(() => {
    shownIndex.current = historyIndexOf(window.history.state)
  }, [location?.key])

  const routed = location !== undefined
  useEffect(() => {
    if (!routed) return
    return armHistoryPopGuard({
      lastIndex: () => shownIndex.current,
      hold: pathname => !navigationKeepsStudio(pathname, keys.current),
      onHold: run => holdIfUnsaved('leave', run),
    })
  }, [routed])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  return <UnsavedLeaveQuestion files={unsaved.files} question={unsaved.question} lang={lang} />
}

/** The modal alone, as a function of the store's state — rendered to markup by its test. */
export function UnsavedLeaveQuestion({ files, question, lang }: {
  files: readonly string[]
  question: { cause: 'close' | 'leave' } | null
  lang: 'pt' | 'en'
}) {
  const open = question !== null && files.length > 0
  const text = unsavedLeaveText(files, question?.cause ?? 'close', lang)
  return (
    <ConfirmModal
      open={open}
      title={text.title}
      message={text.message}
      confirmLabel={text.confirm}
      cancelLabel={text.cancel}
      onConfirm={() => answerUnsaved(true)}
      onCancel={() => answerUnsaved(false)}
    />
  )
}
