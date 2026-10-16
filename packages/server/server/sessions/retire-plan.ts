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
 * At or past `deadlineAt` nothing is ever killed: the request EXPIRES with the reasons in words.
 * A row that is no longer running has nothing to kill and is simply filed as retired.
 */
import type { RetireRequest, SessionActivity } from './types'
import type { ProcNode, WorkChildrenResult } from './work-children'

/** Two foreground hub intervals; also enforced for stored requests by the runner. */
export const MIN_QUIET_FOR_MS = 10_000
export const DEFAULT_QUIET_FOR_MS = 60_000
export const DEFAULT_DEADLINE_MS = 30 * 60_000
/** Polls of `waiting` in a row before it counts — the `event-plan.ts` confirmation. */
export const CONFIRM_POLLS = 2

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
}

export type RetireReason =
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
  /** `kill: false` = the row already stopped on its own; only the filing is left. */
  | { readonly action: 'retire'; readonly kill: boolean; readonly notes: readonly RetireNote[] }
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

  // At or past the deadline nothing is killed, however quiet the session has become.
  if (now >= Date.parse(req.deadlineAt)) return { action: 'expire', reasons, notes }
  if (reasons.length === 0) return { action: 'retire', kill: true, notes }
  return { action: 'wait', reasons, notes }
}

const secs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`

/** One reason in words, for the expiry notification and the CLI. */
export function retireReasonText(r: RetireReason): string {
  switch (r.code) {
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
  const quietForMs = Math.max(MIN_QUIET_FOR_MS, input.quietForMs ?? DEFAULT_QUIET_FOR_MS)
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS
  return {
    ok: true,
    request: {
      requestedAt: new Date(now).toISOString(),
      by: input.by,
      ...(input.successorId ? { successorId: input.successorId } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
      quietForMs,
      deadlineAt: new Date(now + deadlineMs).toISOString(),
    },
  }
}
