/**
 * WHEN A SESSION ASKED TO RETIRE MAY BE ENDED — pure (ATOMIC SPAWN spec §2.2).
 *
 * A retire request (`ManagedSession.retire`) is a stored wish, never a wait in the caller: the
 * session asked to retire is usually the caller itself, mid-tool-call. The server's hub evaluates
 * every pending request on each of ITS polls (`retire-runner.ts`) through `decideRetire`, and ends
 * the session only when ALL of these hold:
 *
 * - the row is `waiting` — not `working`, not `waiting-approval` (a person is being asked something;
 *   killing it would answer for them) — CONFIRMED on two consecutive polls (the `event-plan.ts`
 *   rule: one poll of stillness is a repaint, not a turn end) and for at least `quietForMs`;
 * - no background task is still unsettled in its transcript (`bgTasksRunning === 0`; an unreadable
 *   count is unknown, and unknown is never quiet);
 * - no WORK child runs in the pane's process tree (`work-children.ts`). A harness whose tree was
 *   never measured or whose EMPTY answer is not yet TRUSTED
 *   (`WORK_CHILDREN_TRUSTED`) does not block — a child it does see still does — the decision carries a note saying children were not
 *   checked, so the result never claims a quiet it did not observe;
 *   A failed probe on a trusted harness blocks retirement until it can be read.
 * - the successor (a hand-off) is still alive — a successor that died CANCELS the request, so a task
 *   is never left without its leader.
 *
 * - NOTHING LIVE HOLDS it. A session something live is using is idle between turns, so its activity says nothing
 *   about whoever is on the other side (a leader handed over mid-use and the owner lost what they said). A hold
 *   HOLDS the retire — before the quiet checks, and past the deadline too: at the deadline a held request is not
 *   expired and never killed, the runner extends the deadline (`extendedDeadline`) and reports it. A hold state
 *   that could not be read is unknown, and unknown is never quiet. What holds it is said by the engine, not here.
 *
 * At or past `deadlineAt` a plain request is never killed: it EXPIRES with the reasons in words. A
 * HAND-OFF (a request naming a successor) is the exception (LIDER.PASSAGEM): its deadline is at most
 * `HANDOFF_DEADLINE_MS` after the request, and past it — with the successor confirmed alive — the
 * predecessor is closed whatever it is doing (`forced`), because the successor already holds the task.
 * A row that is no longer running has nothing to kill and is simply filed as retired.
 */
import type { HoldObservation } from '@agentistics/engine-api'

import type { RetireRequest, SessionActivity } from './types'
import type { ProcNode, WorkChildrenResult } from './work-children'

/** Two foreground hub intervals; also enforced for stored requests by the runner. */
export const MIN_QUIET_FOR_MS = 10_000
export const DEFAULT_QUIET_FOR_MS = 60_000
export const DEFAULT_DEADLINE_MS = 30 * 60_000
/**
 * LIDER.PASSAGEM — the HARD deadline of a hand-off (a request naming a successor). Past it, with the
 * successor confirmed alive, the predecessor is closed whatever it is doing: a leader is nudged by
 * watchers and messages all the time, so "wait until it goes quiet" never ended (55 of 59 real
 * hand-off requests expired, every old leader was closed by hand). It also CAPS an older request
 * stored with the 30-minute default (`effectiveDeadline`).
 */
export const HANDOFF_DEADLINE_MS = 10 * 60_000

/** The deadline that binds: a hand-off never waits longer than `HANDOFF_DEADLINE_MS` from its request. */
export function effectiveDeadline(req: RetireRequest): number {
  const stored = Date.parse(req.deadlineAt)
  if (!req.successorId || req.holdExtendedAt) return stored
  const cap = Date.parse(req.requestedAt) + HANDOFF_DEADLINE_MS
  return Number.isFinite(cap) ? Math.min(stored, cap) : stored
}
/** Polls of `waiting` in a row before it counts — the `event-plan.ts` confirmation. */
export const CONFIRM_POLLS = 2
/** How long a retire held by a hold is given after the hold ends, once its deadline has come. */
export const HOLD_GRACE_MS = 5 * 60_000

/** Consecutive polls that observed `waiting`, and since when. Kept in memory by the runner. */
export interface QuietStreak {
  /** `polledAtMs` of the FIRST poll of the streak. */
  readonly since: number
  readonly polls: number
  /** `polledAtMs` of the last poll counted — the same snapshot twice is one poll. */
  readonly lastPollMs: number
}

/** Advance a streak by one poll. Anything but `waiting` breaks it. */
export function nextStreak(prev: QuietStreak | null, activity: SessionActivity | undefined, polledAtMs: number): QuietStreak | null {
  if (activity !== 'waiting') return null
  if (!prev) return { since: polledAtMs, polls: 1, lastPollMs: polledAtMs }
  if (polledAtMs <= prev.lastPollMs) return prev
  return { since: prev.since, polls: prev.polls + 1, lastPollMs: polledAtMs }
}

