import type { ManagedSession } from './types'

/**
 * What a reopened row carries over from the row it replaces — the ONE place that list lives.
 *
 * A reopen mints a new managed id for the same conversation, so anything recorded on the old row
 * and not copied is lost the instant the session comes back. Four paths reopen (`resumeSession`,
 * `reopenEntries`, `agentop session open`, `agentop session attach <conversation>`) and each carried
 * its own subset: the cockpit/web resume took `task` and `note` only, so a reopened leader came
 * back with no label and no `taskId`/`subtaskId` — filed nowhere — while `reopenEntries` (which
 * passed `row.label`) happened to keep the name. One list, read by all of them.
 *
 * Pin, folder and notify state are keyed by the CONVERSATION id (`sessionIdentityKey`), so they
 * follow the conversation without being copied here; that is why the new row must be born with its
 * `conversationId`.
 */
export function inheritedIdentity(prev: ManagedSession | undefined): Partial<ManagedSession> {
  if (!prev) return {}
  const out: Partial<ManagedSession> = {}
  if (prev.label) {
    out.label = prev.label
    if (prev.labelSince !== undefined) out.labelSince = prev.labelSince
  }
  if (prev.note) out.note = prev.note
  if (prev.task) out.task = prev.task
  if (prev.taskId) out.taskId = prev.taskId
  if (prev.subtaskId) out.subtaskId = prev.subtaskId
  if (prev.attemptId) out.attemptId = prev.attemptId
  if (prev.harnessName) {
    out.harnessName = prev.harnessName
    if (prev.harnessNameSince !== undefined) out.harnessNameSince = prev.harnessNameSince
  }
  return out
}
