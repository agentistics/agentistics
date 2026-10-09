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
  session: Pick<ControlSession, 'parentSessionId' | 'parentConversationId'>,
  rows: readonly Pick<ControlSession, 'id' | 'conversationId' | 'title'>[],
): SessionParent | null {
  const pid = session.parentConversationId ?? session.parentSessionId
  if (!pid) return null
  // The conversation id first: it survives a reopen of the parent, whose managed id does not.
  const hit = rows.find(r => r.conversationId === pid) ?? rows.find(r => r.id === pid)
    ?? (session.parentSessionId ? rows.find(r => r.id === session.parentSessionId) : undefined)
  return hit ? { id: hit.id, title: hit.title, openable: true } : { id: pid, openable: false }
}

/** The line's wording, in one place. */
export function createdByLabel(p: SessionParent, pt: boolean): string {
  const who = p.title ? p.title : p.id.slice(0, 8)
  return pt ? `criada por ${who}` : `created by ${who}`
}

type LinkRow = Pick<ControlSession, 'id' | 'conversationId' | 'title' | 'harness' | 'state' | 'startedAt'> & {
  parentSessionId?: string
  parentConversationId?: string
}

/**
 * The fleet rows that name `session` as their parent — by managed id or by conversation id (the
 * link that survives a reopen). A row never counts as its own child.
 */
export function sessionChildren<R extends LinkRow>(
  session: Pick<ControlSession, 'id' | 'conversationId'>,
  rows: readonly R[],
): R[] {
  return rows.filter(r => {
    if (r.id === session.id) return false
    const hit = (v?: string) => v !== undefined && (v === session.id || (!!session.conversationId && v === session.conversationId))
    return hit(r.parentConversationId) || hit(r.parentSessionId)
  })
}

export interface SessionLinks {
  parent: SessionParent | null
  children: LinkRow[]
  task: { id: string; label?: string } | null
}

/** Everything the ⓘ shows; `null` when the session has no link at all (the icon is then absent). */
export function sessionLinks(
  session: Pick<ControlSession, 'id' | 'conversationId' | 'parentSessionId' | 'parentConversationId' | 'taskId' | 'task'>,
  rows: readonly LinkRow[],
): SessionLinks | null {
  const parent = sessionParent(session, rows)
  const children = sessionChildren(session, rows)
  const task = session.taskId ? { id: session.taskId, ...(session.task ? { label: session.task } : {}) } : null
  return parent || children.length || task ? { parent, children, task } : null
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/** Newest first; a row with no start time sorts after every dated one, ties keep fleet order. */
export function newestFirst<R extends { startedAt?: number | undefined }>(rows: readonly R[]): R[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const x = a.r.startedAt ?? -Infinity, y = b.r.startedAt ?? -Infinity
    return x === y ? a.i - b.i : y - x
  }).map(o => o.r)
}

/** Case- and accent-insensitive title filter; an empty query keeps everything. */
export function filterByTitle<R extends { title: string }>(rows: readonly R[], query: string): R[] {
  const q = fold(query).trim()
  return q ? rows.filter(r => fold(r.title).includes(q)) : [...rows]
}
