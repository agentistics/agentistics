/**
 * archived-links.ts — PURE. BENCHMARK.LACUNAS, the piece -> session link of a session that is no longer in the live registry.
 *
 * Why: `fechar-entregue` and a leader's kill end the worker right after its handback and the registry row leaves, taking the only
 * statement of which piece the conversation belonged to (on the reporting machine 26 of 1040 deliveries still had a session).
 * Two records outlive the row and are not guesses:
 *   - the board's COMMENTS carry `sessionId` (the managed id, proven by the MCP's session proof) and `subtaskId`;
 *   - the event inbox (`events.jsonl`, current + previous generation) carries `id` -> `conversationId` and the harness.
 * A session is filed on a piece ONLY with durable, verifiable authorship: it posted a HANDBACK comment on that subtask, or it is
 * named by the piece's delivery record (author, QA, or the session that filed evidence). Merely commenting is NOT authorship — a
 * leader comments on the pieces it coordinates. A leader is never an author (registry flag or "[ LÍDER ]" label, a delivery's
 * `leaderSessionId`, a task-level comment that is not the mirror of / next to its own piece handback, a `decision` comment, comments on several subtasks), and a conversation whose managed
 * ids point at different subtasks is ambiguous. When unsure, nothing is linked: a piece with no session is "not measured", a piece
 * with somebody else's session is a wrong number.
 */

export interface ArchivedComment { sessionId?: string; subtaskId?: string; kind?: string; body?: string; createdAt: string }
export interface ArchivedConversation { conversationId: string; harness: string }
export interface ArchivedLink { sessionId: string; conversationId: string; harness: string; subtaskId: string; atMs: number }
/** A delivery record naming a session as the author, QA or evidence filer of a piece. */
export interface AuthorshipProof { sessionId: string; subtaskId: string }

/**
 * A worker also writes on the TASK around its own piece handback (the same handback mirrored there, a "starting" or "done" note
 * seconds or minutes apart). Such a task-level comment is the worker's, not a coordinator's, when it is the same session's and has
 * the same body as a piece handback or falls within this window of one. A leader's task comments are scattered over days.
 */
const MIRROR_WINDOW_MS = 60 * 60 * 1000

const ms = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0 }

export function archivedLinks(i: {
  comments: readonly ArchivedComment[]
  /** managed session id -> its conversation (inbox events, then registry rows). */
  conversations: ReadonlyMap<string, ArchivedConversation>
  /** Managed ids that lead (registry flag or label, a delivery record's `leaderSessionId`): never filed on one piece. */
  leaderIds: ReadonlySet<string>
  /** Only subtasks the board still has can be filed on. */
  subtasks: ReadonlySet<string>
  /** Delivery records naming who wrote or reviewed a piece (author, QA, evidence `by`). */
  proofs?: readonly AuthorshipProof[]
}): ArchivedLink[] {
  const named = new Map<string, Map<string, number>>()
  const authored = new Set<string>() // `${sessionId}|${subtaskId}`
  const coordinators = new Set<string>()
  const pieceHandbacks = new Map<string, ArchivedComment[]>()
  for (const c of i.comments) if (c.sessionId && c.subtaskId && c.kind === 'handback') pieceHandbacks.set(c.sessionId, [...(pieceHandbacks.get(c.sessionId) ?? []), c])
  const mirrors = (c: ArchivedComment): boolean => (pieceHandbacks.get(c.sessionId!) ?? []).some(h =>
    (!!c.body && h.body === c.body) || Math.abs(ms(h.createdAt) - ms(c.createdAt)) <= MIRROR_WINDOW_MS)
  for (const c of i.comments) {
    if (!c.sessionId) continue
    // the mirrored copy of a piece handback says nothing the piece's own handback does not
    if (!c.subtaskId && mirrors(c)) continue
    // any other task-level comment or a decision is a coordinator's act, wherever else it also wrote
    if (!c.subtaskId || c.kind === 'decision') { coordinators.add(c.sessionId); continue }
    if (!i.subtasks.has(c.subtaskId)) continue
    const per = named.get(c.sessionId) ?? new Map<string, number>()
    per.set(c.subtaskId, Math.max(per.get(c.subtaskId) ?? 0, ms(c.createdAt)))
    named.set(c.sessionId, per)
    if (c.kind === 'handback') authored.add(`${c.sessionId}|${c.subtaskId}`)
  }
  // a delivery record that names a session proves authorship by itself, comment or none
  const proven = new Map<string, Set<string>>()
  for (const p of i.proofs ?? []) {
    authored.add(`${p.sessionId}|${p.subtaskId}`)
    if (!i.subtasks.has(p.subtaskId) || named.has(p.sessionId)) continue
    proven.set(p.sessionId, (proven.get(p.sessionId) ?? new Set()).add(p.subtaskId))
  }
  for (const [sessionId, subs] of proven) named.set(sessionId, new Map([...subs].map(s => [s, 0] as [string, number])))
  const candidates: ArchivedLink[] = []
  for (const [sessionId, per] of named) {
    if (per.size !== 1 || i.leaderIds.has(sessionId) || coordinators.has(sessionId)) continue
    const [subtaskId, atMs] = [...per][0]!
    if (!authored.has(`${sessionId}|${subtaskId}`)) continue
    const conv = i.conversations.get(sessionId)
    if (!conv) continue
    candidates.push({ sessionId, conversationId: conv.conversationId, harness: conv.harness, subtaskId, atMs })
  }
  // one conversation, one piece: managed ids of the same conversation must agree
  const subtasksOf = new Map<string, Set<string>>()
  for (const c of candidates) subtasksOf.set(c.conversationId, (subtasksOf.get(c.conversationId) ?? new Set()).add(c.subtaskId))
  return candidates.filter(c => subtasksOf.get(c.conversationId)!.size === 1)
}
