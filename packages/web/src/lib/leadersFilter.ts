/**
 * The aside's persisted leaders-only view uses active fleet states, after search and value
 * filters. It bypasses the normal pinned/folder/band arrangement and the summary filter.
 */
import { ACTIVE_STATES } from '@agentistics/tui/control/session-fleet'
import type { SessionRole } from './sessionRoles'

const active = new Set<string>(ACTIVE_STATES)
const isActiveLeader = <T extends { state: string }>(row: T, roleOf: (row: T) => SessionRole | undefined) =>
  active.has(row.state) && roleOf(row) === 'leader'

/** Count active leaders in the search/value-filtered rows, before summary filtering. */
export function countLeaders<T extends { state: string }>(rows: readonly T[], roleOf: (row: T) => SessionRole | undefined): number {
  let n = 0
  for (const r of rows) if (isActiveLeader(r, roleOf)) n++
  return n
}

/** Off preserves every row; on keeps only active leaders. */
export function applyLeadersOnly<T extends { state: string }>(rows: readonly T[], on: boolean, roleOf: (row: T) => SessionRole | undefined): T[] {
  return on ? rows.filter(r => isActiveLeader(r, roleOf)) : [...rows]
}

/** The summary part's words: "2 líderes". */
export function leadersText(n: number, pt: boolean): string {
  return pt ? `${n} ${n === 1 ? 'líder' : 'líderes'}` : `${n} ${n === 1 ? 'leader' : 'leaders'}`
}
