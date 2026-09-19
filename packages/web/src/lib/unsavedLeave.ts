/**
 * unsavedLeave.ts — the pure half of asking before the Sessions page drops unsaved Studio buffers.
 *
 * `unsavedBuffers.ts` holds WHAT is unsaved and the pending question; this holds the two decisions
 * around it that are easy to get subtly wrong, and the words.
 *
 * WHY THE NAVIGATOR IS WRAPPED. The app mounts a `BrowserRouter`, not a data router, so
 * `useBlocker` is not available (it throws outside one). Every in-app navigation — a `SideNav`
 * link, the bottom nav, a `navigate()` from a menu, a session row — reaches the history object
 * through `navigator.push` / `navigator.replace`, looked up at CALL time, so wrapping those two is
 * the one place all of them pass.
 *
 * WHY `popstate` IS HEARD TOO. The browser's own Back/Forward — on a phone, the back GESTURE, which
 * is the primary way out of a screen — and `navigate(-1)` never touch `push`/`replace`: the URL has
 * already moved when anything hears about it. `createPopGuard` hears the `popstate` BEFORE the
 * router's own `handlePop`, stops it with `stopImmediatePropagation` — so the router's index never
 * moves and the page never re-renders — puts the URL back with `history.go(-delta)`, and asks.
 * Proceeding replays `history.go(delta)` and lets THAT pop through.
 *
 * "Before the router" is decided by REGISTRATION ORDER, not by the capture flag. The obvious route —
 * a capture listener on `window`, relying on capture-before-bubble at the target — was measured NOT
 * to work: in Chromium 151, `popstate` listeners on `window` run in the order they were added whatever
 * their phase (on a DOM node the capture one does go first). The router adds its listener when
 * `BrowserRouter` mounts and every page is a lazy chunk mounted after it, so a listener added by the
 * page ran second — after the router had already rendered the destination and unmounted the very
 * component holding the listener. So the listener is registered ONCE, from `main.tsx`, before the
 * first render (`historyPopGuard.ts`), and a page only ARMS it. STATED LIMITS: the delta is read from
 * the router's own `idx` in `history.state`, so an entry that carries none passes unasked; and the URL
 * bar shows the destination for the moment between the pop and the undo.
 *
 * A reload, a closed tab and an external link are the `beforeunload` half, in the guard component.
 *
 * A REOPEN OF THE OPEN SESSION IS NOT HELD (`navigationRetiresStudio`). By the time its navigation
 * exists the server has already retired the row the Studio belongs to, and the next poll removes it
 * whatever the reader answers — so a "Keep editing" there would keep nothing for about five seconds
 * and then drop the pane unasked. A control that answers falsely is worse than no control, so that
 * navigation passes; the loss belongs to the reopen verb, which is where a question could still
 * prevent it (STATED LIMIT: it does not ask today). A reopen of some OTHER row retires nothing here
 * and is held like any navigation, because staying really does keep the buffers.
 */

import type { DropCause } from './unsavedBuffers'

/**
 * Whether a navigation to `pathname` leaves the Studio MOUNTED — i.e. it is the same session's own
 * page, differing at most in query or hash (`?view=` is the Chat/Terminal switch, and changes
 * nothing about the pane). `keys` are every id the open session answers to: a row is named by its
 * managed id and by its conversation id, and a link may carry either.
 *
 * `/sessions/<id>/terminal` is NOT the same page: the dedicated terminal is an early return that
 * renders no pane at all, so going there unmounts the Studio as surely as leaving.
 */
export function navigationKeepsStudio(pathname: string, keys: readonly string[]): boolean {
  const m = /^\/sessions\/([^/]+)\/?$/.exec(pathname)
  if (m === null) return false
  let id: string
  try { id = decodeURIComponent(m[1]!) } catch { return false }
  return keys.includes(id)
}