export interface RetireObservation {
  /** The row is running (status `running`, activity not `exited`). */
  readonly running: boolean
  readonly activity?: SessionActivity
  readonly streak: QuietStreak | null
  /** Unsettled background tasks; `null` = could not be read (or not read yet). */
  readonly bgTasksRunning: number | null
  /** The pane's work children; `null` = not read yet. */
  readonly children: WorkChildrenResult | null
  /** `WORK_CHILDREN_TRUSTED[harness]`: may an empty answer be believed? */
  readonly childrenTrusted: boolean
  /** `null` when the request names no successor. */
  readonly successorAlive: boolean | null
  /** What holds the row. Absent = `none` (no engine, or an engine without holds). */
  readonly hold?: HoldObservation
}

export type { HoldObservation }

export type RetireReason =
  | { readonly code: 'in-use'; readonly since: number; readonly sentence: { readonly en: string; readonly pt: string } }
  | { readonly code: 'hold-unknown' }
  | { readonly code: 'working' }
  | { readonly code: 'waiting-approval' }
  | { readonly code: 'activity-unknown' }
  | { readonly code: 'not-confirmed'; readonly polls: number }
  | { readonly code: 'quiet-too-short'; readonly quietMs: number; readonly wantMs: number }
  | { readonly code: 'bg-tasks'; readonly count: number }
  | { readonly code: 'bg-unknown' }
  | { readonly code: 'children-unreadable' }
  | { readonly code: 'successor-unknown' }
  | { readonly code: 'work-child'; readonly children: readonly ProcNode[] }

export type RetireNote = { readonly code: 'children-unchecked'; readonly why: 'unmeasured' | 'unreadable' | 'untrusted' }

export type RetireDecision =
  /** An expired request, or no request: nothing to do, ever. */
  | { readonly action: 'none' }
  | { readonly action: 'wait'; readonly reasons: readonly RetireReason[]; readonly notes: readonly RetireNote[] }
  /** `kill: false` = the row already stopped on its own; only the filing is left. `forced` = a
   *  hand-off past its hard deadline, closed with `reasons` still standing (LIDER.PASSAGEM). */
  | { readonly action: 'retire'; readonly kill: boolean; readonly notes: readonly RetireNote[]; readonly forced?: true; readonly reasons?: readonly RetireReason[] }
  | { readonly action: 'expire'; readonly reasons: readonly RetireReason[]; readonly notes: readonly RetireNote[] }
  | { readonly action: 'cancel'; readonly reason: 'successor-dead' }

/** The activity half: is this row quiet enough for the expensive probes to be worth running? */
export function activityReasons(req: RetireRequest, obs: Pick<RetireObservation, 'activity' | 'streak'>): RetireReason[] {
  if (obs.activity === 'working') return [{ code: 'working' }]
  if (obs.activity === 'waiting-approval') return [{ code: 'waiting-approval' }]
  if (obs.activity !== 'waiting') return [{ code: 'activity-unknown' }]
  const s = obs.streak
  if (!s || s.polls < CONFIRM_POLLS) return [{ code: 'not-confirmed', polls: s?.polls ?? 0 }]
  const quietMs = s.lastPollMs - s.since
  if (quietMs < req.quietForMs) return [{ code: 'quiet-too-short', quietMs, wantMs: req.quietForMs }]
  return []
}

export function decideRetire(req: RetireRequest | undefined, obs: RetireObservation, now: number): RetireDecision {
  if (!req || req.expiredAt) return { action: 'none' }
  if (!obs.running) return { action: 'retire', kill: false, notes: [] }
  if (obs.successorAlive === false) return { action: 'cancel', reason: 'successor-dead' }

  // A hold outranks everything: nothing else about the row matters while something live uses it, and the
  // expensive probes below are not worth running.
  const holdWhy = holdReasons(obs.hold)
  if (holdWhy.length > 0) return { action: 'wait', reasons: holdWhy, notes: [] }

  const reasons = activityReasons(req, obs)
  const notes: RetireNote[] = []
  if (req.successorId && obs.successorAlive === null) reasons.push({ code: 'successor-unknown' })
  if (reasons.length === 0) {
    if (obs.bgTasksRunning === null) reasons.push({ code: 'bg-unknown' })
    else if (obs.bgTasksRunning > 0) reasons.push({ code: 'bg-tasks', count: obs.bgTasksRunning })
    const c = obs.children
    if (obs.childrenTrusted && (c === null || (!c.checked && c.reason === 'unreadable'))) reasons.push({ code: 'children-unreadable' })
    else if (c === null) notes.push({ code: 'children-unchecked', why: 'unreadable' })
    else if (!c.checked) notes.push({ code: 'children-unchecked', why: c.reason })
    // A work child SEEN is evidence whatever the trust; only an EMPTY answer needs trusting.
    else if (c.children.length > 0) reasons.push({ code: 'work-child', children: c.children })
    else if (!obs.childrenTrusted) notes.push({ code: 'children-unchecked', why: 'untrusted' })
  }

  if (now >= effectiveDeadline(req)) {
    // A HAND-OFF past its hard deadline: the successor holds the task (confirmed alive), so the
    // predecessor is closed whatever it is doing. Not observed yet = keep waiting, never a guess.
    if (req.successorId) {
      if (obs.successorAlive !== true) return { action: 'wait', reasons, notes }
      return { action: 'retire', kill: true, notes, forced: true, reasons }
    }
    // Any other request: at or past the deadline nothing is killed, however quiet it has become.
    return { action: 'expire', reasons, notes }
  }
  if (reasons.length === 0) return { action: 'retire', kill: true, notes }
  return { action: 'wait', reasons, notes }
}

