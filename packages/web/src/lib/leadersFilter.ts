/**
 * leadersFilter.ts — PURE: the aside's "só líderes" switch.
 *
 * A PERSISTED arrangement choice (`AsideGroupPrefs.leadersOnly`), not the transient `summaryFilter`:
 * a fleet is mostly workers, and the person who wants only the leaders wants it on the next visit
 * too. It is a FILTER, so it narrows the same pipeline the summary filter does and counts on the
 * Filtros badge — never on the arrange button.
 *
 * What it does NOT touch: the pinned band (a pin is "always in sight", the rule `activeOnly` already
 * keeps) and the folder TREE — a folder with no leader left keeps its place, dimmed, by the same
 * `narrowing` rule a search uses.
 */
import type { SessionRole } from './sessionRoles'

/** How many of these rows are leaders (the count the summary part wears). */
export function countLeaders<T>(rows: readonly T[], roleOf: (row: T) => SessionRole | undefined): number {
  let n = 0
  for (const r of rows) if (roleOf(r) === 'leader') n++
  return n
}

/** The rows when the switch is off; only the leaders when it is on. */
export function applyLeadersOnly<T>(rows: readonly T[], on: boolean, roleOf: (row: T) => SessionRole | undefined): T[] {
  return on ? rows.filter(r => roleOf(r) === 'leader') : [...rows]
}

/** The summary part's words: "2 líderes". */
export function leadersText(n: number, pt: boolean): string {
  return pt ? `${n} ${n === 1 ? 'líder' : 'líderes'}` : `${n} ${n === 1 ? 'leader' : 'leaders'}`
}

/** The banner under the verbs row while the switch is on — said, so a short list is never a mystery. */
export function leadersBanner(hidden: number, pt: boolean): string {
  const h = pt
    ? `${hidden} ${hidden === 1 ? 'sessão oculta' : 'sessões ocultas'}`
    : `${hidden} ${hidden === 1 ? 'session' : 'sessions'} hidden`
  return pt ? `Mostrando só líderes · ${h}` : `Showing leaders only · ${h}`
}
