import type { HarnessId } from '@agentistics/core'
import { planSpawn } from './spawn-spec'
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

/**
 * The model and effort a reopen re-applies — `claude --resume <id>` alone comes back on the GLOBAL
 * default, so a Sonnet worker returned as whatever the machine's default is.
 *
 * Only what this harness's CLI can actually take: `planSpawn` is the judge (a harness with no
 * `--effort`, or a recorded value outside the closed enum, drops THAT option and keeps the other),
 * so a reopen is never refused over a launch option it could have started without.
 */
export function inheritedLaunch(
  prev: ManagedSession | undefined,
  harness: HarnessId,
): { model?: string; effort?: string } {
  if (!prev) return {}
  const accepts = (o: { model?: string; effort?: string }) =>
    planSpawn({ harness, cwd: prev.cwd, resumeId: 'x', ...o }).ok
  const out: { model?: string; effort?: string } = {}
  if (prev.model && accepts({ model: prev.model })) out.model = prev.model
  if (prev.effort && accepts({ effort: prev.effort })) out.effort = prev.effort
  return out
}
