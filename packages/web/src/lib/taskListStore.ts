/**
 * taskListStore — the Agentask task list, kept for the life of the page (stale-while-revalidate).
 *
 * `useTaskList` used to own its rows in component state, so leaving /tasks threw the board away and
 * coming back showed a loader and refetched everything. The rows now live here, keyed by the
 * request's query string (a different filter is a different list). A visit renders the cached
 * entry at once, then revalidates in the background; `mergeRows` keeps the identity of every row
 * the server did not change, so React re-renders only what moved and the table keeps its scroll,
 * expanded rows and column widths.
 */
import type { BoardOverview, TaskListRow } from './tasks'

export type TaskListError = null | 'refused' | 'down'

export interface TaskListEntry {
  rows: TaskListRow[]
  overview: BoardOverview | null
  excluded: number
  error: TaskListError
}

/** Structural equality for JSON-shaped values; rows are plain data from `res.json()`. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/**
 * The next rows, reusing the previous object for every row that did not change. Order is the
 * server's; a removed task drops out, a new one is taken as sent. When nothing changed at all the
 * PREVIOUS ARRAY is returned, so a `Object.is` check upstream skips the render.
 */
export function mergeRows(prev: readonly TaskListRow[], next: readonly TaskListRow[]): TaskListRow[] {
  const byId = new Map(prev.map(r => [r.task.id, r]))
  const merged = next.map(r => {
    const old = byId.get(r.task.id)
    return old && same(old, r) ? old : r
  })
  const unchanged = merged.length === prev.length && merged.every((r, i) => r === prev[i])
  return unchanged ? (prev as TaskListRow[]) : merged
}

/** Merge a fresh answer into the entry, keeping every reference that did not change. */
export function mergeEntry(prev: TaskListEntry | undefined, next: TaskListEntry): TaskListEntry {
  if (!prev) return next
  const rows = mergeRows(prev.rows, next.rows)
  const overview = same(prev.overview, next.overview) ? prev.overview : next.overview
  if (rows === prev.rows && overview === prev.overview && prev.excluded === next.excluded && prev.error === next.error) return prev
  return { rows, overview, excluded: next.excluded, error: next.error }
}

const entries = new Map<string, TaskListEntry>()
const listeners = new Map<string, Set<() => void>>()

export const peekTaskList = (key: string): TaskListEntry | undefined => entries.get(key)

export function putTaskList(key: string, next: TaskListEntry): void {
  const prev = entries.get(key)
  const merged = mergeEntry(prev, next)
  if (merged === prev) return
  entries.set(key, merged)
  listeners.get(key)?.forEach(l => l())
}

export function subscribeTaskList(key: string, l: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(l)
  return () => { set!.delete(l) }
}

/** Test seam. */
export function clearTaskListStore(): void { entries.clear(); listeners.clear() }
