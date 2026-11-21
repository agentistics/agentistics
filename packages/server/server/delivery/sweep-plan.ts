/**
 * delivery/sweep-plan.ts — the PURE half of the guard sweep (ENTREGA.GARANTIDA §2.6, S2b). No IO, no clock.
 *
 * The sweep compares, for EVERY piece (no "changed since" filter, no event needed), what the two documents say now against the
 * piece's durable checkpoint (guards.json). The checkpoint — never the activity feed — is the authority:
 *
 *   - current rank above the checkpoint's, on either document          → REVERT that document to the checkpoint (`above_checkpoint`);
 *   - rank >= 1 and the evidence the checkpoint names is gone, changed bytes, belongs to an earlier capture round, or the
 *     record's verified HEAD moved                                      → REVERT to rank 0 (`evidence_stale`, back to in_progress / ajuste);
 *   - board BELOW the checkpoint while the delivery phase is at it      → CATCH UP the board (never a violation);
 *   - a checkpoint carrying an `owner` (or `override`) authorization    → never reverted, whatever `via` it carries.
 *
 * GROUPS (R5-1..R5-3): a group checkpoint's `members` record is written by the guarded store; the sweep writes only an old group's
 * first one (migration baseline). A baselined group above its checkpoint gets its deleted / moved-out accepted members put back
 * (`member_removed` / `member_moved_out`) and an unaccepted member that lifts it reverted; one that does not is reported.
 *
 * LOOP GUARD: a piece reverted twice inside 24 h is moved to `blocked` (`externo: an unknown writer keeps moving this piece`)
 * instead of being reverted a third time in silence, and the WARN says how to release it.
 */
import { isRealProgressStatus } from '@agentistics/core'
import { phaseRank, stageRank, type BoardSlice } from './guard'
/** The slice of a checkpoint the sweep reads (structural: this module imports no store). */
export type GuardAuth = { kind: string; ids?: string[]; sha256?: string[]; [k: string]: unknown }
/** The board status the guard ACCEPTED for each member of a group (R3-1), written with the group's checkpoint. */
export type AcceptedMembers = Record<string, { status: string; at: string }>
export interface PieceCheckpointLike { key: string; rank: number; boardStatus: string; phase: string | null; headSha: string | null; auth: GuardAuth[]; members?: AcceptedMembers; [k: string]: unknown }
type PieceCheckpoint = PieceCheckpointLike

export const SWEEP_LOOP_WINDOW_MS = 24 * 3600_000
export const SWEEP_LOOP_LIMIT = 2
/**
 * R5-5: a group of an OLD store (no `members` record) that keeps reporting `no_member_baseline` for longer than this — 60 minutes of
 * consecutive reports (a clock, not a tick count) — raises a health WARN. The report alone lived only in a tick's actions and one log line per minute.
 */
export const SWEEP_NO_BASELINE_WARN_MS = 60 * 60_000
/**
 * B2 (r6 re-QA): a member forged above its accepted status and then carried by a GUARDED write stays only REPORTED (`unaccepted_member`;
 * it is reverted only when it lifts its group). Reported for longer than this — 60 MINUTES of consecutive unaccepted reports, a clock and not a tick count — raises a health WARN.
 * Declared residual risk: the report never repairs it, a person does.
 */
export const SWEEP_UNACCEPTED_WARN_MS = 60 * 60_000
/** B1: why a blocked piece (or the group it holds down) stays blocked, and what the person does. One sentence per language. */
export const LOOP_RELEASE = 'a blocked piece stays blocked until a person sets its status back on the board (the sweep never unblocks it); the sweep only reverts raw writes, so move it through the board'
export const LOOP_RELEASE_PT = 'uma peça bloqueada continua bloqueada até uma pessoa devolver o status no quadro (a varredura nunca desbloqueia); a varredura só reverte escritas cruas, então mova pelo quadro'
/** Marks a subtask the sweep RESTORED after a raw delete (B4): never handed out as work; a leader or the owner dismisses it by removing it. */
export const RESTORED_BY_GUARD = 'guard' as const
/** The one sentence every revert and every loop WARN carries, so a person whose hand edits keep being reverted knows how to stop it. */
export const SWEEP_ESCAPE = 'the sweep only reverts raw file writes: make the change through the board, MCP or CLI'
export const SWEEP_ESCAPE_PT = 'a varredura só reverte escritas cruas no arquivo: faça a mudança pelo quadro, MCP ou CLI'
export const LOOP_BLOCK_TEXT = `an unknown writer keeps moving this piece (${SWEEP_ESCAPE})`

