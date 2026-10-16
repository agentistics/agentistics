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
import { planAttach } from './task-attach'
import { readRegistry } from './registry'
import { repoFacts } from './repo-facts'
import type { ManagedSession } from './types'
import type { Task, TaskBook } from './task-model'

export interface SpawnFilingRequest {
  /** Absent = a person / unknown caller (see `FilingInput.role`). */
  role?: 'worker' | 'leader' | undefined
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
  /**
   * A task that WILL exist (a batch's new `--task` title) planned as if it already did, so every
   * other refusal shows up before anything is written. The plan carries its placeholder id.
   */
  pendingTask?: Pick<Task, 'id' | 'title'> | undefined
  /** Directories earlier plans of the same batch will occupy — they count as live sessions there. */
  extraLiveCwds?: readonly string[] | undefined
  /** Test seam: the git probe (the real one is process-global and a test file elsewhere may stub it). */
  repoFacts?: (dir: string) => Promise<{ repo?: string | undefined; worktree: boolean; missing?: boolean | undefined } | null>
  /** Test seams. */
  rows?: readonly ManagedSession[]
  book?: Pick<TaskBook, 'tasks' | 'subtasks'>
  groups?: import('@agentistics/core').SessionUserGroupsValue
}

/** At most this many git probes at once (a registry can hold thousands of rows). */
const PROBE_CONCURRENCY = 8
const MAX_PROBES_PER_PASS = 40

const canon = async (p: string): Promise<string> => realpath(p).catch(() => resolve(p))
const trimSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)

/** The sessions the backend IN USE says are running; `undefined` (it did not answer) = ask the default one. */
export async function liveIdsOf(backend: { list(): Promise<ReadonlyArray<{ id: string; alive?: boolean }>> }): Promise<ReadonlySet<string> | undefined> {
  const l = await backend.list().catch(() => null)
  return l ? new Set(l.filter(b => b.alive !== false).map(b => b.id)) : undefined
}

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
  let book: Pick<TaskBook, 'tasks' | 'subtasks'> = o.book ?? (wantsBoard ? await import('./task-source').then(m => m.loadTaskBoard()).then(w => w.book) : { tasks: [], subtasks: [] })
  if (o.pendingTask) {
    const now = new Date().toISOString()
    const synthetic: Task = { ...o.pendingTask, status: 'in_progress', createdAt: now, updatedAt: now } as Task
    book = { tasks: [...book.tasks, synthetic], subtasks: book.subtasks }
  }
  const groups = o.groups ?? { groups: ((await readPreferences().catch(() => null))?.sessionGroups?.groups ?? []).map(g => ({ ...g, sessionKeys: [...g.sessionKeys] })) }
  const caller = o.callerSessionId ? rows.find(r => r.id === o.callerSessionId) : undefined
  const handoffRow = o.handoffOf ? rows.find(r => r.id === o.handoffOf) : undefined
  const callerCwd = await canon(process.cwd())
  const cwd = o.cwd?.trim() ? await canon(resolve(o.cwd)) : undefined
  const liveIds = o.liveIds ?? await defaultLiveIds()
  // Row cwds are canonicalised the same way the asked-for cwd is, or a checkout reached through a
  // symlink never matches (memoised: many rows share a directory).
  const canonMemo = new Map<string, string>()
  const canonRow = async (p: string): Promise<string> => {
    const t = trimSep(p)
    if (!canonMemo.has(t)) canonMemo.set(t, trimSep(await canon(t)))
    return canonMemo.get(t)!
  }
  const canonRows = await Promise.all(rows.map(async r => ({ ...r, cwd: await canonRow(r.cwd) })))
  const extraLive = await Promise.all((o.extraLiveCwds ?? []).map(canonRow))
  const known = new Map<string, FilingRepo | null>()

  const liveInCwd = (dir: string, excludeId?: string): number =>
    canonRows.filter(r => r.id !== excludeId && liveIds.has(r.id) && r.cwd === trimSep(dir)).length
    + extraLive.filter(c => c === trimSep(dir)).length

  for (let pass = 0; pass < 4; pass++) {
    const misses = new Set<string>()
    const repoOf = (dir: string): FilingRepo | null => {
      const d = trimSep(dir)
      if (known.has(d)) return known.get(d)!
      misses.add(d)
      return null
    }
    const plan = planFiling({
      ...(o.role ? { role: o.role } : {}),
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
    if (misses.size === 0 || pass === 3) return checkAttach(plan, book)
    const todo = [...misses].slice(0, MAX_PROBES_PER_PASS)
    for (const d of misses) if (!todo.includes(d)) known.set(d, null)
    for (let i = 0; i < todo.length; i += PROBE_CONCURRENCY) {
      await Promise.all(todo.slice(i, i + PROBE_CONCURRENCY).map(async d => {
        const f = await (o.repoFacts ?? repoFacts)(d).catch(() => null)
        known.set(d, f ? { ...(f.repo ? { repo: f.repo } : {}), worktree: f.worktree, ...(f.missing ? { missing: true } : {}) } : null)
      }))
    }
  }
  throw new Error('unreachable')
}

/** Workers fail fast. Persons and hand-offs spawn first, then report the board's attach refusal. */
function checkAttach(plan: FilingPlan, book: Pick<TaskBook, 'tasks' | 'subtasks'>): FilingPlan {
  if (!plan.ok || plan.role !== 'worker' || !plan.taskId || !plan.subtaskId) return plan
  const a = planAttach({
    target: { kind: 'subtask', id: plan.subtaskId },
    taskIds: book.tasks.map(t => t.id),
    subtasks: book.subtasks.map(st => ({ id: st.id, taskId: st.taskId, done: st.done, blockedBy: st.blockedBy, parentGroupId: st.parentGroupId })),
  })
  if (a.ok) return plan
  const why = a.reason === 'blocked' ? `it is blocked by ${(a.blockedBy ?? []).join(', ')}` : `the board refuses it (${a.reason})`
  return { ok: false, code: 'subtask_refused', detail: `subtask ${plan.subtaskId} cannot take a session: ${why}` }
}

/** Never throws: a board that cannot be read is its own refusal, not a missing directory. */
export async function planSpawnFilingSafe(o: SpawnFilingRequest): Promise<FilingPlan> {
  try {
    return await planSpawnFiling(o)
  } catch (e) {
    return { ok: false, code: 'board_unreadable', detail: `could not read the board: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Record the filing on the board after the session is up, at every spawn site alike. A refusal is
 * returned (the caller reports it) and the filing the row was stamped with is cleared, so a row
 * never stays filed where the board said no.
 */
export async function attachAfterSpawn(
  plan: { taskId?: string | undefined; subtaskId?: string | undefined },
  sessionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!plan.taskId) return { ok: true }
  try {
    const { attachSession } = await import('./task-web')
    const r = await attachSession(plan.taskId, sessionId, plan.subtaskId ? { subtaskId: plan.subtaskId } : {})
    if (r.ok) return { ok: true }
    const { patchSession } = await import('./registry')
    await patchSession(sessionId, { task: null, taskId: null, subtaskId: null }).catch(() => false)
    return { ok: false, reason: r.reason }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
