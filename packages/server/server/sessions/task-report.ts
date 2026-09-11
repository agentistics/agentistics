/**
 * task-report.ts — PURE. The task book plus the fleet plus the store, resolved into what a surface
 * draws. One implementation, read by the CLI, the HTTP route and therefore the web and the MCP.
 *
 * It exists because `agentop task show` and the dashboard must never disagree about what a delivery
 * cost. A second resolution would be a second set of rules, which is the bug `task-reopen.ts` was
 * written to have fixed once.
 */

import type { SessionMeta } from '@agentistics/core'
import { sessionTokenTotal } from '@agentistics/core'
import type {
  Attempt, AttemptStatus, Subtask, Task, TaskComment, TaskFile,
} from './task-model'
import { legacyTaskId } from './task-model'
import { rollupAttempt, type AttemptRollup, type RollupSession } from './task-rollup'
import { taskStats, type TaskStats } from './task-stats'
import type { ManagedSession } from './types'

/** A rollup row: an attempt, or the sessions of a task that name no attempt. */
export interface AttemptView {
  /** Null for the catch-all row of sessions filed under no attempt. */
  id: string | null
  label: string
  config?: Attempt['config']
  status: AttemptStatus | 'unattributed'
  rollup: AttemptRollup
}

/**
 * One session of a task, as a board reader needs it: which conversation, where, under which
 * attempt, and whether it is still going. This is what lets any assistant see what the others are
 * working on without opening the fleet.
 */
export interface TaskSessionRow {
  id: string
  harness: string
  cwd: string
  attemptId: string | null
  /**
   * The SUBTASK this session is filed under, when it is filed under one rather than under the
   * delivery itself. Null is the delivery — the two are one attachment, never two; see
   * `task-attach.ts`.
   */
  subtaskId: string | null
  createdAt: string
  endedAt?: string
  label?: string
  conversationId?: string
  /** Null when the conversation is not in the store — see `RollupSession.meta`. */
  tokens: number | null
  costUSD: number | null
  rounds: number | null
}

export interface TaskListRow {
  task: Task
  attempts: number
  rollup: AttemptRollup
  /**
   * What the card shows WITHOUT opening the task: how much board hangs off it, and which harnesses
   * touched it. Counted here rather than in the browser so the list and the detail can never
   * disagree about how many comments a task has.
   */
  counts: { comments: number; subtasks: number; subtasksDone: number; files: number }
  /** Distinct harnesses of this task's sessions, in first-seen order. */
  harnesses: string[]
  /**
   * Distinct repositories of this task's sessions, in first-seen order — the key the Repositories
   * page uses (`normalizeGitRemote`, already stamped onto `SessionMeta.git_remote`), and `''` for
   * the "no linked repository" bucket, which is a real value here exactly as it is in
   * `sessionInScope`.
   *
   * Read off the SESSIONS and never off `Task.repo`: a task belongs to a repository through the
   * work that happened in it, so one spanning two repositories names both, and a field somebody
   * typed (or inherited once, at creation) would be a second answer to the same question.
   *
   * Derived from the metas the caller passed, which are the SCOPED ones on every surface that
   * filters — so a task with no session inside the current window names no repository at all,
   * rather than one it has not touched since.
   */
  repos: string[]
}

export interface TaskDetail {
  task: Task
  attempts: AttemptView[]
  rollup: AttemptRollup
  stats: TaskStats
  sessions: TaskSessionRow[]
  comments: TaskComment[]
  subtasks: Subtask[]
  files: TaskFile[]
  subtaskRollups: SubtaskView[]
}

/**
 * The sessions of a task: those stamped with its id, plus those carrying its NAME from before ids
 * existed. The second half is exactly what `legacyTaskId` is for — it is what makes the feature
 * useful on a machine that has been running for months rather than only for work started after it.
 */
export function rowsOfTask(task: Task, rows: readonly ManagedSession[]): ManagedSession[] {
  return rows.filter(r =>
    r.taskId === task.id
    || (r.task !== undefined && legacyTaskId(r.task) === task.id))
}

