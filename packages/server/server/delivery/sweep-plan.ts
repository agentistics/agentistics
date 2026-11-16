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
 * LOOP GUARD: a piece reverted twice inside 24 h is moved to `blocked` (`externo: an unknown writer keeps moving this piece`)
 * instead of being reverted a third time in silence, and the WARN names the escape (`agentop flow guarantee off a`).
 */
import { phaseRank, stageRank, type BoardSlice } from './guard'
/** The slice of a checkpoint the sweep reads (structural: this module imports no store). */
export type GuardAuth = { kind: string; ids?: string[]; sha256?: string[]; [k: string]: unknown }
export interface PieceCheckpointLike { key: string; rank: number; boardStatus: string; phase: string | null; headSha: string | null; auth: GuardAuth[]; [k: string]: unknown }
type PieceCheckpoint = PieceCheckpointLike

export const SWEEP_LOOP_WINDOW_MS = 24 * 3600_000
export const SWEEP_LOOP_LIMIT = 2
/** The one sentence every revert and every loop WARN carries, so a person whose hand edits keep being reverted knows how to stop it. */
export const SWEEP_ESCAPE = 'to stop the sweep from reverting: agentop flow guarantee off a'
export const SWEEP_ESCAPE_PT = 'para o varredor parar de reverter: agentop flow guarantee off a'
export const LOOP_BLOCK_TEXT = `an unknown writer keeps moving this piece (${SWEEP_ESCAPE})`

export type SweepReason = 'above_checkpoint' | 'evidence_stale' | 'no_checkpoint'

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
}
export interface SweepCatchUp { key: string; taskId: string; phase: string }

export interface SweepMemory { reverts: Record<string, string[]>; plans?: Record<string, string>; catchUpFailures?: Record<string, string>; warning?: string }
export const emptyMemory = (): SweepMemory => ({ reverts: {} })

export interface SweepPlan { reverts: SweepRevert[]; catchUps: SweepCatchUp[]; memory: SweepMemory }

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
  const memory: SweepMemory = { reverts: Object.fromEntries(Object.entries(o.memory.reverts).map(([k, v]) => [k, recent(v, o.now)]).filter(([, v]) => (v as string[]).length > 0)) }
  const at = new Date(o.now).toISOString()
  for (const p of o.pieces) {
    const cp = o.checkpoints[p.checkpointKey ?? p.key]
    if (cp && (ownerAuthorized(cp.auth) || (cp.by as { kind?: string } | undefined)?.kind === 'owner')) continue
    const rank = checkpointRank(cp, o.statuses)
    const boardNow = Math.max(p.boardRank, p.ciRank)
    const phaseNow = phaseRank(p.record?.phase)
    let reason: SweepReason | null = null
    let target = rank
    if (boardNow > rank || phaseNow > rank) reason = cp ? 'above_checkpoint' : 'no_checkpoint'
    else if (cp && rank >= 1 && Math.max(boardNow, phaseNow) >= 1 && (staleEvidence(cp, p.authorizationRecord ?? p.record).length > 0 || headMoved(cp, p.authorizationRecord ?? p.record))) { reason = 'evidence_stale'; target = 0 }
    if (!reason) {
      // The board is BELOW what the delivery (and the checkpoint) authorized: finish the board effect that failed. Not a violation.
      const authorized = p.record ?? p.authorizationRecord
      if (!p.derived && cp && rank >= 1 && authorized && phaseRank(authorized.phase) === rank && boardNow < rank) catchUps.push({ key: p.key, taskId: p.taskId, phase: authorized.phase })
      continue
    }
    const board: BoardRevert | undefined = (p.derived ? p.ciRank > target : boardNow > target || p.ciRank > target) && p.boardStatus !== null
      ? { to: boardTarget(cp, target, o.statuses), clearCi: p.ciRank > target }
      : undefined
    const delivery: DeliveryRevert | undefined = p.record && phaseNow > target
      ? { to: reason === 'evidence_stale' ? 'ajuste' : phaseTarget(cp, target, p.record) }
      : undefined
    if (!board && !delivery) continue
    const stamps = [...recent(memory.reverts[p.key], o.now), at]
    memory.reverts[p.key] = stamps
    reverts.push({ key: p.key, taskId: p.taskId, ...(!p.record && p.checkpointKey && p.authorizationRecord ? { deliveryKey: p.checkpointKey } : {}), ...(p.subtaskId ? { subtaskId: p.subtaskId } : {}), reason, ...(board ? { board } : {}), ...(delivery ? { delivery } : {}), ...(stamps.length >= SWEEP_LOOP_LIMIT ? { loop: true } : {}), count: stamps.length })
  }
  return { reverts, catchUps, memory }
}

/** Pure: the pieces the loop guard has stopped inside the window — what health shows as a WARN until they stay quiet for a day. */
export function sweepWarnings(memory: SweepMemory | undefined, now: number): string[] {
  const pieces = Object.entries(memory?.reverts ?? {})
    .filter(([, v]) => recent(v, now).length >= SWEEP_LOOP_LIMIT)
    .map(([key]) => key)
  return [...(pieces.length ? [`sweep-loop: ${pieces.join(', ')} — an unknown writer keeps moving these pieces; um escritor desconhecido continua movendo estas peças; ${SWEEP_ESCAPE}`] : []), ...(memory?.warning ? [memory.warning] : [])]
}

/** Historical maxima cannot authorize a new jump after an authorized retreat. */
export function checkpointRank(cp: Pick<PieceCheckpoint, 'rank' | 'boardStatus' | 'phase'> | undefined, statuses: BoardSlice['statuses']): number {
  if (!cp) return 0
  const status = statuses.find(s => s.id === cp.boardStatus)
  const board = stageRank(status?.stage ?? (cp.boardStatus === 'in_review' ? 'leader' : cp.boardStatus === 'done' ? 'published' : undefined))
  return Math.min(cp.rank, Math.max(board, phaseRank(cp.phase)))
}
