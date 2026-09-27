/**
 * sessionCellPlan.ts — which sessions a subtask's sessions cell shows, and what its `⋯` menu may
 * offer for them, computed once and read by `SubtaskSessions` instead of re-derived inline.
 *
 * Pulled out for the same reason `subtaskActionsPlan.ts` exists beside `SubtaskActionsMenu`: the
 * cell holds popover state (hooks), which cannot be exercised outside an actual React render (this
 * repo has no React-rendering test harness — see `SubtaskActionsMenu`'s own plan). The FILTERING and
 * the MENU'S OFFERS are ordinary data decisions with no state of their own, so they live here where
 * `bun test` can assert them directly, and the component only ever renders what this plan already
 * decided.
 *
 * Three rules the plan encodes:
 *
 *  - **Exactly one filed session names an OPEN and UNLINK target directly** — no picker needed.
 *    **Zero or several never offer OPEN at all**: with none there is nothing to open, and with
 *    several "open" would be ambiguous — the compact list `SubtaskSessions` draws instead is where
 *    each one opens from, a separate control from this menu.
 *  - **A HISTORICAL link (a conversation with no session behind it) is never offered as `open`**,
 *    the same guard `SessionRef` already applies to its own chip — a menu row that opens a page that
 *    does not exist is the dead control this product refuses everywhere.
 *  - **`link` is always offered**, worded by whether anything is filed yet ("link a session" against
 *    "add another") — that wording lives in `SubtaskSessions` (it is per-language copy, not a plan
 *    decision), this only says which of the two applies.
 */

import type { TaskSessionRow } from '../../lib/tasks'

export type SessionCellDisplay =
  | { kind: 'empty' }
  | { kind: 'single'; session: TaskSessionRow }
  | { kind: 'multi' }

export type SessionCellUnlink =
  | { kind: 'none' }
  | { kind: 'one'; session: TaskSessionRow }
  | { kind: 'pick' }

export interface SessionCellPlan {
  /** The sessions filed here, in the order they arrived — never a union beyond `subtaskIds`. */
  sessions: readonly TaskSessionRow[]
  /** What the CHIP area draws: nothing, one chip, or the compact "N sessions" control. */
  display: SessionCellDisplay
  /** Whether the menu's file-a-session row reads as a first link or an additional one. */
  link: 'link' | 'another'
  /** The session the menu's "Open session" row targets, or `null` when that row is withheld
   *  (nothing filed, several filed, no `onOpen` wired, or the one filed link is historical). */
  open: TaskSessionRow | null
  /** The menu's "Unlink session" row: nothing to act on, one direct target, or a picker over
   *  `sessions`. */
  unlink: SessionCellUnlink
}

/** The sessions belonging to this cell — a subtask's own id, or (a §F GROUP's) its own id, never a
 *  union of a group's members: see `SubtaskSessionsProps.subtaskIds`'s own doc comment. */
export function sessionsFiledUnder(
  sessions: readonly TaskSessionRow[],
  subtaskIds: readonly string[],
): TaskSessionRow[] {
  return sessions.filter(s => s.subtaskId !== null && subtaskIds.includes(s.subtaskId))
}

export function planSessionCell(
  sessions: readonly TaskSessionRow[],
  subtaskIds: readonly string[],
  /** Whether the caller wired an `onOpen` at all — absent renders every reference as a label
   *  (`SessionRef`'s own rule), so the menu must not offer a verb that would do nothing. */
  canOpen: boolean,
): SessionCellPlan {
  const filed = sessionsFiledUnder(sessions, subtaskIds)
  const single = filed.length === 1 ? filed[0]! : undefined

  return {
    sessions: filed,
    display: filed.length === 0
      ? { kind: 'empty' }
      : single
        ? { kind: 'single', session: single }
        : { kind: 'multi' },
    link: filed.length === 0 ? 'link' : 'another',
    open: single && canOpen && !single.historical ? single : null,
    unlink: filed.length === 0
      ? { kind: 'none' }
      : single
        ? { kind: 'one', session: single }
        : { kind: 'pick' },
  }
}