export type SweepReason = 'above_checkpoint' | 'evidence_stale' | 'no_checkpoint' | 'member_removed' | 'member_moved_out'

export interface SweepRecord {
  phase: string
  revision: number
  headSha?: string
  evidence?: ReadonlyArray<{ id: string; sha256: string; revision: number }>
  history?: ReadonlyArray<{ to: string; revision: number }>
}

/** One piece, as the two documents show it right now. */
export interface PieceView {
  derived?: boolean
  checkpointKey?: string
  /** The group's effective board rank, judged by the same derivation as the write guard. */
  groupRank?: number
  /** Members inherit their group's evidence, while only their own stored status is repaired. */
  authorizationRecord?: SweepRecord | null
  key: string
  taskId: string
  subtaskId?: string
  /** null: no board entry. */
  boardStatus: string | null
  boardRank: number
  /** The rank the subtask's `ci` signal alone contributes (the Live moves a card on it). */
  ciRank: number
  record: SweepRecord | null
}

export interface BoardRevert { to: string; clearCi: boolean }
export interface DeliveryRevert { to: string }
export interface SweepRevert {
  deliveryKey?: string
  key: string
  taskId: string
  subtaskId?: string
  reason: SweepReason
  /** Both fields are absent when that document is already where the checkpoint says. */
  board?: BoardRevert
  delivery?: DeliveryRevert
  /** The loop guard fired: this revert also blocks the piece. */
  loop?: boolean
  /** How many reverts this piece has had inside the window, this one included. */
  count: number
  /**
   * R5-1: an ACCEPTED member a raw writer deleted or moved out of its group. The board write puts `parentGroupId` back and, for a
   * deleted member, writes a PLACEHOLDER under the same id carrying only what the accepted record holds (id, status, group): the
   * group's status is a pure function of its members, so this is the one way to bring the derived status back to its checkpoint.
   */
  restore?: { parentGroupId: string; /** B3: the GROUP's task — a member moved to another task by a raw writer comes back to this one. */ taskId: string; crossTask?: boolean; placeholder?: { taskId: string; title: string; description: string } }
  /** The views whose signatures must still hold when the chunk applies (default: `key` alone). */
  checkKeys?: string[]
}
export interface SweepCatchUp { key: string; taskId: string; phase: string }

export interface SweepMemory {
  reverts: Record<string, string[]>; plans?: Record<string, string>; catchUpFailures?: Record<string, string>; warning?: string
  /** R5-5: since when each member of an OLD group (no `members` record) has been reported `no_member_baseline`, tick after tick. */
  noBaselineSince?: Record<string, string>
  /** B2: since when each member has been reported `unaccepted_member`, tick after tick (a forge carried by a guarded write). */
  unacceptedSince?: Record<string, string>
  /** R5-1: groups whose accepted members a raw writer removed or moved out, kept as a health WARN for 24 h. */
  memberAlerts?: Record<string, { at: string; text: string; actions?: string[] }>
  /**
   * B4 r2: THE LEDGER of every placeholder the sweep restored — the only authority for "this piece is a placeholder". Written by the
   * sweep (and marked dismissed by the dismissal door) under the guards lock, in the sealed guards.json; the `restoredBy` flag in
   * tasks.json is only a label and is never trusted on its own.
   */
  placeholders?: Record<string, PlaceholderRecord>
  /** B4 r2: pieces carrying `restoredBy: 'guard'` with NO ledger record (a raw write put the mark there): id → first seen, WARNed for 24 h. */
  forgedMarks?: Record<string, string>
  /** Members the OWNER removed through the general door (their group's accepted record still names them): never restored, never reported. */
  ownerRemoved?: Record<string, { groupId: string; at: string }>
  /** Accepted (`done`) members gone from the board with NO owner record (a raw write): id → group and first-seen. Reported every tick; never restored, the group is never raised for it. */
  acceptedMissing?: Record<string, { groupId: string; at: string }>
}
/** One restoration the sweep made: which piece, in which group and task, when, under which random id; `dismissedAt` once a leader/owner removed it. */
export interface PlaceholderRecord { groupId: string; taskId: string; restoredAt: string; restorationId: string; dismissedAt?: string }
/** PURE. The placeholder record that makes a piece a placeholder: present and not dismissed. Anything else is a real piece. */
export const activePlaceholder = (memory: SweepMemory | undefined, id: string): PlaceholderRecord | null => {
  const r = memory?.placeholders?.[id]
  return r && !r.dismissedAt ? r : null
}
export const emptyMemory = (): SweepMemory => ({ reverts: {} })

