/**
 * pendingSessionStore.ts — the small external store `SessionsAside.tsx` reads, wherever it mounts.
 *
 * `SessionsAside` is mounted in TWO places (the desktop sidebar and the mobile "Sessions" tab),
 * each behind its own `useFleet()` poll, and the aside sits BESIDE whichever page created the
 * session — `NewSessionModal`'s callers span the sessions workspace itself, the tasks board and a
 * delivery's own detail page. None of those own the aside, so "a session was just started" has to
 * live somewhere all of them can reach and both aside mounts can read — the same
 * `useSyncExternalStore` shape `lib/idleReviewStore.ts` uses for the bell.
 *
 * In-memory only, deliberately: a page reload has no session left to be "still starting" about —
 * the next fleet poll after a reload answers the real question directly.
 */
import { isNativeSessionId } from './sessionRoute'
import { useSyncExternalStore } from 'react'
import {
  addPendingSession, dismissFailedPendingSession, emptyPendingSessions, PENDING_SESSION_WAIT_MS, reconcilePendingSessions,
  type PendingSessionState,
} from './pendingSession'

let state: PendingSessionState = emptyPendingSessions()
/**
 * The ids the last fleet poll carried. A spawn can take longer than a poll (opencode's ACP start is ~25 s,
 * OPENCODE.CORREÇÕES 2026-10-30): the real row is already in the fleet when `markSessionPending` runs, and the
 * reconcile only runs when the rows CHANGE — a quiet fleet never re-ran it, so "Iniciando…" spun forever beside
 * the very row it was waiting for. Marking now checks the last poll at once, and a timer re-checks at the budget.
 */
let lastPresent: ReadonlySet<string> = new Set()

const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function commit(next: PendingSessionState): void {
  if (next === state) return
  state = next
  emit()
}

/**
 * A `NewSessionModal` caller's own `onStarted` — call this before (or instead of) navigating, so
 * the placeholder is in the store the instant the spawn returns, never a frame late.
 */
export function markSessionPending(entry: { id: string; harness?: string; label?: string; cwd?: string }): void {
  // A NATIVE session (UI.2) is never a fleet row, so a placeholder waiting for one would end as
  // "did not appear — it may have failed to start" about a session that is running. It is opened on
  // its own page straight away instead (`SessionRoute`).
  if (isNativeSessionId(entry.id)) return
  commit(reconcilePendingSessions(addPendingSession(state, entry, Date.now()), lastPresent, Date.now()))
  // The budget expires on the CLOCK, not on the next change of the rows (which may never come).
  setTimeout(() => commit(reconcilePendingSessions(state, lastPresent, Date.now())), PENDING_SESSION_WAIT_MS + 50)
}

/**
 * The aside's own effect, run whenever the fleet rows it was handed change. `presentIds` should
 * carry both a row's `id` and its `conversationId` — see `pendingSession.ts`'s own note.
 */
export function reconcilePendingSessionsNow(presentIds: ReadonlySet<string>): void {
  lastPresent = presentIds
  commit(reconcilePendingSessions(state, presentIds, Date.now()))
}

/** The failed placeholder's own `×`. */
export function dismissFailedPending(id: string): void {
  commit(dismissFailedPendingSession(state, id))
}

/** Non-reactive read, for a caller outside React and for tests. */
export function getPendingSessionsSnapshot(): PendingSessionState {
  return state
}

export function usePendingSessions(): PendingSessionState {
  return useSyncExternalStore(subscribe, getPendingSessionsSnapshot, getPendingSessionsSnapshot)
}

/** Test-only: resets the module-level store between tests. */
export function resetPendingSessionsForTest(): void {
  lastPresent = new Set()
  commit(emptyPendingSessions())
}
