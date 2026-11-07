/**
 * liveSessionLinks — PURE. The "abrir sessão" links a Live card offers: the author's session, the QA's
 * and the leader's. A link names a session the fleet still carries (an ended one has nothing to open),
 * appears once per session, and says in a word whose it is.
 */

import type { FleetRow } from '../../lib/fleet'
import type { LeaderRecord, LiveCard } from './liveDeliveryModel'

export type SessionLinkRole = 'author' | 'qa' | 'leader'
export interface SessionLink { role: SessionLinkRole; id: string }

/** The same test the server uses to call a session "the QA's" (`task-live.ts` QA_NAME). */
const QA_NAME = /(^|[^a-z])qa([^a-z]|$)|\bquality\b/i

export const SESSION_LINK_WORD: Record<SessionLinkRole, { pt: string; en: string }> = {
  author: { pt: 'Autor', en: 'Author' },
  qa: { pt: 'QA', en: 'QA' },
  leader: { pt: 'Líder', en: 'Leader' },
}

export const openSessionWord = (pt: boolean): string => (pt ? 'abrir sessão' : 'open session')

export function sessionLinks(c: LiveCard, fleet: readonly FleetRow[], leaders: readonly LeaderRecord[]): SessionLink[] {
  const byId = new Map(fleet.map(r => [r.id, r]))
  const ids = [...new Set([...c.agents.map(a => a.id), ...c.d.sessionIds])]
  const leaderIds = new Set(leaders.map(l => l.id))
  const out: SessionLink[] = []
  const seen = new Set<string>()
  const push = (role: SessionLinkRole, id: string) => { if (!seen.has(id) && byId.has(id)) { seen.add(id); out.push({ role, id }) } }
  for (const id of ids) {
    const title = byId.get(id)?.title ?? ''
    if (leaderIds.has(id)) push('leader', id)
    else if (QA_NAME.test(title)) push('qa', id)
    else push('author', id)
  }
  // The leader the piece's workers answer to, even when none of its own sessions is filed on the piece.
  const owner = leaders.find(l => l.workers.some(w => ids.includes(w.id)))
  if (owner) push('leader', owner.id)
  const rank: Record<SessionLinkRole, number> = { author: 0, qa: 1, leader: 2 }
  return out.sort((a, b) => rank[a.role] - rank[b.role])
}