/** A group whose accepted member statuses should be (re)recorded: its derived rank is inside what its checkpoint authorizes. */
export interface SweepBaseline { key: string; members: AcceptedMembers }
export interface SweepPlan { reverts: SweepRevert[]; catchUps: SweepCatchUp[]; memory: SweepMemory; baselines: SweepBaseline[]; reports: string[] }

export const placeholderTitle = (id: string) => `[${id}] removed by an unknown writer; restored by the guard sweep from the accepted record | removida por um escritor desconhecido; restaurada pela varredura do guarda`
/** B4: what the restored placeholder tells the person (and any worker that opens it). It is NOT work: the task leader or the owner removes it. */
export const PLACEHOLDER_NOTES = 'NOT A TASK: a raw write deleted this subtask and the guard sweep restored an empty placeholder (only its id, status and group) so the group does not close by accident. Nobody should work on it. To dismiss it, the task leader or the owner removes this subtask (the placeholder doors: MCP agentistics_task_subtask with dismissPlaceholder: true and the subtask id; CLI agentop task subtask dismiss <task> <subtask>; REST POST /api/tasks/<task>/subtasks {id, dismissPlaceholder: true}; or the remove button of the board); the guard will not re-create it. | NÃO É TAREFA: uma escrita crua apagou esta subtarefa e a varredura do guarda restaurou um espaço reservado vazio (só id, status e grupo) para o grupo não fechar sem querer. Ninguém deve trabalhar nele. Para dispensar, o líder da tarefa ou o dono remove esta subtarefa (as portas de dispensa: MCP agentistics_task_subtask com dismissPlaceholder: true e o id da subtarefa; CLI agentop task subtask dismiss <tarefa> <subtarefa>; REST POST /api/tasks/<tarefa>/subtasks {id, dismissPlaceholder: true}; ou o botão de remover do quadro); o guarda não a recria.'

const statusRankIn = (statuses: BoardSlice['statuses'], id: string | undefined): number => {
  if (!id) return 0
  const known = statuses.find(s => s.id === id)
  return stageRank(known?.stage ?? (id === 'in_review' ? 'leader' : id === 'done' ? 'published' : undefined))
}

/** A checkpoint authorized by a person: the sweep never judges it. */
export const ownerAuthorized = (auth: readonly GuardAuth[]): boolean => auth.some(a => a.kind === 'owner' || a.kind === 'override')

/** Pure: which of a checkpoint's evidence ids/hashes no longer hold on the record. Empty = all hold (or the checkpoint names none). */
export function staleEvidence(cp: PieceCheckpoint, rec: SweepRecord | null): string[] {
  const named = cp.auth.filter(a => a.kind === 'evidence')
  if (named.length === 0) return []
  const out: string[] = []
  const round = Math.max(0, ...(rec?.history ?? []).filter(h => h.to === 'ajuste').map(h => h.revision))
  for (const a of named) (a.ids ?? []).forEach((id, i) => {
    const item = rec?.evidence?.find(e => e.id === id)
    if (!item) out.push(`${id}: gone`)
    else if (a.sha256?.[i] !== undefined && item.sha256 !== a.sha256[i]) out.push(`${id}: other bytes`)
    else if (item.revision < round) out.push(`${id}: earlier capture round`)
  })
  return out
}

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a)

