/**
 * external-continue.ts — PURE (EXT.OPEN): what WRITING to an external session means.
 *
 * Owner, 2026-10-03: "everything is agentistics, everything is ours" — a session started outside
 * agentop (`claude` in the owner's own terminal) opens like any other and its conversation is read
 * at once. Writing to it is where the one hard rule lives: NEVER TWO PROCESSES WRITING ONE
 * CONVERSATION. An external row exists only while its process is alive, so the first write continues
 * the conversation HERE — the external process is ended and the same conversation id is resumed in a
 * managed session, with the message as its first prompt (`planSpawn`'s `resumeId` + `prompt`). That
 * ends somebody's process, so it is ASKED ONCE (`confirm`) and never done silently; the existing
 * takeover (`planTakeover` in `resumeSessionLocked`) does the ending and re-checks the pid.
 *
 * What refuses, in words, and stays READ-ONLY live:
 *   - `no-conversation`  the process never named its conversation. The directory guess is not good
 *                        enough to continue ANOTHER conversation into this one.
 *   - `not-resumable`    the harness cannot reopen a conversation by id (no `resume` in its spec).
 */
export type ContinuePlan =
  | { kind: 'refuse'; reason: 'no-conversation' | 'not-resumable' }
  | { kind: 'confirm' }
  | { kind: 'continue'; conversationId: string }

export function planContinueHere(o: {
  /** The conversation the process itself named — exact, never the directory guess. */
  conversationId: string | undefined
  /** The harness can resume a conversation by id. */
  resumable: boolean
  /** The person already said yes to ending the external process. */
  confirmed: boolean
}): ContinuePlan {
  if (!o.conversationId) return { kind: 'refuse', reason: 'no-conversation' }
  if (!o.resumable) return { kind: 'refuse', reason: 'not-resumable' }
  if (!o.confirmed) return { kind: 'confirm' }
  return { kind: 'continue', conversationId: o.conversationId }
}

/** Is this row an EXTERNAL one (a process agentop did not start)? Decided by its id's shape. */
export function isExternalRowId(id: string): boolean {
  return id.startsWith('external:')
}
