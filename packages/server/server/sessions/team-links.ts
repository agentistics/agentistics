/**
 * team-links.ts — PURE. Which leader's TEAM a session belongs to, and how that link moves.
 *
 * A team is nothing but `ManagedSession.parentSessionId` (+ `parentConversationId`, the half that
 * survives a reopen): the aside draws every live row whose parent is a live leader under that leader.
 * The rule this module guarantees (owner, 2026-10-24):
 *
 *  1. Every session a leader starts is that leader's CHILD — whatever path started it.
 *  2. EXCEPT a session that is itself a leader (`--role leader`, a `--handoff` successor, a later
 *     `agentistics_session_role leader`): it stays at the ROOT with the other leaders, never a child.
 *     A child that becomes a leader LEAVES its parent's team.
 *  3. A leader hand-off moves the WHOLE team: every session that named the predecessor now names the
 *     successor, so the sidebar shows ONE leader with all the children instead of two.
 *  4. A person can unlink a session from its leader, or move it into another leader's team.
 *
 * Nothing here ever touches a pin: a pinned session stays pinned whatever its team (owner, hard rule).
 */

export interface TeamRow {
  id: string
  conversationId?: string | undefined
  parentSessionId?: string | undefined
  parentConversationId?: string | undefined
  endedAt?: string | undefined
  handoffTo?: string | undefined
}

/** The registry patch that sets (or, with `null`, clears) a row's team link. */
export interface ParentPatch {
  parentSessionId: string | null
  parentConversationId: string | null
}

/** Clearing patch: the row has no leader (the root). */
export const ROOT_PATCH: ParentPatch = { parentSessionId: null, parentConversationId: null }

/** The patch that files a row under `leader`. */
export function parentPatchFor(leader: Pick<TeamRow, 'id' | 'conversationId'>): ParentPatch {
  return { parentSessionId: leader.id, parentConversationId: leader.conversationId ?? null }
}

/** Does `row` name `leader` as its parent — by managed id or by the conversation id that survives a reopen. */
export function namesParent(row: TeamRow, leader: Pick<TeamRow, 'id' | 'conversationId'>): boolean {
  if (row.id === leader.id) return false
  const hit = (v?: string) => !!v && (v === leader.id || (!!leader.conversationId && v === leader.conversationId))
  return hit(row.parentConversationId) || hit(row.parentSessionId)
}

/**
 * The parent link a NEW row is born with. A leader (explicit role, a `--handoff` successor) is born
 * at the root: the session that started it is recorded nowhere in the team link. Everyone else keeps
 * the link the caller resolved. The ONE decision every spawn path routes through.
 */
export function spawnParentLink<L extends { parentSessionId?: string; parentConversationId?: string }>(
  role: 'leader' | 'worker' | undefined,
  link: L,
): Partial<L> {
  if (role === 'leader') return {}
  return link
}

/**
 * The session that now leads where `id` led: follows `handoffTo` from row to row (bounded, cycle-safe)
 * to the newest successor. A row that never handed off is its own answer; an unknown id is returned as is.
 * Used so a worker started by a predecessor AFTER its hand-off still lands in the successor's team.
 */
export function currentLeaderId(rows: readonly TeamRow[], id: string): string {
  const seen = new Set<string>([id])
  let cur = id
  for (let i = 0; i < 16; i++) {
    const row = rows.find(r => r.id === cur)
    const next = row?.handoffTo
    if (!next || seen.has(next)) return cur
    // A successor row reopened since has a new id for the same conversation: follow it there.
    const succ = rows.find(r => r.id === next)
    const live = succ?.endedAt && succ.conversationId
      ? rows.find(r => r.id !== succ.id && !r.endedAt && r.conversationId === succ.conversationId) ?? succ
      : succ
    if (!live) return cur
    seen.add(live.id)
    cur = live.id
  }
  return cur
}

/**
 * Where a message addressed to `id` must go now. Every reopen, takeover and ACCOUNT SWITCH mints a
 * new managed id for the same conversation and retires the old row, so a worker that recorded its
 * leader's id at spawn kept addressing a row that no longer runs (measured 25/10: a worker sat waiting
 * on a parent that had switched accounts). An ENDED (or handed-off) row is followed through its hand-off chain
 * and conversation replacement links in ONE bounded, cycle-safe chain. A replacement may itself
 * have handed off, even if it is now retired. Never guess by directory or name.
 */
