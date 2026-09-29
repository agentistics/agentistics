/**
 * subtaskFilter.ts — PURE. Which subtask rows survive a column filter (t-63b7d3b2b0 #2), by status,
 * harness or model. Client-side, over one delivery's own (already-loaded) subtasks and sessions —
 * a task holds at most a few dozen of either, so there is no volume here that needs the server.
 *
 * `status` is the subtask's own field. `harness`/`model` are properties of the SESSIONS filed under
 * it (`TaskSessionRow`), never of the subtask itself, so those two match when AT LEAST ONE of a
 * subtask's own filed sessions carries the picked value — the same "any of its rows" reading
 * `modelsOf`/`SubtaskSessions` already apply for display. A subtask with no sessions filed can never
 * match a harness/model filter, which is the honest answer: there is nothing to have run either one.
 */

import { isGroupMember, isGroupSubtask } from './subtaskGroups'
import { modelsOf } from './SubtaskModelCell'
import type { Subtask, TaskSessionRow } from '../../lib/tasks'

export interface SubtaskFilterState {
  status: string | null
  harness: string | null
  model: string | null
}

export const EMPTY_SUBTASK_FILTER: SubtaskFilterState = { status: null, harness: null, model: null }

export function subtaskFilterActive(f: SubtaskFilterState): boolean {
  return f.status !== null || f.harness !== null || f.model !== null
}

function matchesFilter(
  t: Subtask, sessions: readonly TaskSessionRow[], f: SubtaskFilterState,
): boolean {
  if (f.status !== null && t.status !== f.status) return false
  if (f.harness !== null || f.model !== null) {
    const mine = sessions.filter(s => s.subtaskId === t.id)
    if (f.harness !== null && !mine.some(s => s.harness === f.harness)) return false
    if (f.model !== null && !mine.some(s => s.model === f.model)) return false
  }
  return true
}

/**
 * The subtasks left standing once the filter is applied — an inactive filter (every field `null`)
 * returns every row, unchanged and un-copied in identity terms is not guaranteed but content-equal.
 *
 * A GROUP whose own header does not match is KEPT when one of its members does, and a MEMBER that
 * does not match is KEPT when its group does — never orphaning one half of a cluster the board
 * always draws together (`clusterSubtaskRows`). Every non-group, non-member subtask is judged only
 * on its own fields.
 */
export function filterSubtaskRows(
  subtasks: readonly Subtask[],
  sessions: readonly TaskSessionRow[],
  f: SubtaskFilterState,
): Subtask[] {
  if (!subtaskFilterActive(f)) return [...subtasks]
  const matched = new Set(subtasks.filter(t => matchesFilter(t, sessions, f)).map(t => t.id))
  const byGroup = new Map<string, Subtask[]>()
  for (const t of subtasks) {
    if (!isGroupMember(t) || !t.parentGroupId) continue
    const list = byGroup.get(t.parentGroupId)
    if (list) list.push(t)
    else byGroup.set(t.parentGroupId, [t])
  }
  return subtasks.filter(t => {
    if (matched.has(t.id)) return true
    if (isGroupMember(t) && t.parentGroupId && matched.has(t.parentGroupId)) return true
    if (isGroupSubtask(t) && (byGroup.get(t.id) ?? []).some(m => matched.has(m.id))) return true
    return false
  })
}

/** The distinct harnesses among sessions filed on any of these subtasks — the filter's own option
 *  list, so it only ever offers a value that could actually match something. */
export function distinctHarnesses(sessions: readonly TaskSessionRow[]): string[] {
  const out: string[] = []
  for (const s of sessions) if (!out.includes(s.harness)) out.push(s.harness)
  return out
}

/** The filter's own Model option list — the same distinct-values rule the Model column itself
 *  reads a subtask's sessions through. */
export const distinctModels = modelsOf
