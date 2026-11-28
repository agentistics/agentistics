/**
 * sessionWaiting.ts — PURE: the session list's "waiting" reading, through the server's one field.
 *
 * The list's per-session activity comes from `/api/live-sessions`, which knows nothing about teams; the
 * fleet row the server builds carries `waitingOnWorkers` (`@agentistics/core` waitingOnWorkers.ts). A
 * leader whose turn ended while its workers still run is not waiting on the person, so the "waiting"
 * shortcut and the status grouping read it through `ownerState` instead of the bare activity.
 */
import { ownerState } from '@agentistics/core'
/**
 * Same union as `SessionActivity` in `sessionNotifications.ts`, kept local on purpose: that module writes, and
 * the delivery doors lint counts any importer of a writer (type-only too) as a new writer helper.
 */
type SessionActivity = 'working' | 'waiting' | 'waiting-approval' | 'idle' | 'exited'

/** The fleet fields this reading needs (`FleetRow` from `lib/fleet.ts` satisfies it). */
export interface WaitingFleetRow {
  state: string
  waitingOnWorkers?: number | undefined
  /** The finished turn only reacted to a notice from another session: nothing to answer. */
  afterNotice?: true | undefined
}

/** The activity a person should read: `idle` for a turn waiting on its workers, the activity otherwise. */
export function ownerActivity(activity: SessionActivity | undefined, row: WaitingFleetRow | undefined): SessionActivity | undefined {
  if (activity !== 'waiting' || !row) return activity
  return ownerState({ state: activity, waitingOnWorkers: row.state === 'waiting' ? row.waitingOnWorkers : undefined, afterNotice: row.state === 'waiting' ? row.afterNotice : undefined })
}

/** Does the "waiting" shortcut keep this LIVE session? A question, or a finished turn with no busy worker. */
export function waitsOnPerson(activity: SessionActivity | undefined, row: WaitingFleetRow | undefined): boolean {
  const a = ownerActivity(activity, row)
  return a === 'waiting' || a === 'waiting-approval'
}