/**
 * One `RollupSession` per row.
 *
 * `provenance` is READ from the record rather than guessed: a link with no `conversationLink` was
 * written before that field existed and was an assigned one. A row whose conversation is not in the
 * store yields `meta: null` and still counts as a session used.
 *
 * `costMeasured` stays unset: nothing reads a harness's own cost figure yet, and claiming a figure
 * is measured when it was estimated is precisely the confusion that field exists to prevent.
 */
/**
 * One row per CONVERSATION, in first-seen order — the rule stated once, for every surface that
 * accumulates over a task's rows. `task-overview.ts` needs it too: it walks the rows itself rather
 * than going through the rollup, so without this the headline counted a reopened conversation once
 * per reopening while the delivery under it counted correctly.
 *
 * A row with NO conversation link is always kept: it cannot be shown to be a duplicate of anything.
 */
export function distinctConversations(rows: readonly ManagedSession[]): ManagedSession[] {
  const seen = new Set<string>()
  return rows.filter(r => {
    if (!r.conversationId) return true
    if (seen.has(r.conversationId)) return false
    seen.add(r.conversationId)
    return true
  })
}

export function rollupSessionsFor(
  rows: readonly ManagedSession[],
  metas: ReadonlyMap<string, SessionMeta>,
  costOf: (m: SessionMeta) => number,
): RollupSession[] {
  // ONE CONVERSATION IS COUNTED ONCE, however many rows point at it.
  //
  // Every attach, reopen and restart mints a NEW managedId for the SAME conversation (see
  // `collapseSupersededSessions`, which does this for the fleet's own list), so a delivery worked
  // on across six reopenings holds six rows resolving to one `SessionMeta` — and this summed that
  // meta's tokens and cost six times. Measured on a live board on 2026-09-08: the "ALM board"
  // delivery reported 13.072.988.605 tokens and $7.477,50 where the truth was 2.456.546.185 and
  // $1.402,92. FIVE TIMES over, on the headline figure of the whole feature.
  //
  // A row with NO conversation link is kept as its own row: it cannot be shown to be a duplicate of
  // anything, and it contributes no numbers anyway — the same rule `usage-dedupe.ts` applies to a
  // usage record with no message id, and `filedUnder` to an attachment.
  return distinctConversations(rows).map(r => {
    const meta = r.conversationId ? metas.get(r.conversationId) ?? null : null
    return {
      rowId: r.id,
      provenance: r.conversationId ? (r.conversationLink ?? 'assigned') : 'none',
      meta,
      costUSD: meta ? costOf(meta) : null,
    } satisfies RollupSession
  })
}

export function attemptViews(
  task: Task,
  attempts: readonly Attempt[],
  rows: readonly ManagedSession[],
  metas: ReadonlyMap<string, SessionMeta>,
  costOf: (m: SessionMeta) => number,
): AttemptView[] {
  const mine = attempts.filter(a => a.taskId === task.id)
  const views: AttemptView[] = mine.map(a => ({
    id: a.id,
    label: a.label,
    config: a.config,
    status: a.status,
    rollup: rollupAttempt({
      sessions: rollupSessionsFor(rows.filter(r => r.attemptId === a.id), metas, costOf),
    }),
  }))

  // Rows filed under the task but under no attempt. Shown rather than dropped: they are real
  // sessions of this delivery, and a total that silently omitted them would be wrong in the
  // reassuring direction.
  const loose = rows.filter(r => !r.attemptId || !mine.some(a => a.id === r.attemptId))
  if (loose.length > 0) {
    views.push({
      id: null,
      label: 'no attempt named',
      status: 'unattributed',
      rollup: rollupAttempt({ sessions: rollupSessionsFor(loose, metas, costOf) }),
    })
  }
  return views
}

/** One rollup for a subtask (or a group of subtasks sharing a `groupId` — see below), or for the
 *  direct branch (`id: null`) — sessions filed on the task itself, under no subtask. Every row of a
 *  task falls into EXACTLY one of these buckets, because `subtaskId` and "no subtaskId" partition
 *  `rowsOfTask(task, rows)` completely — the same guarantee `filedUnder` already gives every
 *  session a single owner. */