/**
 * Whether a navigation's router STATE says it lands on a reopen of the session holding the Studio —
 * `reopenedSessionRoute` stamps `retires` with the id the reopen was asked about. Such a navigation is
 * never held: see this module's header.
 */
export function navigationRetiresStudio(state: unknown, keys: readonly string[]): boolean {
  if (typeof state !== 'object' || state === null) return false
  const retires = (state as { retires?: unknown }).retires
  return typeof retires === 'string' && retires !== '' && keys.includes(retires)
}

/** The pathname a `navigator.push`/`replace` target names — a resolved path object or a string. */
export function pathnameOf(to: unknown, current: string): string {
  if (typeof to === 'string') {
    const cut = to.split(/[?#]/)[0]!
    return cut === '' ? current : cut
  }
  if (typeof to === 'object' && to !== null && typeof (to as { pathname?: unknown }).pathname === 'string') {
    const p = (to as { pathname: string }).pathname
    return p === '' ? current : p
  }
  return current
}

export interface GuardableNavigator {
  push: (...args: never[]) => void
  replace: (...args: never[]) => void
}

/**
 * Wraps `push` and `replace` so a navigation `hold` claims is handed to `onHold` with a function
 * that performs it later through the ORIGINAL method — so proceeding can never be held a second
 * time by its own guard. `restore` puts the originals back, and only if nothing has wrapped the
 * navigator again since (a restore that clobbered a newer wrapper would silently disarm it).
 */
export function guardNavigator(
  nav: GuardableNavigator,
  /** `to` and the router `state` it was pushed with (`navigator.push(to, state, opts)`). */
  hold: (to: unknown, state: unknown) => boolean,
  onHold: (proceed: () => void) => boolean,
): () => void {
  const originals = { push: nav.push, replace: nav.replace }
  const wrap = (method: 'push' | 'replace') => (...args: never[]) => {
    const original = originals[method]
    const run = () => { original.apply(nav, args) }
    // `onHold` answers whether it really held (nothing unsaved means it did not), so a guard that is
    // armed a render late can never swallow a navigation.
    if (hold(args[0], args[1]) && onHold(run)) return
    run()
  }
  const wrapped = { push: wrap('push'), replace: wrap('replace') }
  nav.push = wrapped.push
  nav.replace = wrapped.replace
  return () => {
    if (nav.push === wrapped.push) nav.push = originals.push
    if (nav.replace === wrapped.replace) nav.replace = originals.replace
  }
}

/** The router's own position in the session history (`createBrowserHistory` writes `idx`). */
export function historyIndexOf(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) return null
  const idx = (state as { idx?: unknown }).idx
  return typeof idx === 'number' && Number.isInteger(idx) ? idx : null
}

export interface PopEventLike {
  state: unknown
  stopImmediatePropagation: () => void
}

export interface PoppableWindow {
  addEventListener: (type: 'popstate', listener: (e: PopEventLike) => void, capture: boolean) => void
  removeEventListener: (type: 'popstate', listener: (e: PopEventLike) => void, capture: boolean) => void
  history: { go: (delta: number) => void }
  location: { pathname: string }
}

/** One page's use of the pop guard: which entry is on screen, what to hold, and how to ask. */
export interface PopGuardArming {
  /** The router index of the entry the page is SHOWING — never `history.state`, which by pop time
   *  already names the destination. */
  lastIndex: () => number | null
  hold: (pathname: string) => boolean
  /** Answers whether it really held, as for `guardNavigator`, so nothing is stopped while nothing
   *  is unsaved. */
  onHold: (proceed: () => void) => boolean
}

export interface PopGuard {
  /** Registers the ONE `popstate` listener. Must run before the router adds its own. */
  listen: () => () => void
  /** Arms the listener for one page; the returned disarm is a no-op once a newer arming took over. */
  arm: (arming: PopGuardArming) => () => void
}

/**
 * Holds a Back/Forward (or `navigate(-1)`) the armed page claims, the way `guardNavigator` holds a
 * push. Two pops are its own and never reach a decision: the UNDO (swallowed, even if the page that
 * caused it has disarmed since) and the REPLAY after "leave anyway" (let through, and the router then
 * computes the same delta from its own unmoved index).
 *
 * BOTH ARE MATCHED BY THE INDEX THEY EXPECT TO LAND ON, NEVER BY "THE NEXT POP". Two navigations
 * close together (an undo's own popstate has not fired yet when an unrelated one pops) would
 * otherwise have the second, real pop consumed as if it were the first's undo — the reader's own
 * Back doing nothing, silently, with no ask. `undoingTo` / `replayingTo` record the ONE index each
 * expects; a pop landing anywhere else is a genuinely new navigation and is re-evaluated, never
 * swallowed.
 */
export function createPopGuard(win: PoppableWindow): PopGuard {
  let armed: PopGuardArming | null = null
  let undoingTo: number | null = null
  let replayingTo: number | null = null
  const onPop = (e: PopEventLike) => {
    const to = historyIndexOf(e.state)
    if (undoingTo !== null) {
      if (to === undoingTo) { undoingTo = null; e.stopImmediatePropagation(); return }
      undoingTo = null
    }
    if (replayingTo !== null) {
      if (to === replayingTo) { replayingTo = null; return }
      replayingTo = null
    }
    const page = armed
    if (page === null) return
    const from = page.lastIndex()
    if (from === null || to === null || from === to) return
    if (!page.hold(win.location.pathname)) return
    const delta = to - from
    if (!page.onHold(() => { replayingTo = to; win.history.go(delta) })) return
    e.stopImmediatePropagation()
    undoingTo = from
    win.history.go(-delta)
  }
  return {
    listen: () => {
      win.addEventListener('popstate', onPop, true)
      return () => win.removeEventListener('popstate', onPop, true)
    },
    arm: arming => {
      const mine = { ...arming }
      armed = mine
      return () => { if (armed === mine) armed = null }
    },
  }
}

export interface UnsavedLeaveText {
  title: string
  message: string
  confirm: string
  cancel: string
}

/**
 * The question, for N files. Same shape and the same "keep editing" as the Studio's own one-tab
 * question (`Studio.tsx`), raised for the panel. The files are NAMED (up to three, then a count): a
 * reader who has forgotten which buffer is dirty cannot decide whether it matters from a number.
 */
export function unsavedLeaveText(
  files: readonly string[], cause: DropCause, lang: 'pt' | 'en',
): UnsavedLeaveText {
  const n = files.length
  const shown = files.slice(0, 3).map(f => f.split('/').pop() || f)
  const more = n > shown.length ? (lang === 'pt' ? ` e mais ${n - shown.length}` : ` and ${n - shown.length} more`)
    : ''
  const names = `${shown.join(', ')}${more}`
  if (lang === 'pt') {
    const what = n === 1
      ? `1 arquivo no Studio tem mudanças que não foram salvas (${names}).`
      : `${n} arquivos no Studio têm mudanças que não foram salvas (${names}).`
    return {
      title: 'Descartar mudanças não salvas?',
      message: cause === 'close'
        ? `${what} Fechar o painel descarta o que ainda não foi salvo.`
        : `${what} Sair desta sessão descarta o que ainda não foi salvo.`,
      confirm: cause === 'close' ? 'Fechar mesmo assim' : 'Sair mesmo assim',
      cancel: 'Continuar editando',
    }
  }
  const what = n === 1
    ? `1 file in the Studio has changes that have not been saved (${names}).`
    : `${n} files in the Studio have changes that have not been saved (${names}).`
  return {
    title: 'Discard unsaved changes?',
    message: cause === 'close'
      ? `${what} Closing the panel discards what has not been saved.`
      : `${what} Leaving this session discards what has not been saved.`,
    confirm: cause === 'close' ? 'Close anyway' : 'Leave anyway',
    cancel: 'Keep editing',
  }
}
