/**
 * boardPrefs — what the board looked like when you left it.
 *
 * Opening a task is a NAVIGATION (`/tasks/:id`), so the list unmounts and every piece of arrangement
 * it held — which view, which columns, which groups, which of them were folded — is gone by the time
 * you press back. Re-deciding all of it on every return is the same defect as a filter that resets
 * itself: the arrangement is the user's, and a surface that forgets it teaches people not to arrange
 * anything.
 *
 * It lives on the SERVER, per PERSON (`PERSONAL_PREFS` = `/api/user-prefs`): a machine keeps it in
 * its own preferences file, a central keeps it in the signed-in account's `userPrefs` document —
 * never in the central's `preferences.json`, which is shared by everyone signed in, so one
 * person's hidden columns would hide them for the whole team (t-f4e5ecffe7). It used to be
 * `localStorage` alone, so the same board arranged on the desktop opened unarranged on the phone.
 * The browser copy (the old key, kept compatible) is now only the first paint, and the first armed
 * load writes it up when the server has nothing yet — see `sharedPref.ts`.
 *
 * Every read is total. A private window, cleared site data, or a stored document from another
 * build must never stop the board rendering: what cannot be read falls back to the defaults.
 */

import type { BoardStatus, ColumnId } from './board'
import { SUBTASK_COLUMNS, type SubtaskColumnId } from './subtaskColumnDefs'
import { DEFAULT_SORT, type SortSpec } from '@agentistics/core'
import { useSyncExternalStore } from 'react'
import { createSharedPref, PERSONAL_PREFS } from '../../lib/sharedPref'

const KEY = 'agentistics-task-board-v1'

export type BoardView = 'overview' | 'board' | 'table'

/** What the TABLE is grouped by — one or the other, per person. */
export type GroupBy = 'status' | 'type'
const isGroupBy = (v: unknown): v is GroupBy => v === 'status' || v === 'type'

export interface BoardPrefs {
  view: BoardView
  /** How the rows are ordered — the table's headers and the kanban's picker write the same field. */
  sort: SortSpec
  /**
   * A kanban column's OWN order, by status id — set by clicking the column's title. A status absent
   * here follows `sort`. Kept apart from `sort` because it is the smaller, later statement: the
   * board's picker is the default for every column nobody touched.
   */
  columnSort: Record<string, SortSpec>
  /** The kanban's own arrangement: what the swimlanes are, and the per-column WIP limit. */
  lanes: LaneKey
  wip: Record<string, number>
  /** Which columns the table shows, in the order they were picked. */
  columns: ColumnId[] | null
  /**
   * Which columns the SUBTASK grid shows, in the order they were picked — a SEPARATE slot from
   * `columns` above (t-63b7d3b2b0 #1): the delivery table and the subtask grid have different
   * column sets (`ColumnId` vs `SubtaskColumnId`), and the two grids are drawn side by side inside
   * one expanded row (`TaskTable.tsx`'s own `SubtaskRows`), so reusing one key would make picking a
   * column for either table silently rewrite the other's arrangement. `null` = every column, the
   * fixed order the grid shipped with before this picker existed.
   */
  subtaskColumns: SubtaskColumnId[] | null
  /** Saved widths of the delivery table's columns, by column id — only the ones the person dragged. */
  columnWidths: Record<string, number>
  /** Saved widths of the subtask grid's columns, independent from the delivery table. */
  subtaskColumnWidths: Record<string, number>
  /** Which status groups the table renders at all. `null` = every one of them. */
  groups: BoardStatus[] | null
  /** What the table's bands are: the status columns or the task type. Default `status`. */
  groupBy: GroupBy
  /** Which TYPE bands the table renders when `groupBy` is `type` (ids, or `__none__`). `null` = all. */
  typeGroups: string[] | null
  /** Groups the user folded shut. */
  collapsed: BoardStatus[]
  /** Hide groups/columns with nothing in them (a view choice; the stored picks are untouched). */
  hideEmpty: boolean
  /** Compose in-progress subtasks into the task progress bar. */
  composeSubtaskProgress: boolean
  /** Which sections of the task detail's right rail are OPEN, by their stable id. */
  rail: Record<string, boolean>
}

/** The metrics view is the default, because "what did it cost" is the question the board answers. */
export const DEFAULT_PREFS: BoardPrefs = {
  view: 'overview', sort: { key: 'priority', dir: 'asc' }, columnSort: {}, lanes: 'none', wip: {},
  columns: null, subtaskColumns: null, columnWidths: {}, subtaskColumnWidths: {}, groups: null, groupBy: 'status', typeGroups: null, collapsed: [], hideEmpty: false, composeSubtaskProgress: true, rail: {},
}

/**
 * Is this rail section open?
 *
 * Read through a function rather than off the object, because a section the user has never touched
 * must fall back to the CALLER's default — "not stored" and "stored as shut" are different, and
 * treating them alike would open every section on a rail somebody deliberately folded.
 */
export function railOpen(id: string, fallback: boolean): boolean {
  const v = readBoardPrefs().rail[id]
  return typeof v === 'boolean' ? v : fallback
}

export function setRailOpen(id: string, open: boolean): void {
  writeBoardPrefs({ rail: { ...readBoardPrefs().rail, [id]: open } })
}

/** What the kanban's rows are grouped by. `none` is one lane holding everything. */
export type LaneKey = 'none' | 'repo' | 'harness' | 'priority'

export const LANE_KEYS: readonly LaneKey[] = ['none', 'repo', 'harness', 'priority']

const isLane = (v: unknown): v is LaneKey => LANE_KEYS.includes(v as LaneKey)