/** Pure: has the record's verified HEAD moved since the authorization? */
export const headMoved = (cp: PieceCheckpoint, rec: SweepRecord | null): boolean =>
  !!cp.headSha && !!rec?.headSha && !sameSha(cp.headSha, rec.headSha)

/** The board status a revert goes to: the checkpoint's own when it names one at or below its rank, else the status of that rank. */
export function boardTarget(cp: PieceCheckpoint | undefined, rank: number, statuses: BoardSlice['statuses']): string {
  const known = (id: string) => statuses.find(s => s.id === id)
  const rankOf = (id: string) => stageRank(known(id)?.stage ?? (id === 'in_review' ? 'leader' : id === 'done' ? 'published' : undefined))
  if (cp?.boardStatus && known(cp.boardStatus) && rankOf(cp.boardStatus) <= rank) return cp.boardStatus
  if (rank >= 1) { const same = statuses.find(s => stageRank(s.stage) === rank); if (same) return same.id }
  return 'in_progress'
}

/** The delivery phase a revert goes to. The history is the witness: a forged `phase` leaves the last real transition behind it. */
export function phaseTarget(cp: PieceCheckpoint | undefined, rank: number, rec: SweepRecord): string {
  if (cp?.phase && phaseRank(cp.phase) <= rank) return cp.phase
  for (const h of [...(rec.history ?? [])].reverse()) if (phaseRank(h.to) <= rank && h.to !== 'bloqueado') return h.to
  return 'executando'
}

const recent = (stamps: readonly string[] | undefined, now: number) => (stamps ?? []).filter(s => now - Date.parse(s) < SWEEP_LOOP_WINDOW_MS)

