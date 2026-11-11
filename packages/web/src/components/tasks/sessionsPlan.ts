/**
 * sessionsPlan.ts — PURE. How a task's sessions are grouped, counted and filtered for the
 * Agentask detail (leader cards, per-subtask summaries, the Sessions tab).
 *
 * Only a LEADER is filed on the task itself (server rule, `task-attach.ts`), so a row filed on no
 * subtask is either a leader (the cards at the top) or a LEGACY worker, which is never hidden or
 * deleted: it lands in the "no subtask" group. "Alive" is what the live fleet says this second; a
 * row the fleet does not carry is not alive — it is "not in fleet", never promoted to running.
 */

import type { TaskSessionRow } from '../../lib/tasks'
import { isLiveState } from '@agentistics/core'

export type SessionsFilter = 'alive' | 'ended' | 'all'

/** The fleet states that mean a process is still there to talk to. */

export interface PlanRow {
  row: TaskSessionRow
  alive: boolean
  /** The fleet's own state word, when the fleet carries the row. */
  state: string | undefined
  leader: boolean
}

export interface SessionsSummary { alive: number; ended: number; costUSD: number | null }

export type SessionGroupKind = 'leaders' | 'subtask' | 'none'
export interface SessionGroup {
  key: string
  kind: SessionGroupKind
  subtaskId: string | null
  title: string
  rows: PlanRow[]
  summary: SessionsSummary
}

export function isAlive(state: string | undefined): boolean {
  return isLiveState(state)
}

export function toPlanRows(
  sessions: readonly TaskSessionRow[],
  stateOf: (id: string) => string | undefined,
  isLeader: (row: TaskSessionRow) => boolean,
): PlanRow[] {
  return sessions.map(row => {
    const state = row.historical ? undefined : stateOf(row.id)
    return { row, state, alive: isAlive(state), leader: isLeader(row) }
  })
}

/** Alive first (a person acts on those), then newest first. */
export function orderRows(rows: readonly PlanRow[]): PlanRow[] {
  return [...rows].sort((a, b) =>
    Number(b.alive) - Number(a.alive) || (b.row.createdAt < a.row.createdAt ? -1 : b.row.createdAt > a.row.createdAt ? 1 : 0))
}

/** `costUSD` is null when NO row could be priced — never a confident 0. */
export function summarize(rows: readonly PlanRow[]): SessionsSummary {
  let alive = 0, cost = 0, priced = 0
  for (const r of rows) {
    if (r.alive) alive++
    if (r.row.costUSD !== null) { cost += r.row.costUSD; priced++ }
  }
  return { alive, ended: rows.length - alive, costUSD: priced === 0 ? null : cost }
}

export function matchesFilter(r: PlanRow, f: SessionsFilter): boolean {
  return f === 'all' || (f === 'alive' ? r.alive : !r.alive)
}

export function matchesQuery(r: PlanRow, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [r.row.label, r.row.id, r.row.harness, r.row.model ?? '', r.row.cwd, r.state ?? '']
    .some(v => (v ?? '').toLowerCase().includes(needle))
}

export function planGroups(o: {
  rows: readonly PlanRow[]
  subtasks: readonly { id: string; title: string }[]
  filter: SessionsFilter
  query: string
  titles: { leaders: string; none: string }
}): SessionGroup[] {
  const keep = (r: PlanRow) => matchesFilter(r, o.filter) && matchesQuery(r, o.query)
  const make = (key: string, kind: SessionGroupKind, subtaskId: string | null, title: string, all: PlanRow[]): SessionGroup | null => {
    const rows = orderRows(all.filter(keep))
    return rows.length === 0 ? null : { key, kind, subtaskId, title, rows, summary: summarize(all) }
  }
  const direct = o.rows.filter(r => r.row.subtaskId === null)
  const out = [
    make('leaders', 'leaders', null, o.titles.leaders, direct.filter(r => r.leader)),
    ...o.subtasks.map(s => make(s.id, 'subtask', s.id, s.title, o.rows.filter(r => r.row.subtaskId === s.id))),
    make('none', 'none', null, o.titles.none, direct.filter(r => !r.leader)),
  ]
  return out.filter((g): g is SessionGroup => g !== null)
}

/** The dots drawn on a subtask line: the alive rows only, capped so the line never grows. */
export function dotRows(rows: readonly PlanRow[], cap = 4): { shown: PlanRow[]; more: number } {
  const alive = rows.filter(r => r.alive)
  return { shown: alive.slice(0, cap), more: Math.max(0, alive.length - cap) }
}