/** A stored sort naming a key this build no longer has falls back rather than throwing. */
function readSort(v: unknown): SortSpec {
  if (!v || typeof v !== 'object') return DEFAULT_SORT
  const s = v as Record<string, unknown>
  const dir = s.dir === 'desc' ? 'desc' : 'asc'
  return typeof s.key === 'string' ? { key: s.key as SortSpec['key'], dir } : DEFAULT_SORT
}

/** A stored per-column record: every entry goes through `readSort`, and anything else is dropped. */
function readColumnSort(v: unknown): Record<string, SortSpec> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([, spec]) => spec && typeof spec === 'object'
        && typeof (spec as Record<string, unknown>).key === 'string')
      .map(([status, spec]) => [status, readSort(spec)]),
  )
}

// A stored 'agents' value (the view existed once and could still be sitting in a browser's
// localStorage) falls back to the default rather than naming a view this build no longer has —
// the same rule `readSort` and `statuses` already apply to a stale key.
const isView = (v: unknown): v is BoardView =>
  v === 'overview' || v === 'board' || v === 'table'

// The status vocabulary is an editable LIST now (`@agentistics/core`'s `taskStatus.ts`), so a
// stored group/collapsed id can be any status a person has created — no longer just one of the
// fixed seven `COLUMN_ORDER` used to gate against. A stale id (a status since deleted) is left for
// the READER to drop, cross-checked against the live list it has and this one does not
// (`board.ts`'s `liveStatusOrder`/`statusStyle`) — this file only validates that the stored value
// is a list of strings at all.
const statuses = (v: unknown): BoardStatus[] | null =>
  Array.isArray(v) ? v.filter((x): x is BoardStatus => typeof x === 'string') : null

/**
 * PURE: a stored document → a board arrangement. Total — anything unrecognised falls back field by
 * field, so a document written by another build or edited by hand never blanks the board.
 */
export function parseBoardPrefs(raw: unknown): BoardPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_PREFS
  const p = raw as Record<string, unknown>
  return {
    view: isView(p.view) ? p.view : DEFAULT_PREFS.view,
    sort: p.sort === undefined ? DEFAULT_PREFS.sort : readSort(p.sort),
    columnSort: readColumnSort(p.columnSort),
    lanes: isLane(p.lanes) ? p.lanes : 'none',
    // A WIP limit is a number per column; anything else in the stored object is dropped rather
    // than rendered as a limit nobody set.
    wip: p.wip && typeof p.wip === 'object'
      ? Object.fromEntries(Object.entries(p.wip as Record<string, unknown>)
        .filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n > 0)) as Record<string, number>
      : {},
    // A stored column id no longer in the table is dropped rather than rendering a blank cell;
    // an EMPTY stored list is a real choice ("show me only the names") and is kept.
    columns: Array.isArray(p.columns) ? (p.columns as ColumnId[]) : null,
    subtaskColumns: Array.isArray(p.subtaskColumns)
      ? (p.subtaskColumns as SubtaskColumnId[]).filter(id => SUBTASK_COLUMNS.some(c => c.id === id))
      : null,
    columnWidths: p.columnWidths && typeof p.columnWidths === 'object' && !Array.isArray(p.columnWidths)
      ? Object.fromEntries(Object.entries(p.columnWidths as Record<string, unknown>)
        .filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n > 0)) as Record<string, number>
      : {},
    subtaskColumnWidths: p.subtaskColumnWidths && typeof p.subtaskColumnWidths === 'object' && !Array.isArray(p.subtaskColumnWidths)
      ? Object.fromEntries(Object.entries(p.subtaskColumnWidths as Record<string, unknown>)
        .filter(([id, n]) => id !== 'progress' && typeof n === 'number' && Number.isFinite(n) && n > 0)) as Record<string, number>
      : {},
    groups: statuses(p.groups),
    groupBy: isGroupBy(p.groupBy) ? p.groupBy : 'status',
    typeGroups: Array.isArray(p.typeGroups) ? p.typeGroups.filter((x): x is string => typeof x === 'string') : null,
    collapsed: statuses(p.collapsed) ?? [],
    hideEmpty: p.hideEmpty === true,
    composeSubtaskProgress: p.composeSubtaskProgress !== false,
    rail: p.rail && typeof p.rail === 'object'
      ? Object.fromEntries(Object.entries(p.rail as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
      : {},
  }
}

const store = createSharedPref<BoardPrefs>({
  key: KEY,
  prefKey: 'taskBoard',
  endpoint: PERSONAL_PREFS,
  fallback: DEFAULT_PREFS,
  parse: parseBoardPrefs,
  adoptLocalWhenAbsent: true,
})

export function readBoardPrefs(): BoardPrefs {
  return store.get()
}

export function writeBoardPrefs(patch: Partial<BoardPrefs>): void {
  store.set({ ...store.get(), ...patch })
}

/** The arrangement, LIVE: a value the server answers after the board mounted still lands on it. */
export function useBoardPrefs(): BoardPrefs {
  return useSyncExternalStore(store.subscribe, store.get, store.serverSnapshot)
}

/**
 * One field of the arrangement as a `[value, set]` pair — the shape the board's components held as
 * a `useState` seeded once from `readBoardPrefs()`. Seeded once is the bug: a phone opening the
 * board before the server answered kept the defaults until it was remounted.
 */
export function useBoardPref<K extends keyof BoardPrefs>(k: K): [BoardPrefs[K], (v: BoardPrefs[K]) => void] {
  const value = useSyncExternalStore(store.subscribe, () => store.get()[k], () => store.serverSnapshot()[k])
  return [value, (v: BoardPrefs[K]) => writeBoardPrefs({ [k]: v } as Partial<BoardPrefs>)]
}
