/**
 * rewind-pending.ts — the rewind agentop just performed, until the transcript can say it itself.
 *
 * claude records a rewind in NOTHING until the conversation continues: the menu restores its state
 * in memory, and only the next message — whose `parentUuid` names the restored point — makes the
 * abandoned turns identifiable in the file (`active-branch.ts`). Measured on a probe: after a rewind
 * the transcript was unchanged, so the chat went on showing the turns the person had just undone.
 *
 * So a rewind driven from here is REMEMBERED, per conversation, and the chat is cut at that point
 * until the transcript catches up — the moment a user turn newer than the rewind appears, the file
 * is the authority again and the memory is dropped. In memory only, and bounded by time: a process
 * restart forgets it, which costs only the gap this closes, never a message.
 *
 * `applyPendingRewind` is PURE; the map around it is the module's only state.
 */

import { rewindRowMatches } from './claude-rewind'

export interface PendingRewind {
  prompt: string
  /** Which appearance of `prompt` among the person's prompts, 0 = the latest. */
  occurrence: number
  /** When the rewind happened. */
  atMs: number
}

/** After this long without the transcript catching up, the memory is dropped regardless. */
export const PENDING_REWIND_TTL_MS = 30 * 60_000

const pending = new Map<string, PendingRewind>()

export function recordRewind(conversationId: string, r: PendingRewind): void {
  pending.set(conversationId, r)
}

export function pendingRewindFor(conversationId: string, nowMs: number): PendingRewind | null {
  const r = pending.get(conversationId)
  if (!r) return null
  if (nowMs - r.atMs > PENDING_REWIND_TTL_MS) { pending.delete(conversationId); return null }
  return r
}

export function forgetRewind(conversationId: string): void {
  pending.delete(conversationId)
}

interface TurnLike { role: string; text: string; at?: string }

/**
 * PURE: the turns as they are AFTER the rewind — everything from the restored prompt on is cut.
 *
 * `stale` is true when the transcript already holds a person's turn newer than the rewind: the file
 * then carries the branch itself, and the caller should drop the memory. When the prompt cannot be
 * found in these turns, nothing is cut — a guess at where to cut would hide the wrong messages.
 */
export function applyPendingRewind<T extends TurnLike>(
  turns: readonly T[],
  r: PendingRewind,
): { turns: T[]; stale: boolean } {
  const newer = turns.some(t => t.role === 'user' && t.at !== undefined && Date.parse(t.at) > r.atMs)
  if (newer) return { turns: [...turns], stale: true }
  let seen = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.role !== 'user' || !rewindRowMatches(firstLine(t.text), r.prompt)) continue
    if (seen === r.occurrence) return { turns: turns.slice(0, i), stale: false }
    seen++
  }
  return { turns: [...turns], stale: false }
}

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim() !== '') ?? ''
}
