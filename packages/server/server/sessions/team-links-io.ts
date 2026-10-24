/**
 * team-links-io.ts — the writes behind `team-links.ts` (pure). Three gestures:
 *
 *  - `completeLeaderHandoff`: after a `--handoff` successor exists — link both rows, move the
 *    predecessor's whole team to the successor, keep the successor at the root, and ask the server
 *    to RETIRE the predecessor once it goes quiet (the predecessor is usually the caller, mid-tool-call,
 *    so it cannot be killed on the spot; `retire-runner.ts` carries it out, and cancels it if the
 *    successor dies). Never unpins anything.
 *  - `leaveTeamAsLeader`: a session declared leader leaves its parent's team.
 *  - `moveTeam`: the person's manual "unlink" / "move to <leader>'s team".
 */

import { readRegistry, patchSession, patchSessions } from './registry'
import { currentLeaderId, planHandoffReparent, planLeaderRoot, planTeamMove, type TeamMovePlan, type TeamRow } from './team-links'
import { planRetireRequest } from './retire-plan'
import type { ManagedSession } from './types'
import type { CapturedRelay } from './handoff-relay-io'

export interface HandoffDeps {
  read: () => Promise<readonly ManagedSession[]>
  patch: (id: string, patch: Parameters<typeof patchSession>[1]) => Promise<boolean>
  patchMany: (ids: readonly string[], patch: Parameters<typeof patchSessions>[1]) => Promise<number>
  recordLink: (parentId: string, childId: string, captured: CapturedRelay | undefined, parentSeq?: number) => Promise<void>
  now: () => number
}

const defaultHandoffDeps = async (): Promise<HandoffDeps> => ({
  read: readRegistry,
  patch: patchSession,
  patchMany: patchSessions,
  recordLink: (await import('./handoff-relay-io')).recordHandoffLink,
  now: Date.now,
})

export interface HandoffOutcome {
  /** Rows moved into the successor's team. */
  moved: number
  /** A retire request was written on the predecessor. */
  retireRequested: boolean
}

/** Everything a hand-off settles once the successor row exists. Never throws. */
export async function completeLeaderHandoff(
  predecessorId: string,
  successorId: string,
  captured: CapturedRelay | undefined,
  predecessorSeq: number | undefined,
  deps?: HandoffDeps,
): Promise<HandoffOutcome> {
  const d = deps ?? await defaultHandoffDeps()
  await d.recordLink(predecessorId, successorId, captured, predecessorSeq).catch(() => {})
  const rows = await d.read().catch(() => [] as ManagedSession[])
  const pred = rows.find(r => r.id === predecessorId)
  const succ = rows.find(r => r.id === successorId)
  if (!pred || !succ) return { moved: 0, retireRequested: false }
  const plan = planHandoffReparent(rows, pred, succ)
  const moved = plan.children.length ? await d.patchMany(plan.children, plan.childPatch).catch(() => 0) : 0
  if (plan.successorPatch) await d.patch(successorId, plan.successorPatch).catch(() => false)
  let retireRequested = false
  if (!pred.endedAt) {
    const req = planRetireRequest(pred.retire, { by: successorId, successorId }, d.now())
    if (req.ok) retireRequested = await d.patch(predecessorId, { retire: req.request }).catch(() => false)
  }
  return { moved, retireRequested }
}

/**
 * The parent a NEW worker should be filed under: the caller, or — when the caller has since handed
 * off — its current successor (a predecessor still finishing its turn must not grow a second team).
 */
export function teamParentOf(rows: readonly TeamRow[], callerId: string): string {
  return currentLeaderId(rows, callerId)
}

/** A session that has just become a leader leaves its parent's team. Never throws. */
export async function leaveTeamAsLeader(
  rowId: string,
  read: () => Promise<readonly ManagedSession[]> = readRegistry,
  patch: (id: string, p: Parameters<typeof patchSession>[1]) => Promise<boolean> = patchSession,
): Promise<boolean> {
  try {
    const p = planLeaderRoot((await read()).find(r => r.id === rowId))
    return p ? await patch(rowId, p) : false
  } catch { return false }
}

