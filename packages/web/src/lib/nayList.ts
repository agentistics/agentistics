/**
 * nayList.ts — PURE: how the Nay tab of the dock lists its conversations.
 *
 * Three sections, each with a word and a colour, because a grey dot alone said nothing about
 * whether a conversation was busy, waiting on the person or over (owner, 2026-09-29):
 *  - ATIVAS — working on something right now;
 *  - AGUARDANDO — alive and waiting on the person;
 *  - INATIVAS — ended; opening one offers to reopen it.
 * These mirror the folders the server files them into ("Nay › Ativas" / "Nay › Inativas"): the two
 * running sections together are the "Ativas" folder.
 *
 * One row per CONVERSATION: a reopen leaves the retired predecessor beside the live row, and the
 * live one is the row to show. Rows the fleet merely lists (a `closed` store conversation, an
 * external `unknown` process) are not Nay sessions agentop hosts and are left out.
 */

import { isNayCwd, sessionIdentityKey } from '@agentistics/core'

export type NaySectionId = 'working' | 'waiting' | 'ended'

export interface NayListRow { id: string; conversationId?: string | undefined; cwd?: string | undefined; state: string; startedAt?: number }

export const NAY_SECTION_ORDER: readonly NaySectionId[] = ['working', 'waiting', 'ended']

/** How many ended conversations the tab lists — the rest are in the "Nay › Inativas" folder. */
export const NAY_ENDED_SHOWN = 15

export function naySectionOf(state: string): NaySectionId | null {
  if (state === 'working') return 'working'
  if (state === 'waiting' || state === 'waiting-approval') return 'waiting'
  if (state === 'exited' || state === 'lost') return 'ended'
  return null
}

const RANK: Record<NaySectionId, number> = { working: 0, waiting: 1, ended: 2 }

export function naySections<R extends NayListRow>(rows: readonly R[]): Record<NaySectionId, R[]> {
  const best = new Map<string, R>()
  for (const r of rows) {
    if (!isNayCwd(r.cwd)) continue
    const section = naySectionOf(r.state)
    if (!section) continue
    const key = sessionIdentityKey(r)
    const held = best.get(key)
    if (!held || RANK[section] < RANK[naySectionOf(held.state)!]
      || (RANK[section] === RANK[naySectionOf(held.state)!] && (r.startedAt ?? 0) > (held.startedAt ?? 0))) best.set(key, r)
  }
  const out: Record<NaySectionId, R[]> = { working: [], waiting: [], ended: [] }
  for (const r of best.values()) out[naySectionOf(r.state)!].push(r)
  for (const id of NAY_SECTION_ORDER) out[id].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  out.ended = out.ended.slice(0, NAY_ENDED_SHOWN)
  return out
}

export const NAY_SECTION_TEXT: Record<NaySectionId, { heading: { pt: string; en: string }; state: { pt: string; en: string }; color: string }> = {
  working: { heading: { pt: 'Ativas', en: 'Active' }, state: { pt: 'trabalhando', en: 'working' }, color: 'var(--anthropic-orange)' },
  waiting: { heading: { pt: 'Aguardando', en: 'Waiting' }, state: { pt: 'precisa de você', en: 'needs you' }, color: '#22c55e' },
  ended: { heading: { pt: 'Inativas', en: 'Inactive' }, state: { pt: 'encerrada', en: 'ended' }, color: 'var(--text-tertiary)' },
}
