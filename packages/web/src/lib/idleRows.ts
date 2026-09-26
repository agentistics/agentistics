/**
 * idleRows.ts — PURE: the fleet row's own shape → what `idleCandidates` (`@agentistics/core`) needs
 * to judge whether a session has gone idle.
 *
 * Kept apart from `useIdleSessions.ts` (which is not pure — it polls hardware and pushes
 * notifications) so the mapping itself can be tested without a hook harness.
 */
import type { IdleRowInput } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

/** `unknown` is the external (not agentop-started) state; `closed` is a stored conversation. */
const UNMANAGED = new Set(['unknown', 'closed'])

export function toIdleRow(r: ControlSession, finishedTasks: readonly string[]): IdleRowInput {
  return {
    id: r.id,
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
    state: r.state,
    managed: !UNMANAGED.has(r.state),
    ...(r.lastUserMessageAt !== undefined ? { lastUserMessageAt: r.lastUserMessageAt } : {}),
    ...(r.taskId ? { taskId: r.taskId } : {}),
    taskDone: Boolean(r.task && finishedTasks.includes(r.task)),
    rssBytes: r.rssBytes ?? null,
    cpuPercent: r.cpuPercent ?? null,
    contextFraction: r.context?.fraction ?? null,
  }
}

/** The last thing the USER said in this conversation, trimmed for a preview — never the harness's
 *  own reply, and never longer than a notification or a modal row wants to render. `null` when the
 *  row carries no chat turns at all (an external row, or one whose transcript was never read). */
export function lastPromptOf(r: ControlSession): string | null {
  const turn = [...(r.chatTurns ?? [])].reverse().find(t => t.role === 'user' && t.text.trim())
  return turn ? turn.text.trim().slice(0, 200) : null
}