export interface SubtaskView {
  /** A plain subtask's own id, or the shared `groupId` when it is one of a group — never a
   *  per-member id in that case, which is what stops a shared session's cost being summed once per
   *  member. */
  id: string | null
  rollup: AttemptRollup
}

/**
 * A rollup per subtask, plus one `id: null` bucket for the sessions filed on the delivery directly
 * — the same pattern `attemptViews` already applies to attempts, over the same partition.
 *
 * `rows` is expected already scoped to the task (`rowsOfTask(task, allRows)`), exactly like
 * `attemptViews`'s own `rows` parameter — this never re-derives that scope, and never re-sums the
 * partitions back into a total: `TaskDetail.rollup` is computed once, over the whole set, and this
 * is only ever a breakdown of it. A subtask with no sessions filed under it yet still gets a row —
 * "nothing filed here" is a real, empty measurement, not an omission.
 *
 * **Grouped subtasks collapse into ONE bucket, never one per member.** Two or more subtasks sharing
 * a `groupId` (`Subtask.groupId`, docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §B)
 * are bucketed by that group id rather than by each subtask's own id — a session filed under ANY
 * member's `subtaskId` is counted in that one bucket, once, regardless of which specific member the
 * session names. Summing per member would multiply a shared session's cost by the group's size,
 * which is exactly the double-count this function exists to rule out for every other shape. A
 * subtask with no `groupId` is unaffected — it is its own group of one, bucketed by its own id
 * exactly as before.
 */
export function subtaskViews(
  task: Task,
  subtasks: readonly Subtask[],
  rows: readonly ManagedSession[],
  metas: ReadonlyMap<string, SessionMeta>,
  costOf: (m: SessionMeta) => number,
): SubtaskView[] {
  const mine = subtasks.filter(s => s.taskId === task.id)
  // Effective bucket key: a subtask's own id, or the group id it shares with its siblings.
  const keyOf = (s: Subtask) => s.groupId ?? s.id
  const groups = new Map<string, Subtask[]>()
  for (const s of mine) {
    const key = keyOf(s)
    const members = groups.get(key)
    if (members) members.push(s)
    else groups.set(key, [s])
  }
  const views: SubtaskView[] = [...groups.entries()].map(([key, members]) => ({
    id: key,
    // A session's `subtaskId` can name ANY member of the group — the union of their rows is what
    // the group's bucket rolls up, so the same session is never counted once per member.
    rollup: rollupAttempt({
      sessions: rollupSessionsFor(
        rows.filter(r => members.some(m => m.id === r.subtaskId)), metas, costOf,
      ),
    }),
  }))
  const direct = rows.filter(r => !r.subtaskId)
  if (direct.length > 0) {
    views.push({
      id: null,
      rollup: rollupAttempt({ sessions: rollupSessionsFor(direct, metas, costOf) }),
    })
  }
  return views
}

/**
 * The repositories a task's rows touched, in first-seen order.
 *
 * Only a row whose conversation resolves in the store can name one: a row with no link reported no
 * repository, and inventing one from its `cwd` would be a second key for a dimension whose only key
 * is the normalized remote. A task all of whose rows are unlinked therefore names nothing, which is
 * the honest answer and not an empty repository.
 */
export function reposOfRows(
  rows: readonly ManagedSession[],
  metas: ReadonlyMap<string, SessionMeta>,
): string[] {
  const out: string[] = []
  for (const r of rows) {
    const meta = r.conversationId ? metas.get(r.conversationId) : undefined
    if (!meta) continue
    const remote = meta.git_remote ?? ''
    if (!out.includes(remote)) out.push(remote)
  }
  return out
}

