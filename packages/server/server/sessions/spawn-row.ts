/**
 * spawn-row.ts — PURE: what a spawn plan writes on the registry row, and what `--json` reports of it.
 *
 * The three spawn sites (`session start`, `session batch`, `spawnSession` for the web/VS Code) each
 * built their row by hand, and each filed a different subset of the same facts. They now all take
 * the fields from here, so one plan gives one row wherever it is spawned
 * (`spawn-row.test.ts` is the table that holds it).
 */

import { hasRolePrefix } from '@agentistics/core'
import type { ManagedSession } from './types'
import type { FilingPlan } from './spawn-filing'
import type { SpawnFilingRequest } from './spawn-filing-io'

type OkPlan = Extract<FilingPlan, { ok: true }>

/** A person has no inferred role; parented spawns are workers, hand-offs are leaders. */
export function spawnRole(o: {
  explicit?: 'worker' | 'leader' | undefined
  leaderPrefix?: boolean | undefined
  hasParent?: boolean | undefined
  handoff?: boolean | undefined
}): 'worker' | 'leader' | undefined {
  return o.handoff ? 'leader' : o.explicit ?? (o.leaderPrefix ? 'leader' : o.hasParent ? 'worker' : undefined)
}

/** The exact filing request used by the web, TUI and VS Code host. Pure for behavioural tests. */
export function spawnSessionFilingRequest(req: {
  role?: 'worker' | 'leader' | undefined
  parentSessionId?: string | undefined
  parentVerified?: boolean | undefined
  harness?: string | undefined
  label?: string | undefined
  handoff?: boolean | undefined
  taskId?: string | undefined
  subtaskId?: string | undefined
  cwd: string
}): SpawnFilingRequest {
  return {
    role: spawnRole({ explicit: req.role, leaderPrefix: !!req.label && hasRolePrefix(req.label), hasParent: !!req.parentSessionId, handoff: req.handoff }),
    taskRef: req.taskId, subtaskRef: req.subtaskId, cwd: req.cwd,
    harness: req.harness,
    callerSessionId: req.parentVerified || req.handoff ? req.parentSessionId : undefined,
    ...(req.handoff && req.parentSessionId ? { handoffOf: req.parentSessionId } : {}),
  }
}

/**
 * The filing fields of a new row. `task` is the board task's REAL title (never the text the caller
 * typed); `freeTask` is a free-text name for a spawn that is filed on no board task at all.
 */
export function filingRow(plan: OkPlan, freeTask?: string): Pick<ManagedSession, 'task' | 'taskId' | 'subtaskId'> {
  const task = plan.taskTitle ?? freeTask
  return {
    ...(task ? { task } : {}),
    ...(plan.taskId ? { taskId: plan.taskId } : {}),
    ...(plan.taskId && plan.subtaskId ? { subtaskId: plan.subtaskId } : {}),
  }
}

/** The filing block `--json` adds to a start / batch result. */
export function filingJson(plan: OkPlan): {
  taskId: string | null
  subtaskId: string | null
  folder: { id: string; path: string; source: OkPlan['folderSource'] } | null
  cwd: string
  role: 'worker' | 'leader' | null
  warnings: OkPlan['warnings']
} {
  return {
    taskId: plan.taskId ?? null,
    subtaskId: plan.subtaskId ?? null,
    folder: plan.folderId ? { id: plan.folderId, path: plan.folderPath ?? plan.folderId, source: plan.folderSource } : null,
    cwd: plan.cwd,
    role: plan.role ?? null,
    warnings: plan.warnings,
  }
}

/** One sentence per refusal, for a terminal. Codes stay codes on the wire; this is the CLI's rendering. */
export function refusalText(r: Extract<FilingPlan, { ok: false }>): string {
  const lines = [`Not started — ${r.detail}`]
  if (r.candidates?.length) lines.push('Closest:', ...r.candidates.map(c => `  ${c}`))
  return lines.join('\n')
}

export const WARNING_TEXT: Record<OkPlan['warnings'][number], string> = {
  no_folder: 'No sidebar folder was found for this session — pass --folder to file it.',
  subtask_member_filed_on_group: 'The subtask is a member of a group; the session is filed on the group.',
  shared_checkout_override: 'Sharing a main checkout another live session works in (--shared-cwd).',
}
