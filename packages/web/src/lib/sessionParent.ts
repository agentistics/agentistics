/**
 * sessionParent.ts — PURE. Who started a session, as far as the fleet can say.
 *
 * `ControlSession.parentSessionId` is the managed id recorded at spawn. The title is resolved against
 * the OTHER rows of the same fleet (by managed id, then conversation id); a parent that has left the
 * fleet still gets its id, so the line can say who made it even when there is nothing to open.
 */
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

export interface SessionParent {
  id: string
  /** Absent when the parent is no longer in the fleet. */
  title?: string
  /** True when a row exists to navigate to. */
  openable: boolean
}

export function sessionParent(
  session: Pick<ControlSession, 'parentSessionId'>,
  rows: readonly Pick<ControlSession, 'id' | 'conversationId' | 'title'>[],
): SessionParent | null {
  const pid = session.parentSessionId
  if (!pid) return null
  const hit = rows.find(r => r.id === pid) ?? rows.find(r => r.conversationId === pid)
  return hit ? { id: hit.id, title: hit.title, openable: true } : { id: pid, openable: false }
}

/** The line's wording, in one place. */
export function createdByLabel(p: SessionParent, pt: boolean): string {
  const who = p.title ? p.title : p.id.slice(0, 8)
  return pt ? `criada por ${who}` : `created by ${who}`
}
