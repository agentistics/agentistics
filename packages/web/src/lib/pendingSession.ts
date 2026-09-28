/**
 * pendingSession.ts — PURE: the sessions the aside shows as "still starting", between the moment
 * `NewSessionModal` hands back an id and the moment the fleet poll actually contains it.
 *
 * `sessionRoute.ts`'s `arrivalFor`/`stillArriving` already answer this for the CENTRE pane (the
 * conversation column), keyed on the id in the URL — but the aside is a LIST, not a single pane, and
 * it is visible even when nobody has navigated anywhere (the desktop sidebar sits beside every page
 * in `mode === 'sessions'`). So it needs its own small record of "which ids were just started",
 * rather than reading the URL — but it reuses the very same BUDGET (`ARRIVAL_WAIT_MS`), because a
 * session either shows up inside that window or it does not, and inventing a second number for the
 * same fact would be two answers to one question.
 *
 * Two outcomes, and they are announced differently on purpose:
 * - RESOLVED (the id now appears in the fleet) is dropped SILENTLY — the real row is on screen,
 *   which is the only announcement success needs.
 * - EXPIRED (still missing past the budget) moves to `failed` and STAYS there until dismissed —
 *   never a placeholder that just vanishes, which reads exactly like "it did not create anything",
 *   the report this whole feature exists to fix.
 */
import { ARRIVAL_WAIT_MS } from './sessionRoute'

/** Reuses the centre pane's own arrival budget — see this file's header. */
export const PENDING_SESSION_WAIT_MS = ARRIVAL_WAIT_MS

/** One session the aside is watching for. */
export interface PendingSession {
  id: string
  harness?: string
  label?: string
  cwd?: string
  since: number
}

export interface PendingSessionState {
  /** Still waiting to appear, oldest first. */
  pending: readonly PendingSession[]
  /** Ran out the arrival budget without appearing. */
  failed: readonly PendingSession[]
}

export function emptyPendingSessions(): PendingSessionState {
  return { pending: [], failed: [] }
}

/**
 * A session was just started. Replaces any earlier entry of the same id (a retry of the same spawn
 * would otherwise sit twice) and clears it out of `failed`, so a session dismissed as failed and
 * then genuinely restarted under the same id gets a fresh placeholder rather than none at all.
 */
export function addPendingSession(
  state: PendingSessionState,
  entry: { id: string; harness?: string; label?: string; cwd?: string },
  now: number,
): PendingSessionState {
  return {
    pending: [...state.pending.filter(p => p.id !== entry.id), { ...entry, since: now }],
    failed: state.failed.filter(f => f.id !== entry.id),
  }
}

/**
 * Called on every fleet poll. `presentIds` should carry both a row's own id and its conversation
 * id — the same double key `selected`/`fleetIndex` match a link against elsewhere in this
 * workspace — since a spawn can hand back either one depending on the harness.
 *
 * Returns the SAME reference when nothing changed, so a caller wiring this into an effect can skip
 * a pointless re-render on every poll of a fleet with nothing pending.
 */
export function reconcilePendingSessions(
  state: PendingSessionState,
  presentIds: ReadonlySet<string>,
  now: number,
): PendingSessionState {
  if (state.pending.length === 0) return state
  const pending: PendingSession[] = []
  const failed: PendingSession[] = [...state.failed]
  let changed = false
  for (const p of state.pending) {
    if (presentIds.has(p.id)) { changed = true; continue }
    if (now - p.since >= PENDING_SESSION_WAIT_MS) { failed.push(p); changed = true; continue }
    pending.push(p)
  }
  if (!changed) return state
  return { pending, failed }
}

/** The placeholder's own `×` — dismisses one failed entry, never the whole list. */
export function dismissFailedPendingSession(state: PendingSessionState, id: string): PendingSessionState {
  if (!state.failed.some(f => f.id === id)) return state
  return { ...state, failed: state.failed.filter(f => f.id !== id) }
}
