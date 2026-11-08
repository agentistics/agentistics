/**
 * delivery/ciclo.ts — PURE. FLUXO.CICLO-COMPLETO (owner 07/11 ~20Z: "o ciclo de vida das entregas não está 100% do início ao
 * fim"): no stage after the leader's review may depend on someone remembering.
 *
 *   revisao_lider / pr_merge → ci      the tick FINDS the merged PR (gates `delecoes` + `mergeado` still apply)
 *   ci → publicado                     the tick reads the first tag that contains the merge (the r3 `release` gate)
 *   anything still waiting on a person the tick reminds the LIVE leader of the task: 30 min after the piece started waiting,
 *                                      then every 2 h, at most 3 times per phase/revision. Never the owner.
 *
 * This module decides WHEN; `service.ts` performs it. It reads only the record and the clock.
 */
import type { DeliveryRecord, Phase } from './machine'

export const REVIEW_NUDGE_FIRST_MS = 30 * 60_000
export const REVIEW_NUDGE_EVERY_MS = 2 * 3600_000
export const REVIEW_NUDGE_MAX = 3
/** A reminder that reached nobody (no live leader) is retried at the first-reminder cadence, never every minute. */
export const REVIEW_NUDGE_RETRY_MS = REVIEW_NUDGE_FIRST_MS

/** Merge detection polls gh with a back-off: a tenth of the time in the phase, between 1 and 10 minutes. */
export const MERGE_POLL_MIN_MS = 60_000
export const MERGE_POLL_MAX_MS = 10 * 60_000
/** At most this many pieces are looked up per tick (oldest look-up first); the rest come on the next ticks. */
export const MERGE_SCAN_PER_TICK = 10

export const MERGE_PHASES: readonly Phase[] = ['revisao_lider', 'pr_merge']

/** PURE. When the piece entered its current phase (the last history entry), else when the record was made. */
export function phaseEnteredMs(r: Pick<DeliveryRecord, 'history' | 'createdAt' | 'phase'>): number {
  const last = [...r.history].reverse().find(h => h.to === r.phase)
  const at = Date.parse(last?.at ?? r.createdAt)
  return Number.isFinite(at) ? at : NaN
}

/** PURE. The tick's note is about THIS phase and revision (an older one is stale and says nothing). */
export function currentNote(r: DeliveryRecord): DeliveryRecord['tickNote'] | undefined {
  return r.tickNote && r.tickNote.phase === r.phase && r.tickNote.revision === r.revision ? r.tickNote : undefined
}

/**
 * PURE. Is the piece waiting on its LEADER? Always in revisao_lider (the review, or a merge the flow has not seen yet); in
 * pr_merge / ci only once the tick recorded a gate that REFUSED (a merge-gate refusal, a red release run) — "the tag does not
 * exist yet" is the release's own time, not the leader's.
 */
export function waitingOnLeader(r: DeliveryRecord): boolean {
  if (r.dequeued) return false
  if (r.phase === 'revisao_lider') return true
  if (r.phase === 'pr_merge' || r.phase === 'ci') return currentNote(r)?.failed === true
  return false
}

/** PURE. The clock of a waiting piece: its phase entry, restarted by the leader's last action on it. */
export function waitingSinceMs(r: DeliveryRecord): number {
  const entered = phaseEnteredMs(r)
  const touched = Date.parse(r.leaderTouchedAt ?? '')
  return Number.isFinite(touched) && (!Number.isFinite(entered) || touched > entered) ? touched : entered
}

export interface ReviewNudgeDue { subtaskId: string; taskId: string; phase: Phase; ageMs: number; sent: number; reason: string | null }

/**
 * PURE. The pieces whose reminder is due now: waiting on the leader for ≥ 30 min, the previous reminder ≥ 2 h ago (a failed
 * attempt waits 30 min), fewer than 3 sent for this phase/revision.
 */
