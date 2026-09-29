/**
 * splitRoute.ts — PURE: the split view's place in the URL.
 *
 * The sessions workspace shows one session, or two side by side (desktop only, never more). The
 * MAIN session is the route's own `/sessions/:id`; the second one is `?split=<id>`, so a reload, a
 * bookmark or the back button keeps the arrangement, and every existing link to `/sessions/:id`
 * still means exactly what it meant. The split pane's chat/terminal choice is `?splitView=`,
 * beside the main pane's own `?view=`.
 *
 * Every decision about WHICH pane a gesture lands in is here, so the list, the pane headers and the
 * reopen/close paths cannot disagree about it.
 */

import type { PaneId } from './paneScope'

export const SPLIT_PARAM = 'split'
export const SPLIT_VIEW_PARAM = 'splitView'

/** The session open in the split pane, or null. Never the same as the main one. */
export function splitIdOf(search: URLSearchParams, mainId: string | undefined): string | null {
  const id = search.get(SPLIT_PARAM)?.trim() ?? ''
  if (!id || id === mainId) return null
  return id
}

/** A copy of `search` with the split pane set to `id` (or removed, for null). Its view goes with it. */
export function withSplit(search: URLSearchParams, id: string | null): URLSearchParams {
  const next = new URLSearchParams(search)
  if (id === null) {
    next.delete(SPLIT_PARAM)
    next.delete(SPLIT_VIEW_PARAM)
  } else if (next.get(SPLIT_PARAM) !== id) {
    next.set(SPLIT_PARAM, id)
    next.delete(SPLIT_VIEW_PARAM)
  }
  return next
}

export interface SplitRoute {
  /** The main session — the path's `:id` — or null for the bare `/sessions`. */
  main: string | null
  split: string | null
  /** The split pane's own view, carried over when its session does not change. */
  splitView: string | null
}

export function readSplitRoute(mainId: string | undefined, search: URLSearchParams): SplitRoute {
  const split = mainId ? splitIdOf(search, mainId) : null
  return { main: mainId ?? null, split, splitView: split ? search.get(SPLIT_VIEW_PARAM) : null }
}

/** A route as a `navigate()` target: the path plus the search string that carries the split. */
export function splitHref(route: SplitRoute, search: URLSearchParams): string {
  if (route.main === null) return '/sessions'
  let next = withSplit(search, route.split)
  if (route.split !== null && route.splitView) next.set(SPLIT_VIEW_PARAM, route.splitView)
  if (route.split === null) next = withSplit(next, null)
  const qs = next.toString()
  return `/sessions/${encodeURIComponent(route.main)}${qs ? `?${qs}` : ''}`
}

/**
 * OPEN a session from the list. It goes into the pane the person is working in: with a split open
 * and the split pane active, it replaces the right side; otherwise the main one. A session already
 * on screen is not opened twice — the route is left as it is.
 */
export function openInPane(route: SplitRoute, id: string, active: PaneId): SplitRoute {
  if (id === route.main || id === route.split) return route
  if (route.split !== null && active === 'split') return { ...route, split: id, splitView: null }
  return { ...route, main: id }
}

/**
 * OPEN BESIDE: put `id` in the split pane. With nothing open yet it simply becomes the main session;
 * asking for the one already in the main pane changes nothing (the two sides are never the same).
 */
export function openBeside(route: SplitRoute, id: string): SplitRoute {
  if (route.main === null) return { main: id, split: null, splitView: null }
  if (id === route.main) return route
  return { ...route, split: id, splitView: null }
}

/**
 * CLOSE one pane. Closing the split pane leaves the main one; closing the MAIN pane while a split is
 * open promotes the split session to main (its view comes with it), so the reader keeps looking at
 * the session they did not close.
 */
export function closePane(route: SplitRoute, pane: PaneId): SplitRoute {
  if (pane === 'split') return { ...route, split: null, splitView: null }
  if (route.split !== null) return { main: route.split, split: null, splitView: null }
  return { main: null, split: null, splitView: null }
}

/** A pane's session was REOPENED under a new id: that pane follows it; the other is untouched. */
export function replaceInPane(route: SplitRoute, pane: PaneId, id: string): SplitRoute {
  if (pane === 'split') return id === route.main ? { ...route, split: null, splitView: null } : { ...route, split: id }
  if (id === route.split) return { main: id, split: null, splitView: null }
  return { ...route, main: id }
}