export function buildTaskList(o: {
  tasks: readonly Task[]
  attempts: readonly Attempt[]
  rows: readonly ManagedSession[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
  comments?: readonly TaskComment[]
  subtasks?: readonly Subtask[]
  files?: readonly TaskFile[]
}): TaskListRow[] {
  return o.tasks.map(task => {
    const mine = rowsOfTask(task, o.rows)
    const subs = (o.subtasks ?? []).filter(t => t.taskId === task.id)
    return {
      task,
      attempts: o.attempts.filter(a => a.taskId === task.id).length,
      rollup: rollupAttempt({ sessions: rollupSessionsFor(mine, o.metas, o.costOf) }),
      counts: {
        comments: (o.comments ?? []).filter(c => c.taskId === task.id).length,
        subtasks: subs.length,
        subtasksDone: subs.filter(t => t.done).length,
        files: (o.files ?? []).filter(f => f.taskId === task.id).length,
      },
      harnesses: [...new Set(mine.map(r => r.harness))],
      repos: reposOfRows(mine, o.metas),
    }
  })
}

export function buildTaskDetail(o: {
  task: Task
  attempts: readonly Attempt[]
  rows: readonly ManagedSession[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
  comments?: readonly TaskComment[]
  subtasks?: readonly Subtask[]
  files?: readonly TaskFile[]
}): TaskDetail {
  const mine = rowsOfTask(o.task, o.rows)
  const metas = mine
    .map(r => (r.conversationId ? o.metas.get(r.conversationId) : undefined))
    .filter((m): m is SessionMeta => m !== undefined)

  return {
    task: o.task,
    attempts: attemptViews(o.task, o.attempts, mine, o.metas, o.costOf),
    // The task's own total is computed over its rows ONCE, never by summing the attempt rollups:
    // a session filed under no attempt belongs to the task all the same, and summing the views
    // would either double it or drop it depending on which list it landed in.
    rollup: rollupAttempt({ sessions: rollupSessionsFor(mine, o.metas, o.costOf) }),
    stats: taskStats({
      metas,
      createdAt: o.task.createdAt,
      ...(o.task.deliveredAt ? { deliveredAt: o.task.deliveredAt } : {}),
    }),
    // ONE ROW PER CONVERSATION, the same rule the rollup two lines above already applies.
    //
    // This mapped over every registry row while `rollupSessionsFor` deduped, so the LIST and the
    // NUMBERS beside it disagreed: a delivery whose rollup correctly said `2 sessions` drew five
    // rows, one conversation repeated four times, each carrying that conversation's full cost —
    // three `finished` predecessors and the live one. Every attach, reopen and restart mints a new
    // managedId for the same conversation, so the repetition is ordinary rather than exotic, and
    // the tab's own label (`sessions.length`) lied with it.
    //
    // It is the twin of the 2026-09-08 defect recorded on `rollupSessionsFor`, which was fixed in
    // the figures and left in the list standing next to them.
    sessions: distinctConversations(mine).map(r => {
      const meta = r.conversationId ? o.metas.get(r.conversationId) ?? null : null
      return {
        id: r.id,
        harness: r.harness,
        cwd: r.cwd,
        attemptId: r.attemptId ?? null,
        subtaskId: r.subtaskId ?? null,
        createdAt: r.createdAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        ...(r.label ? { label: r.label } : {}),
        ...(r.conversationId ? { conversationId: r.conversationId } : {}),
        tokens: meta ? sessionTokenTotal(meta) : null,
        costUSD: meta ? o.costOf(meta) : null,
        rounds: meta?.user_message_count ?? null,
      }
    }),
    // Newest last, the way a conversation reads.
    comments: [...(o.comments ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    subtasks: [...(o.subtasks ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    files: [...(o.files ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    subtaskRollups: subtaskViews(o.task, o.subtasks ?? [], mine, o.metas, o.costOf),
  }
}

/** By id, then by exact title, then case-insensitively — a person types the name they see. */
export function findTask(ref: string, tasks: readonly Task[]): Task | undefined {
  return tasks.find(t => t.id === ref)
    ?? tasks.find(t => t.title === ref)
    ?? tasks.find(t => t.title.toLowerCase() === ref.toLowerCase())
}