export function planSweep(o: { pieces: readonly PieceView[]; checkpoints: Readonly<Record<string, PieceCheckpoint>>; statuses: BoardSlice['statuses']; memory: SweepMemory; now: number }): SweepPlan {
  const reverts: SweepRevert[] = []
  const catchUps: SweepCatchUp[] = []
  const reports: string[] = []
  const memory: SweepMemory = { reverts: Object.fromEntries(Object.entries(o.memory.reverts).map(([k, v]) => [k, recent(v, o.now)]).filter(([, v]) => (v as string[]).length > 0)) }
  const at = new Date(o.now).toISOString()
  const memberAlerts = Object.fromEntries(Object.entries(o.memory.memberAlerts ?? {}).filter(([, v]) => o.now - Date.parse(v.at) < SWEEP_LOOP_WINDOW_MS))
  if (Object.keys(memberAlerts).length) memory.memberAlerts = memberAlerts
  if (o.memory.placeholders && Object.keys(o.memory.placeholders).length) memory.placeholders = o.memory.placeholders
  const forgedMarks = Object.fromEntries(Object.entries(o.memory.forgedMarks ?? {}).filter(([, at]) => o.now - Date.parse(at) < SWEEP_LOOP_WINDOW_MS))
  if (Object.keys(forgedMarks).length) memory.forgedMarks = forgedMarks
  if (o.memory.ownerRemoved && Object.keys(o.memory.ownerRemoved).length) memory.ownerRemoved = o.memory.ownerRemoved
  const acceptedMissing: Record<string, { groupId: string; at: string }> = {}
  const noBaselineSince: Record<string, string> = {}
  const unacceptedSince: Record<string, string> = {}
  // R5-1: a baselined group whose derived rank is above its checkpoint because accepted members were deleted or moved out. Every
  // member left on the board may match what was accepted, so nothing else would repair it: the missing members are put back.
  const byKey = new Map(o.pieces.map(p => [p.key, p] as const))
  const movedOut = new Set<string>()
  // An ACCEPTED (`done`) member that vanished with no owner record was deleted by a raw writer: it can never be restored (done never
  // returns), so it is reported every tick and the group is not touched.
  for (const [key, c] of Object.entries(o.checkpoints)) {
    const byOwner = ownerAuthorized(c.auth) || (c.by as { kind?: string } | undefined)?.kind === 'owner'
    if (!c.members || byOwner) continue
    for (const [id, acc] of Object.entries(c.members)) {
      if (acc.status !== 'done' || o.memory.ownerRemoved?.[id]) continue
      const v = byKey.get(id)
      if (v && v.boardStatus !== null) continue
      reports.push(`sweep report ${id}: accepted_member_missing`)
      acceptedMissing[id] = o.memory.acceptedMissing?.[id] ?? { groupId: key, at }
    }
  }
  if (Object.keys(acceptedMissing).length) memory.acceptedMissing = acceptedMissing
  for (const [key, c] of Object.entries(o.checkpoints)) {
    if (!c.members || ownerAuthorized(c.auth) || (c.by as { kind?: string } | undefined)?.kind === 'owner') continue
    const gv = byKey.get(key)
    if (!gv || gv.boardStatus === null) continue
    const groupNow = gv.boardRank
    if (groupNow <= checkpointRank(c, o.statuses)) continue
    for (const [id, acc] of Object.entries(c.members)) {
      const mv = byKey.get(id)
      if (o.memory.ownerRemoved?.[id]) continue
      if (mv?.checkpointKey === key || (mv && mv.boardStatus === null) || !o.statuses.some(s => s.id === acc.status)) continue
      // Only a member whose accepted status can lower the derived one is restored (a done or a non-real status never can).
      const accRank = statusRankIn(o.statuses, acc.status)
      if (!isRealProgressStatus(acc.status) || acc.status === 'done' || accRank >= groupNow) continue
      // A moved-out member forged above its accepted status comes back at that status; a lower one keeps its own.
      const to = mv && Math.max(mv.boardRank, mv.ciRank) <= accRank ? mv.boardStatus! : acc.status
      if (mv) movedOut.add(id)
      const stamps = [...recent(memory.reverts[id], o.now), at]
      memory.reverts[id] = stamps
      const crossTask = !!mv && mv.taskId !== gv.taskId
      reverts.push({
        key: id, taskId: gv.taskId, subtaskId: id, reason: mv ? 'member_moved_out' : 'member_removed',
        board: { to, clearCi: (mv?.ciRank ?? 0) > statusRankIn(o.statuses, to) },
        restore: { parentGroupId: key, taskId: gv.taskId, ...(crossTask ? { crossTask: true } : {}), ...(mv ? {} : { placeholder: { taskId: gv.taskId, title: placeholderTitle(id), description: PLACEHOLDER_NOTES } }) },
        checkKeys: mv ? [key, id] : [key],
        ...(stamps.length >= SWEEP_LOOP_LIMIT ? { loop: true } : {}), count: stamps.length,
      })
    }
  }
  for (const p of o.pieces) {
    if (movedOut.has(p.key)) continue
    const cp = o.checkpoints[p.checkpointKey ?? p.key]
    if (cp && (ownerAuthorized(cp.auth) || (cp.by as { kind?: string } | undefined)?.kind === 'owner')) continue
    const rank = checkpointRank(cp, o.statuses)
    const boardNow = Math.max(p.boardRank, p.ciRank)
    const phaseNow = phaseRank(p.record?.phase)
    let reason: SweepReason | null = null
    let target = rank
    if (boardNow > rank || phaseNow > rank) reason = cp ? 'above_checkpoint' : 'no_checkpoint'
    else if (cp && rank >= 1 && Math.max(boardNow, phaseNow) >= 1 && (staleEvidence(cp, p.authorizationRecord ?? p.record).length > 0 || headMoved(cp, p.authorizationRecord ?? p.record))) { reason = 'evidence_stale'; target = 0 }
    // Members may advance individually. Only a group whose DERIVED rank exceeds its checkpoint needs member repairs.
    if (p.checkpointKey && (p.groupRank ?? 0) <= rank) reason = null
    // R3-1: a member whose stored status is the one the guard accepted is never the forged one, whatever its group's rank is now.
    const accepted = p.checkpointKey ? cp?.members?.[p.key] : undefined
    if (p.checkpointKey && cp && !accepted && cp.members === undefined) {
      // The migration window: an OLD group with no accepted record at all. Its members are reported, never reverted (R4-3).
      if ((p.groupRank ?? 0) > rank || phaseNow > rank || reason === 'evidence_stale') {
        reports.push(`sweep would-revert ${p.key}: no_member_baseline`)
        noBaselineSince[p.key] = o.memory.noBaselineSince?.[p.key] ?? at
        continue
      }
      reason = null
    } else if (p.checkpointKey && cp && !accepted) {
      // R5-2/R5-3: a group WITH an accepted record and a member it does not name. Only a raw writer creates one: it is reverted when
      // it lifts the group above its checkpoint, otherwise reported every tick. It is never written into the record by the sweep.
      if (!(reason === 'above_checkpoint' && (p.groupRank ?? 0) > rank && boardNow > rank)) {
        reports.push(`sweep report ${p.key}: unaccepted_member`)
        unacceptedSince[p.key] = o.memory.unacceptedSince?.[p.key] ?? at
        continue
      }
    }
    if (accepted && accepted.status !== p.boardStatus && boardNow > statusRankIn(o.statuses, accepted.status)) reason = 'above_checkpoint'
    // Evidence still constrains a recorded member status when the group's authorization is stale.
    if (reason && accepted && accepted.status !== p.boardStatus && cp && rank >= 1
      && (staleEvidence(cp, p.authorizationRecord ?? p.record).length > 0 || headMoved(cp, p.authorizationRecord ?? p.record))) { reason = 'evidence_stale'; target = 0 }
    if (accepted && accepted.status === p.boardStatus) reason = null
    if (!reason) {
      // The board is BELOW what the delivery (and the checkpoint) authorized: finish the board effect that failed. Not a violation.
      // R3-3: only a board below the rank of the board status the checkpoint RECORDED failed to land. A guarded retreat recorded a
      // lower status, and `abandoned` is a decision: neither is ever caught up.
      const authorized = p.record ?? p.authorizationRecord
      if (!p.derived && cp && rank >= 1 && authorized && phaseRank(authorized.phase) === rank && boardNow < rank && boardNow < statusRankIn(o.statuses, cp.boardStatus) && p.boardStatus !== 'abandoned') catchUps.push({ key: p.key, taskId: p.taskId, phase: authorized.phase })
      continue
    }
    // The member's recorded authority is independent of the aggregate rank; stale evidence still lowers it.
    const restore = accepted && reason !== 'evidence_stale' && o.statuses.some(s => s.id === accepted.status) ? accepted.status : undefined
    const board: BoardRevert | undefined = (p.derived ? p.ciRank > target : boardNow > target || p.ciRank > target || !!restore && restore !== p.boardStatus) && p.boardStatus !== null
      ? { to: restore ?? boardTarget(cp, target, o.statuses), clearCi: p.ciRank > target }
      : undefined
    const delivery: DeliveryRevert | undefined = p.record && phaseNow > target
      ? { to: reason === 'evidence_stale' ? 'ajuste' : phaseTarget(cp, target, p.record) }
      : undefined
    if (!board && !delivery) continue
    const stamps = [...recent(memory.reverts[p.key], o.now), at]
    memory.reverts[p.key] = stamps
    reverts.push({ key: p.key, taskId: p.taskId, ...(!p.record && p.checkpointKey && p.authorizationRecord ? { deliveryKey: p.checkpointKey } : {}), ...(p.subtaskId ? { subtaskId: p.subtaskId } : {}), reason, ...(board ? { board } : {}), ...(delivery ? { delivery } : {}), ...(stamps.length >= SWEEP_LOOP_LIMIT ? { loop: true } : {}), count: stamps.length })
  }
  // R5-3: the sweep writes a group's accepted record ONCE, the migration baseline of an old group on a quiet tick. A group that has
  // one is only ever changed by the guarded store (`memberChanges`, in the same write): nothing observed on the board becomes
  // accepted, so a divergent member (lateral, lower or higher) is never consolidated (R5-6).
  const baselines: SweepBaseline[] = []
  const groups = new Map<string, PieceView[]>()
  for (const p of o.pieces) if (p.checkpointKey && p.boardStatus !== null) groups.set(p.checkpointKey, [...(groups.get(p.checkpointKey) ?? []), p])
  for (const [key, ms] of groups) {
    const c = o.checkpoints[key]
    if (!c || c.members !== undefined || ownerAuthorized(c.auth) || (c.by as { kind?: string } | undefined)?.kind === 'owner') continue
    if ((ms[0]!.groupRank ?? 0) > checkpointRank(c, o.statuses)) continue
    if (reverts.some(r => ms.some(m => m.key === r.key)) || reports.some(r => ms.some(m => r.startsWith(`sweep would-revert ${m.key}:`)))) continue
    baselines.push({ key, members: Object.fromEntries(ms.map(m => [m.key, { status: m.boardStatus!, at }])) })
  }
  if (Object.keys(noBaselineSince).length) memory.noBaselineSince = noBaselineSince
  if (Object.keys(unacceptedSince).length) memory.unacceptedSince = unacceptedSince
  return { reverts, catchUps, memory, baselines, reports }
}