export function liveSuccessorOf(rows: readonly TeamRow[], id: string): string {
  const first = rows.find(r => r.id === id) ?? rows.find(r => r.conversationId === id)
  if (!first) return id
  let cur: TeamRow = first
  const seen = new Set<string>()
  for (let i = 0; i < 16; i++) {
    const current: TeamRow = cur
    seen.add(current.id)
    if (current.handoffTo) {
      const next: TeamRow | undefined = rows.find(r => r.id === current.handoffTo)
      if (!next || seen.has(next.id)) return cur.id
      cur = next
      continue
    }
    if (!cur.endedAt || !cur.conversationId) return cur.id
    const replacements = rows.slice(rows.indexOf(current) + 1).filter(r => r.conversationId === current.conversationId && !seen.has(r.id))
    // The registry appends replacement rows. Prefer the newest live owner; an ended replacement
    // with a hand-off still records a continuation we must traverse.
    const next = replacements.findLast(r => !r.endedAt) ?? replacements.findLast(r => !!r.handoffTo)
    if (!next) return cur.id
    cur = next
  }
  return cur.id
}

/** The rows whose team link names the replaced row `oldId` by managed id: they follow its replacement. */
export function childrenOfReplaced(rows: readonly TeamRow[], oldId: string, newId: string): string[] {
  if (!oldId || oldId === newId) return []
  return rows.filter(r => r.id !== newId && r.parentSessionId === oldId).map(r => r.id)
}

export interface HandoffReparent {
  /** Rows to file under the successor (the predecessor's whole team, ended rows included so a reopen follows). */
  children: string[]
  childPatch: ParentPatch
  /** The successor's own patch: it is a leader, so it sits at the root. `undefined` when already there. */
  successorPatch?: ParentPatch
}

/**
 * A hand-off moves the team: every row naming the predecessor names the successor instead. The
 * successor itself is cleared to the root (it may have been born as the predecessor's child by an
 * older build), and the predecessor is never filed under its own successor.
 */
export function planHandoffReparent(
  rows: readonly TeamRow[],
  predecessor: Pick<TeamRow, 'id' | 'conversationId'>,
  successor: Pick<TeamRow, 'id' | 'conversationId'>,
): HandoffReparent {
  const children = rows
    .filter(r => r.id !== successor.id && r.id !== predecessor.id && namesParent(r, predecessor))
    .map(r => r.id)
  const succRow = rows.find(r => r.id === successor.id)
  const atRoot = !succRow?.parentSessionId && !succRow?.parentConversationId
  return {
    children,
    childPatch: parentPatchFor(successor),
    ...(atRoot ? {} : { successorPatch: ROOT_PATCH }),
  }
}

/** A row that becomes a leader leaves its parent's team. `undefined` when it already sits at the root. */
export function planLeaderRoot(row: TeamRow | undefined): ParentPatch | undefined {
  if (!row || (!row.parentSessionId && !row.parentConversationId)) return undefined
  return ROOT_PATCH
}

export type TeamMoveRefusal = 'no_such_session' | 'no_such_leader' | 'not_a_leader' | 'is_leader' | 'same_session' | 'no_leader' | 'already_there'

export type TeamMovePlan = { ok: true; id: string; patch: ParentPatch } | { ok: false; code: TeamMoveRefusal }

/** A refusal (a plan result, never a notification code). */
const refuse = (code: TeamMoveRefusal): TeamMovePlan => ({ ok: false, code })

/**
 * The person's manual move. `leaderId` absent = UNLINK (take it out of its team, to "No leader");
 * present = MOVE into that leader's team. `isLeader` is the role store's answer for a row.
 * A leader is never moved INTO a team (it would be a leader inside a leader — rule 2).
 */
export function planTeamMove(
  rows: readonly TeamRow[],
  sessionId: string,
  leaderId: string | undefined,
  isLeader: (r: TeamRow) => boolean,
): TeamMovePlan {
  const row = rows.find(r => r.id === sessionId)
  if (!row) return refuse('no_such_session')
  if (leaderId === undefined) {
    if (!row.parentSessionId && !row.parentConversationId) return refuse('no_leader')
    return { ok: true, id: row.id, patch: ROOT_PATCH }
  }
  const leader = rows.find(r => r.id === leaderId)
  if (!leader) return refuse('no_such_leader')
  if (leader.id === row.id) return refuse('same_session')
  if (!isLeader(leader)) return refuse('not_a_leader')
  if (isLeader(row)) return refuse('is_leader')
  if (namesParent(row, leader)) return refuse('already_there')
  return { ok: true, id: row.id, patch: parentPatchFor(leader) }
}

/**
 * The row a spawn is about to write, with its team link settled: a LEADER sheds any parent it was
 * handed (by the caller, or inherited from the row a reopen replaces). Returns a copy only when it changes.
 */
export function rootIfLeader<R extends { parentSessionId?: string | undefined; parentConversationId?: string | undefined }>(
  row: R,
  role: 'leader' | 'worker' | undefined,
): R {
  if (role !== 'leader' || (!row.parentSessionId && !row.parentConversationId)) return row
  const { parentSessionId: _s, parentConversationId: _c, ...rest } = row
  return rest as R
}