/** The person's manual move; the plan's refusal is returned as is. */
export async function moveTeam(
  sessionId: string,
  leaderId: string | undefined,
  isLeader: (r: TeamRow) => boolean,
  read: () => Promise<readonly ManagedSession[]> = readRegistry,
  patch: (id: string, p: Parameters<typeof patchSession>[1]) => Promise<boolean> = patchSession,
): Promise<TeamMovePlan> {
  const plan = planTeamMove(await read(), sessionId, leaderId, isLeader)
  if (!plan.ok) return plan
  // The row vanished between the read and the write: the same answer as never having found it.
  return (await patch(plan.id, plan.patch)) ? plan : planTeamMove([], sessionId, leaderId, isLeader)
}

const TEAM_MESSAGES: Record<string, { en: string; pt: string }> = {
  person_only: { en: 'Only the person moves a session between teams.', pt: 'Só a pessoa move uma sessão entre equipes.' },
  missing_argument: { en: 'A session id is required.', pt: 'Falta o id da sessão.' },
  no_such_session: { en: 'No session on this machine has that id.', pt: 'Nenhuma sessão desta máquina tem esse id.' },
  no_such_leader: { en: 'That leader is not on this machine.', pt: 'Esse líder não está nesta máquina.' },
  not_a_leader: { en: 'The target is not a leader.', pt: 'O destino não é um líder.' },
  is_leader: { en: 'A leader stays at the top with the other leaders; it is never part of another leader\'s team.', pt: 'Um líder fica no topo com os outros líderes; nunca entra na equipe de outro líder.' },
  same_session: { en: 'A session cannot join its own team.', pt: 'Uma sessão não entra na própria equipe.' },
  no_leader: { en: 'This session is not in any team.', pt: 'Esta sessão não está em nenhuma equipe.' },
  already_there: { en: 'This session is already in that team.', pt: 'Esta sessão já está nessa equipe.' },
}

export type TeamOpReply = { ok: true; id: string; leader: string | null; message: string } | { ok: false; code: string; message: string }

/**
 * `POST /api/session-team` — `{ id, leader?: string | null, lang? }`. `leader` absent or null = take the
 * session OUT of its team; a leader id = move it INTO that leader's team. The PERSON's gesture only: a
 * body carrying a session proof is refused (a session that wants a worker starts one).
 */
export async function teamOp(
  body: { id?: unknown; leader?: unknown; lang?: unknown; session?: unknown },
  deps: {
    isLeader: (r: TeamRow) => Promise<boolean> | boolean
    read?: () => Promise<readonly ManagedSession[]>
    patch?: (id: string, p: Parameters<typeof patchSession>[1]) => Promise<boolean>
  },
): Promise<{ status: number; reply: TeamOpReply }> {
  const pt = body.lang === 'pt'
  const say = (code: string) => (pt ? TEAM_MESSAGES[code]?.pt : TEAM_MESSAGES[code]?.en) ?? code
  const fail = (status: number, code: string) => ({ status, reply: { ok: false as const, code, message: say(code) } })
  if ('session' in body) return fail(403, 'person_only')
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return fail(400, 'missing_argument')
  const leader = typeof body.leader === 'string' && body.leader.trim() ? body.leader.trim() : undefined
  const read = deps.read ?? readRegistry
  const rows = await read()
  const leaders = new Set<string>()
  for (const r of rows) if (await deps.isLeader(r)) leaders.add(r.id)
  const plan = await moveTeam(id, leader, r => leaders.has(r.id), async () => rows, deps.patch ?? patchSession)
  if (!plan.ok) return fail(plan.code === 'no_such_session' || plan.code === 'no_such_leader' ? 404 : 409, plan.code)
  const msg = leader
    ? (pt ? 'Sessão movida para a equipe.' : 'Session moved to the team.')
    : (pt ? 'Sessão tirada da equipe.' : 'Session taken out of its team.')
  return { status: 200, reply: { ok: true, id: plan.id, leader: leader ?? null, message: msg } }
}

/** The role store's answer (stored `leader`, or a title wearing the leader prefix — the aside's own rule). */
export async function defaultIsLeader(): Promise<(r: TeamRow & { label?: string | undefined }) => boolean> {
  const { defaultRoleDeps, loadRoles, roleOfRow } = await import('./session-roles')
  const { hasRolePrefix } = await import('@agentistics/core')
  const roles = (await loadRoles(await defaultRoleDeps())).roles
  return r => {
    const stored = roleOfRow(roles, r)
    return stored ? stored === 'leader' : hasRolePrefix(r.label ?? '')
  }
}