/** Per-kind guidance for every sweep WARN (r3): none of them points at turning the whole guard off. */
export const GUIDE_FORGED_MARK = 'Nothing to do: the forged restoredBy flag is removed on the next guarded write and the piece is a real piece meanwhile.'
export const GUIDE_LOOP = 'A person sets the blocked piece back on the board (the sweep never unblocks it); find out which writer keeps moving it.'
export const GUIDE_BREAKER = 'The sweep is report-only until the burst stops; find which writer rewrote the board in bulk, then repair the listed pieces.'
export const GUIDE_MEMBER_RESTORED = 'The sweep restores the member from the accepted record; if the empty placeholder is not wanted, the task leader or the owner dismisses it (agentop task subtask dismiss <task> <subtask> / MCP agentistics_task_subtask dismissPlaceholder).'
export const GUIDE_NO_BASELINE = 'Repair the group by hand: compare its members with what was accepted; the sweep only reports this old group.'
export const GUIDE_UNACCEPTED = 'Check the member and set its status back by hand; the sweep never reverts it unless it lifts its group. If it is an empty placeholder, dismiss it (agentop task subtask dismiss <task> <subtask>).'
export const GUIDE_ACCEPTED_MISSING = 'Only the owner may remove an accepted piece: find which raw writer deleted it. Nothing is restored automatically.'

