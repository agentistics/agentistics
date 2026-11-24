/**
 * archived-links.ts — PURE. BENCHMARK.LACUNAS, the piece -> session link of a session that is no longer in the live registry.
 *
 * Why: `fechar-entregue` and a leader's kill end the worker right after its handback and the registry row leaves, taking the only
 * statement of which piece the conversation belonged to (on the reporting machine 26 of 1040 deliveries still had a session).
 * Two records outlive the row and are not guesses:
 *   - the board's COMMENTS carry `sessionId` (the managed id, proven by the MCP's session proof) and `subtaskId`;
 *   - the event inbox (`events.jsonl`, current + previous generation) carries `id` -> `conversationId` and the harness.
 * A session is filed on the ONE subtask its own comments name. A session that spoke on several subtasks is a coordinator (its
 * cost would belong to all of them at once), a registered leader is never filed, and a conversation whose managed ids point at
 * different subtasks is ambiguous: all of these are left out, because a piece with no session is "not measured" and a piece with
 * somebody else's session is a wrong number.
 */

export interface ArchivedComment { sessionId?: string; subtaskId?: string; createdAt: string }
export interface ArchivedConversation { conversationId: string; harness: string }
export interface ArchivedLink { sessionId: string; conversationId: string; harness: string; subtaskId: string; atMs: number }

const ms = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0 }

export function archivedLinks(i: {
  comments: readonly ArchivedComment[]
  /** managed session id -> its conversation (inbox events, then registry rows). */
  conversations: ReadonlyMap<string, ArchivedConversation>
  /** Managed ids that lead (registry flag, a delivery record's `leaderSessionId`): never filed on one piece. */
  leaderIds: ReadonlySet<string>
  /** Only subtasks the board still has can be filed on. */
  subtasks: ReadonlySet<string>
}): ArchivedLink[] {
  const named = new Map<string, Map<string, number>>()
  for (const c of i.comments) {
    if (!c.sessionId || !c.subtaskId || !i.subtasks.has(c.subtaskId)) continue
    const per = named.get(c.sessionId) ?? new Map<string, number>()
    per.set(c.subtaskId, Math.max(per.get(c.subtaskId) ?? 0, ms(c.createdAt)))
    named.set(c.sessionId, per)
  }
  const candidates: ArchivedLink[] = []
  for (const [sessionId, per] of named) {
    if (per.size !== 1 || i.leaderIds.has(sessionId)) continue
    const conv = i.conversations.get(sessionId)
    if (!conv) continue
    const [subtaskId, atMs] = [...per][0]!
    candidates.push({ sessionId, conversationId: conv.conversationId, harness: conv.harness, subtaskId, atMs })
  }
  // one conversation, one piece: managed ids of the same conversation must agree
  const subtasksOf = new Map<string, Set<string>>()
  for (const c of candidates) subtasksOf.set(c.conversationId, (subtasksOf.get(c.conversationId) ?? new Set()).add(c.subtaskId))
  return candidates.filter(c => subtasksOf.get(c.conversationId)!.size === 1)
}
