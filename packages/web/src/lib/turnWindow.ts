/**
 * turnWindow.ts — how much of a long conversation the chat RENDERS (PERF.1 step 3).
 *
 * A live session carries up to 400 turns, each a markdown bubble; rendering all of them before the
 * first paint is what made opening a long session slow. The view renders the last `INITIAL_TURNS`
 * first and grows by `GROW_TURNS` when the reader scrolls near the top. A jump to a turn outside the
 * window (a quote card) widens it to include that turn first, so no jump ever lands on nothing.
 */
export const INITIAL_TURNS = 60
export const GROW_TURNS = 60
/** Within this many pixels of the top, the next block of older turns is rendered. */
export const GROW_AT_PX = 600

/** The index of the first rendered turn. */
export function windowStart(total: number, shown: number): number {
  return Math.max(0, total - Math.max(0, shown))
}

/** How many to show so that turn `index` is rendered, with a few turns of context above it. */
export function shownToInclude(total: number, index: number, context = 10): number {
  return Math.max(0, total - Math.max(0, index - context))
}