/** A health WARN with a STRUCTURED id (B6): the id is built from data (group id + action), never parsed back out of the text. */
export interface SweepIssue { id: string; title: string; text: string; guide: string }

/**
 * Pure: what health shows as a WARN — the pieces the loop guard has stopped inside the window (until they stay quiet for a day), the
 * groups whose accepted members a raw writer removed or moved out (R5-1, 24 h), old-store members reported `no_member_baseline`
 * for longer than `SWEEP_NO_BASELINE_WARN_MS` (R5-5) and members reported `unaccepted_member` for longer than `SWEEP_UNACCEPTED_WARN_MS` (B2).
 */
export function sweepIssues(memory: SweepMemory | undefined, now: number): SweepIssue[] {
  const pieces = Object.entries(memory?.reverts ?? {})
    .filter(([, v]) => recent(v, now).length >= SWEEP_LOOP_LIMIT)
    .map(([key]) => key)
  const stuck = Object.entries(memory?.noBaselineSince ?? {}).filter(([, since]) => now - Date.parse(since) >= SWEEP_NO_BASELINE_WARN_MS).map(([key]) => key)
  const unaccepted = Object.entries(memory?.unacceptedSince ?? {}).filter(([, since]) => now - Date.parse(since) >= SWEEP_UNACCEPTED_WARN_MS).map(([key]) => key)
  const forged = Object.entries(memory?.forgedMarks ?? {}).filter(([, at]) => now - Date.parse(at) < SWEEP_LOOP_WINDOW_MS).map(([id]) => id)
  const missing = Object.entries(memory?.acceptedMissing ?? {})
  return [
    ...forged.map(id => ({ id: `sweep-forged-restore-mark:${id}`, title: `A subtask carries a guard restoration mark the sweep never made / Uma subtarefa traz uma marca de restauração que a varredura nunca fez`, guide: GUIDE_FORGED_MARK,
      text: `sweep forged_restore_mark: ${id} — it is marked restoredBy: guard but the sweep's own ledger has no restoration for it, so it is treated as a REAL piece (normal rules, never dismissed as a placeholder) and the mark is removed on the next guarded write. Ela está marcada restoredBy: guard mas o livro da varredura não tem restauração para ela: é tratada como peça REAL e a marca é removida na próxima escrita guardada. ${SWEEP_ESCAPE}` })),
    ...(pieces.length ? [{ id: 'sweep-loop', title: 'The delivery sweep blocked repeated external moves', guide: GUIDE_LOOP,
      text: `sweep-loop: ${pieces.join(', ')} — an unknown writer keeps moving these pieces; um escritor desconhecido continua movendo estas peças; ${LOOP_RELEASE} | ${LOOP_RELEASE_PT}` }] : []),
    ...(memory?.warning ? [{ id: 'sweep-breaker', title: 'The delivery sweep breaker tripped / O disjuntor da varredura disparou', guide: GUIDE_BREAKER, text: memory.warning }] : []),
    ...Object.entries(memory?.memberAlerts ?? {}).filter(([, v]) => now - Date.parse(v.at) < SWEEP_LOOP_WINDOW_MS).map(([group, v]) => ({
      id: `sweep-members:${group}:${[...new Set(v.actions ?? [])].sort().join('+') || 'restored'}`,
      title: `The delivery sweep restored members of group ${group}`, guide: GUIDE_MEMBER_RESTORED, text: v.text,
    })),
    ...(stuck.length ? [{ id: 'sweep-no-member-baseline', title: 'A delivery group forged before the guard was turned on is only reported', guide: GUIDE_NO_BASELINE,
      text: `sweep no_member_baseline: ${stuck.join(', ')} — a group forged before the guard was turned on is only reported, never repaired; repair it by hand. Um grupo forjado antes de ligar a guarda é só relatado, nunca reparado; repare à mão. ${SWEEP_ESCAPE}` }] : []),
    ...missing.map(([id, m]) => ({ id: `sweep-accepted-member-missing:${id}`, title: `An accepted member of group ${m.groupId} disappeared from the board / Um membro aceito do grupo ${m.groupId} sumiu do quadro`, guide: GUIDE_ACCEPTED_MISSING,
      text: `sweep accepted_member_missing: ${id} — an accepted (done) member of group ${m.groupId} was deleted by an unknown writer; it is never restored (done never returns) and the group is not raised because of it. Um membro aceito (done) do grupo ${m.groupId} foi apagado por um escritor desconhecido; ele não é restaurado e o grupo não sobe por causa disso. Only the owner may remove an accepted piece | só o dono pode remover uma peça aceita.` })),
    ...(unaccepted.length ? [{ id: 'sweep-unaccepted-member', title: 'A group member nobody accepted keeps being reported', guide: GUIDE_UNACCEPTED,
      text: `sweep unaccepted_member: ${unaccepted.join(', ')} — a member a raw writer created or forged (and a guarded write then carried) has been reported for over an hour; it is never reverted unless it lifts its group, so a person must check and repair it by hand. Um membro criado ou forjado por escritor cru (e depois carregado por escrita guardada) é relatado há mais de uma hora; só é revertido se levantar o grupo, então uma pessoa deve conferir e reparar à mão. ${SWEEP_ESCAPE}` }] : []),
  ]
}

/** The same warnings as plain text (for callers and tests that only read sentences). */
export const sweepWarnings = (memory: SweepMemory | undefined, now: number): string[] => sweepIssues(memory, now).map(i => i.text)

/** Historical maxima cannot authorize a new jump after an authorized retreat. */
export function checkpointRank(cp: Pick<PieceCheckpoint, 'rank' | 'boardStatus' | 'phase'> | undefined, statuses: BoardSlice['statuses']): number {
  if (!cp) return 0
  const status = statuses.find(s => s.id === cp.boardStatus)
  const board = stageRank(status?.stage ?? (cp.boardStatus === 'in_review' ? 'leader' : cp.boardStatus === 'done' ? 'published' : undefined))
  return Math.min(cp.rank, Math.max(board, phaseRank(cp.phase)))
}