/** The hold put on a retire (empty when there is none). */
export function holdReasons(hold: HoldObservation | undefined): RetireReason[] {
  if (!hold || hold.state === 'none') return []
  return hold.state === 'held' ? [{ code: 'in-use', since: hold.since, sentence: hold.sentence }] : [{ code: 'hold-unknown' }]
}

/**
 * The deadline of a request held by a hold, or `null` when it needs no move. A held request never expires,
 * so its deadline follows the hold: whenever less than half of `HOLD_GRACE_MS` is left (or it has passed)
 * it becomes `now + HOLD_GRACE_MS`, which is what lets the retire fire after the hold ends.
 */
export function extendedDeadline(req: RetireRequest, now: number): string | null {
  const left = Date.parse(req.deadlineAt) - now
  return left < HOLD_GRACE_MS / 2 ? new Date(now + HOLD_GRACE_MS).toISOString() : null
}

const secs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`

/** One reason in words, for the expiry notification and the CLI. */
export function retireReasonText(r: RetireReason): string {
  switch (r.code) {
    case 'in-use': return `${r.sentence.en} (since ${new Date(r.since).toISOString()})`
    case 'hold-unknown': return 'whether something live is using it could not be read'
    case 'working': return 'still working'
    case 'waiting-approval': return 'waiting on a permission dialog (a person must answer it)'
    case 'activity-unknown': return 'its state could not be read'
    case 'not-confirmed': return `idle on ${r.polls} of ${CONFIRM_POLLS} polls needed`
    case 'quiet-too-short': return `quiet for only ${secs(r.quietMs)} of the ${secs(r.wantMs)} asked`
    case 'bg-tasks': return `${r.count} background task${r.count === 1 ? '' : 's'} still running`
    case 'children-unreadable': return 'its child processes could not be read'
    case 'successor-unknown': return 'its successor has not been observed yet'
    case 'bg-unknown': return 'its background tasks could not be read'
    case 'work-child': {
      const names = r.children.slice(0, 3).map(c => c.argv.split(' ')[0]!.replace(/^.*\//, '') || String(c.pid))
      return `child process ${names.join(', ')}${r.children.length > 3 ? ` (+${r.children.length - 3})` : ''} still running`
    }
  }
}

export function retireNoteText(n: RetireNote, harness: string): string {
  return n.why === 'untrusted'
    ? `child processes not trusted yet for ${harness} (not measured while running a command)`
    : n.why === 'unreadable'
      ? `child processes could not be read for ${harness}`
      : `child processes not checked for ${harness} (never measured)`
}

export function retireReasonsText(reasons: readonly RetireReason[]): string {
  return reasons.length === 0 ? 'it was quiet only after the deadline' : reasons.map(retireReasonText).join('; ')
}

export interface RetireInput {
  by: string
  successorId?: string
  folderId?: string
  quietForMs?: number
  deadlineMs?: number
}

/**
 * A new request, or a refusal. A pending hand-off to a DIFFERENT successor is refused
 * (`handoff_pending`) — two successors for one predecessor is two leaders. Re-asking with the same
 * (or no) successor replaces the request, which is how a deadline is extended; an expired request
 * is always replaced.
 */
export function planRetireRequest(
  existing: RetireRequest | undefined,
  input: RetireInput,
  now: number,
): { ok: true; request: RetireRequest } | { ok: false; code: 'handoff_pending'; successorId: string } {
  if (existing && !existing.expiredAt && existing.successorId && existing.successorId !== input.successorId) {
    return { ok: false, code: 'handoff_pending', successorId: existing.successorId }
  }
  // A hand-off closes the predecessor once its CURRENT turn ends (the short confirmed quiet), and
  // never later than its hard deadline.
  const handoff = Boolean(input.successorId)
  const quietForMs = Math.max(MIN_QUIET_FOR_MS, input.quietForMs ?? (handoff ? MIN_QUIET_FOR_MS : DEFAULT_QUIET_FOR_MS))
  const deadlineMs = input.deadlineMs ?? (handoff ? HANDOFF_DEADLINE_MS : DEFAULT_DEADLINE_MS)
  return {
    ok: true,
    request: {
      requestedAt: new Date(now).toISOString(),
      by: input.by,
      ...(input.successorId ? { successorId: input.successorId } : {}),
      // Whatever holds the session is told the leadership passed ONCE per hand-off: re-asking for the same successor keeps it said.
      ...(existing?.handoffNoticeAt && existing.successorId && existing.successorId === input.successorId ? { handoffNoticeAt: existing.handoffNoticeAt } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
      quietForMs,
      deadlineAt: new Date(now + deadlineMs).toISOString(),
    },
  }
}
