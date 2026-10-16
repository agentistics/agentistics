/**
 * spawn-filing-io.ts — the IO half of `spawn-filing.ts`: gathers what the planner needs from the
 * real world (board, registry, folders, git, live sessions) and asks it ONE question, so the three
 * spawn sites cannot each gather it differently.
 *
 * `repoOf` is synchronous in the planner but git is not: the plan runs against what has been resolved
 * so far, records every directory it asked about and could not find, and runs again after they are
 * resolved (bounded) — so a refusal that lists checkouts costs git only for the rows it looks at.
 * Every path handed to the planner is realpath'd here (its contract).
 */

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readPreferences } from '../preferences'
import { planFiling, type FilingPlan, type FilingRepo } from './spawn-filing'
import { readRegistry } from './registry'
import { repoFacts } from './repo-facts'
import type { ManagedSession } from './types'
import type { TaskBook } from './task-model'

export interface SpawnFilingRequest {
  role: 'worker' | 'leader'
  taskRef?: string | undefined
  subtaskRef?: string | undefined
  folderRef?: string | undefined
  /** As typed — resolved against the caller's cwd, then realpath'd. */
  cwd?: string | undefined
  sharedCwd?: boolean | undefined
  /** The session this command runs inside, if any (`AGENTOP_MANAGED_ID`). */
  callerSessionId?: string | undefined
  /** The predecessor's id, for a leader hand-off. */
  handoffOf?: string | undefined
  /** Registry ids of sessions that are running now; `undefined` = ask the backend. */
  liveIds?: ReadonlySet<string> | undefined
  /** Test seams. */
  rows?: readonly ManagedSession[]
  book?: Pick<TaskBook, 'tasks' | 'subtasks'>
  groups?: import('@agentistics/core').SessionUserGroupsValue
}

const canon = async (p: string): Promise<string> => realpath(p).catch(() => resolve(p))
const trimSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)

async function defaultLiveIds(): Promise<ReadonlySet<string>> {
  try {
    const { resolveBackend } = await import('./index')
    return new Set((await (await resolveBackend()).list()).map(b => b.id))
  } catch {
    return new Set()
  }
}

export async function planSpawnFiling(o: SpawnFilingRequest): Promise<FilingPlan> {
  const rows = o.rows ?? await readRegistry()
  const wantsBoard = !!(o.taskRef?.trim() || o.subtaskRef?.trim() || o.handoffOf)
  const book: Pick<TaskBook, 'tasks' | 'subtasks'> = o.book ?? (wantsBoard ? await import('./task-source').then(m => m.loadTaskBoard()).then(w => w.book) : { tasks: [], subtasks: [] })
  const groups = o.groups ?? { groups: ((await readPreferences().catch(() => null))?.sessionGroups?.groups ?? []).map(g => ({ ...g, sessionKeys: [...g.sessionKeys] })) }
  const caller = o.callerSessionId ? rows.find(r => r.id === o.callerSessionId) : undefined
  const handoffRow = o.handoffOf ? rows.find(r => r.id === o.handoffOf) : undefined
  const callerCwd = await canon(process.cwd())
  const cwd = o.cwd?.trim() ? await canon(resolve(o.cwd)) : undefined
  const liveIds = o.liveIds ?? await defaultLiveIds()
  const canonRows = rows.map(r => ({ ...r, cwd: trimSep(r.cwd) }))
  const known = new Map<string, FilingRepo | null>()

  const liveInCwd = (dir: string, excludeId?: string): number =>
    canonRows.filter(r => r.id !== excludeId && liveIds.has(r.id) && r.cwd === trimSep(dir)).length

  for (let pass = 0; pass < 4; pass++) {
    const misses = new Set<string>()
    const repoOf = (dir: string): FilingRepo | null => {
      const d = trimSep(dir)
      if (known.has(d)) return known.get(d)!
      misses.add(d)
      return null
    }
    const plan = planFiling({
      role: o.role,
      ...(o.taskRef !== undefined ? { taskRef: o.taskRef } : {}),
      ...(o.subtaskRef !== undefined ? { subtaskRef: o.subtaskRef } : {}),
      ...(o.folderRef !== undefined ? { folderRef: o.folderRef } : {}),
      ...(cwd ? { cwd } : {}),
      ...(o.sharedCwd ? { sharedCwd: true } : {}),
      callerCwd,
      ...(caller ? { caller } : {}),
      ...(handoffRow ? { handoffOf: handoffRow } : {}),
      book, rows: canonRows, groups, repoOf, liveInCwd,
    })
    if (misses.size === 0 || pass === 3) return plan
    await Promise.all([...misses].map(async d => {
      const f = await repoFacts(d).catch(() => null)
      known.set(d, f ? { ...(f.repo ? { repo: f.repo } : {}), worktree: f.worktree, ...(f.missing ? { missing: true } : {}) } : null)
    }))
  }
  throw new Error('unreachable')
}