export function planReviewNudges(records: readonly DeliveryRecord[], nowMs: number): ReviewNudgeDue[] {
  const out: ReviewNudgeDue[] = []
  for (const r of records) {
    if (!waitingOnLeader(r)) continue
    const since = waitingSinceMs(r)
    if (!Number.isFinite(since)) continue
    const age = nowMs - since
    if (age < REVIEW_NUDGE_FIRST_MS) continue
    // A red release the leader was already told about (`releaseFailNotice`) counts as the first reminder: the next one is 2 h later.
    const n = r.reviewNudge && r.reviewNudge.phase === r.phase && r.reviewNudge.revision === r.revision ? r.reviewNudge
      : r.phase === 'ci' && r.releaseFailNotice ? { sent: 1, lastAt: r.releaseFailNotice.at }
      : { sent: 0 } as { sent: number; lastAt?: string; lastAttemptAt?: string }
    if (n.sent >= REVIEW_NUDGE_MAX) continue
    const lastSent = Date.parse(n.lastAt ?? '')
    const lastTry = Date.parse(n.lastAttemptAt ?? '')
    if (Number.isFinite(lastSent) && nowMs - lastSent < REVIEW_NUDGE_EVERY_MS) continue
    if (Number.isFinite(lastTry) && (!Number.isFinite(lastSent) || lastTry > lastSent) && nowMs - lastTry < REVIEW_NUDGE_RETRY_MS) continue
    out.push({ subtaskId: r.subtaskId, taskId: r.taskId, phase: r.phase, ageMs: age, sent: n.sent, reason: currentNote(r)?.reason ?? null })
  }
  return out
}

/** PURE. Is a merge look-up due for this piece (back-off from the last note in this phase)? */
export function mergeScanDue(r: DeliveryRecord, nowMs: number): boolean {
  if (r.dequeued || !MERGE_PHASES.includes(r.phase)) return false
  const note = currentNote(r)
  if (!note) return true
  const last = Date.parse(note.at)
  if (!Number.isFinite(last)) return true
  const entered = phaseEnteredMs(r)
  const backoff = Math.min(MERGE_POLL_MAX_MS, Math.max(MERGE_POLL_MIN_MS, Number.isFinite(entered) ? (nowMs - entered) / 10 : 0))
  return nowMs - last >= backoff
}

/** PURE. The order merge look-ups run in: never looked up first, then the oldest look-up. */
export function mergeScanOrder(a: DeliveryRecord, b: DeliveryRecord): number {
  const at = (r: DeliveryRecord) => { const n = currentNote(r); return n ? Date.parse(n.at) || 0 : -1 }
  return at(a) - at(b) || a.subtaskId.localeCompare(b.subtaskId)
}

/** One line of `agentop flow reconcile --release`: what moved, or what could not be proven and why. */
export interface ReconcileEntry {
  subtaskId: string
  taskId: string
  title?: string
  from: Phase
  /** Where the piece goes (or went, with `apply`). Absent = it stays: `reason` says why. */
  to?: Phase
  pr?: number
  mergeSha?: string
  tag?: string
  via?: string
  reason?: string
  /** The repository of the proof PR when it is not the public one (an engine PR). */
  repo?: string
  /** `to: 'ci'` only: the first release run is red (it will not publish) vs not finished/tagged yet. */
  releaseGate?: 'red' | 'pending'
  /** No proof and nothing alive: the piece leaves "Revisão do líder" for the collapsed group "Antigas sem registro". */
  bucket?: 'antiga'
  /** `apply` only: the write happened (false = refused: `reason`). */
  applied?: boolean
}

/** PURE. The report's one-line rendering (CLI). */
export function reconcileLine(e: ReconcileEntry): string {
  const what = e.to ? `${e.from} → ${e.to}${e.releaseGate === 'red' ? ' (release vermelha)' : ''}` : e.bucket === 'antiga' ? `${e.from} → antigas` : `${e.from} (fica)`
  const facts = [e.pr ? `PR #${e.pr}` : '', e.mergeSha ? e.mergeSha.slice(0, 9) : '', e.tag ?? ''].filter(Boolean).join(' ')
  const state = e.applied === undefined ? '' : e.applied ? ' ✔' : ' ✘'
  return `${e.subtaskId}\t${what}${state}${facts ? `\t${facts}` : ''}${e.reason ? `\t${e.reason}` : ''}`
}
