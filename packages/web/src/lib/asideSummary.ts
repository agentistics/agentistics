/**
 * asideSummary.ts — PURE: the one-line summary at the top of the sessions list
 * ("3 ativas · 2 trabalhando · 1 precisa de você") and the filter each part applies.
 *
 * The counts come from the SAME rows the list is built from (value filters + search, before the
 * summary's own filter), so pressing a part never changes the numbers the other parts show — a
 * summary that reshuffled itself under the finger would be unreadable.
 */
import { ACTIVE_STATES } from '@agentistics/tui/control/session-fleet'

export type SummaryPart = 'active' | 'working' | 'needs'

export interface SummaryCounts { active: number; working: number; needs: number }

const ACTIVE = new Set<string>(ACTIVE_STATES)

/** `waiting` and `waiting-approval` are the two states that want a person. */
const NEEDS = new Set<string>(['waiting', 'waiting-approval'])

export function summaryMatches(state: string, part: SummaryPart): boolean {
  if (part === 'active') return ACTIVE.has(state)
  if (part === 'working') return state === 'working'
  return NEEDS.has(state)
}

export function summaryCounts(rows: readonly { state: string }[]): SummaryCounts {
  const c: SummaryCounts = { active: 0, working: 0, needs: 0 }
  for (const r of rows) {
    if (summaryMatches(r.state, 'active')) c.active++
    if (summaryMatches(r.state, 'working')) c.working++
    if (summaryMatches(r.state, 'needs')) c.needs++
  }
  return c
}

/** `null` = no part selected: the list is untouched. */
export function applySummaryFilter<T extends { state: string }>(rows: readonly T[], part: SummaryPart | null): T[] {
  return part === null ? [...rows] : rows.filter(r => summaryMatches(r.state, part))
}

/** Pressing the selected part again clears it. */
export function toggleSummaryPart(current: SummaryPart | null, part: SummaryPart): SummaryPart | null {
  return current === part ? null : part
}

export interface SummaryPartView { part: SummaryPart; text: string; count: number }

/** The parts in reading order, each with its words. Zero parts are kept: "0 precisam de você" is an answer. */
export function summaryParts(c: SummaryCounts, pt: boolean): SummaryPartView[] {
  return [
    { part: 'active', count: c.active, text: pt ? `${c.active} ${c.active === 1 ? 'ativa' : 'ativas'}` : `${c.active} active` },
    { part: 'working', count: c.working, text: pt ? `${c.working} trabalhando` : `${c.working} working` },
    { part: 'needs', count: c.needs, text: pt ? `${c.needs} ${c.needs === 1 ? 'precisa de você' : 'precisam de você'}` : `${c.needs} need${c.needs === 1 ? 's' : ''} you` },
  ]
}

/** The capacity hook ("N/M vagas"): empty until something provides it, never a made-up figure. */
export function capacityText(capacity: { used: number; max: number } | null | undefined, pt: boolean): string {
  if (!capacity || !(capacity.max > 0)) return ''
  const free = Math.max(0, capacity.max - capacity.used)
  return pt ? `${free}/${capacity.max} vagas` : `${free}/${capacity.max} slots`
}
