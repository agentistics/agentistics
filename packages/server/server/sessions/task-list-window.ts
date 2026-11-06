/**
 * task-list-window.ts — what the Agentask list sends FIRST and what it can leave for later (pure).
 *
 * The list used to be one 276 KB answer holding every task ever filed, half of it the long
 * description of each. A board is read at its OPEN work, so the answer is split in two steps the
 * person never sees: the rows they can act on now arrive first, the closed history streams in behind
 * and merges. Both steps carry the SAME `total` and the SAME board `overview`, so counts and
 * headers are right from the first paint and nothing jumps when step two lands.
 */
import type { TaskListRow } from './task-report'

/** "Recent activity" — the owner's window. */
export const RECENT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000
/** Enough of a description for a card; the whole text is one `/api/tasks/<ref>` away. */
export const LIST_DETAIL_CLIP = 400

/**
 * A task that is finished or given up. Everything else is work somebody can still act on.
 *
 * By STATUS alone: a task moved back to `in_progress` keeps its old `deliveredAt`, and treating that
 * stamp as "closed" left a live in-progress card out of step one (measured on the real book — it
 * appeared in its column only when step two landed, which is exactly the jump this split must not make).
 */
function closed(row: TaskListRow): boolean {
  return row.task.status === 'done' || row.task.status === 'abandoned'
}

/**
 * Step one: every OPEN task (the kanban columns a person looks at) plus any task touched inside
 * the window, closed ones included. Order is preserved, so the rest merges in as a plain
 * supersequence of what is already on screen.
 */
export function recentRows(rows: readonly TaskListRow[], nowMs: number): TaskListRow[] {
  return rows.filter(r => {
    if (!closed(r)) return true
    const at = Date.parse(r.task.updatedAt)
    return Number.isFinite(at) && nowMs - at < RECENT_WINDOW_MS
  })
}

/**
 * The list does not render a description past a card's worth. Clipped rows are copies; the cached
 * source rows are never mutated. `detailClipped` lets a consumer that needs the whole text (the
 * search box) know it must ask for it.
 */
export function clipDetails(rows: readonly TaskListRow[]): TaskListRow[] {
  return rows.map(r => {
    const d = r.task.detail
    if (d === undefined || d.length <= LIST_DETAIL_CLIP) return r
    return { ...r, task: { ...r.task, detail: d.slice(0, LIST_DETAIL_CLIP) }, detailClipped: true }
  })
}

/**
 * What a `GET /api/tasks` query string asks for. The DEFAULT is the whole text: the CLI and the MCP
 * tools read the board to learn what to do, and a brief cut at 400 characters is a brief half read.
 * Only the web list opts into the clipped form (`clip=1`), and `full=1` wins over it.
 */
export function listOptionsOf(params: URLSearchParams): { clip: boolean; recent: boolean } {
  return {
    clip: params.get('clip') === '1' && params.get('full') !== '1',
    recent: params.get('recent') === '1',
  }
}
