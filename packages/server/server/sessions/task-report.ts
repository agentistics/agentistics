/**
 * task-report.ts — PURE. The task book plus the fleet plus the store, resolved into what a surface
 * draws. One implementation, read by the CLI, the HTTP route and therefore the web and the MCP.
 *
 * It exists because `agentop task show` and the dashboard must never disagree about what a delivery
 * cost. A second resolution would be a second set of rules, which is the bug `task-reopen.ts` was
 * written to have fixed once.
 */

import { pieceTimes, spanOf, type PieceTimes, type SessionSpan } from './task-times'
import type { SessionMeta, TaskProgress } from '@agentistics/core'
import { commentCounts, commentsByTarget, groupProgress, sessionTokenTotal, threadAttention, threadComments, type CommentTarget } from '@agentistics/core'
import type {
  Attempt, AttemptStatus, Subtask, Task, TaskComment, TaskFile, TaskThread,
} from './task-model'
import { groupMembers, isGroupMember, isGroupSubtask, legacyTaskId } from './task-model'
import { conversationOwners, distinctConversations } from './task-conversations'
import { isHistoricalRow } from './task-historical'
import { isNativeRow, nativeRollupSession } from './task-native'
import { rollupAttempt, type AttemptRollup, type RollupSession } from './task-rollup'
import { scopedTaskStats, taskStats, type TaskStats } from './task-stats'
import type { BoardRow } from './types'

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
  /**
   * True for a conversation filed on the board with NO session behind it (`HistoricalSession`): its
   * numbers are real and it counts everywhere, but there is nothing to open — `id` (`hist:<conv>`)
   * names no session, so a surface must not link to `/sessions/<id>` for it.
   */
  historical?: boolean
  /**
   * True for a NATIVE session (`NativeSessionLink`): `harness` is `'agentistics'`, `id` is the
   * engine's `ses_…` id (it opens at `/sessions/<id>` like any session, and unfiles by it), and its
   * numbers are the engine's snapshot.
   */
  native?: boolean
  /** Null when the conversation is not in the store, or when its harness never recorded one — see
   *  `RollupSession.meta`. Read straight off `SessionMeta.model` (`data.ts` resolves it from the
   *  JSONL when not already in session-meta); never a second guess at what the session ran. */
  model: string | null
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
  counts: {
    /** Every comment of the task — what the task's own thread shows. */
    comments: number
    /**
     * Per subtask/group id, the size of THAT thread (`commentCounts`): a group counts its own
     * comments plus its members'. Absent = none. So the number on a row is what opens when it is
     * pressed.
     */
    commentsBySubtask: Record<string, number>
    subtasks: number; subtasksDone: number; files: number
    /** Threads on the task, and how many of them have a session's word after the person's last one. */
    threads: number
    threadsAwaiting: number
  }
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
  /** Every comment, flat, oldest first — each carries its own `subtaskId` when it has a target. */
  comments: TaskComment[]
  /**
   * The same comments filed under their OWN target (task first, then subtasks in creation order;
   * empty targets omitted) — `commentsByTarget`, with no aggregation. The grouped shape an
   * assistant reads; a surface wanting a group's aggregated thread uses `commentThread`.
   */
  commentThreads: { target: CommentTarget; comments: TaskComment[] }[]
  /** The task's TOPIC threads (`TaskThread`), oldest first. Their comments are in `comments`. */
  threads: TaskThread[]
  subtasks: Subtask[]
  files: TaskFile[]
  subtaskRollups: SubtaskView[]
  /** The whole delivery's times, from every session under it (`task-times.ts`). */
  times: PieceTimes
}

/**
 * The sessions of a task: those stamped with its id, plus those carrying its NAME from before ids
 * existed. The second half is exactly what `legacyTaskId` is for — it is what makes the feature
 * useful on a machine that has been running for months rather than only for work started after it.
 *
 * **A CONVERSATION IS ONE TASK'S, NEVER TWO.** A row that matches is kept only when the conversation
 * it points at BELONGS to this task (`conversationOwners`: the newest filing statement wins). Without
 * that, a conversation moved from task A to task B — filing is a move written on one row, so the
 * older row still says A — was listed and priced by BOTH, and every sum across tasks
 * (`buildBoardOverview`'s headline) counted it twice. A row with no `conversationId` cannot be shown
 * to belong to anyone else and keeps belonging to whatever task it names.
 *
 * `rows` MUST be the whole registry: ownership is a fact about every row of a conversation, so a
 * caller handing over a pre-filtered subset would compute it from the rows that agree with `task`.
 * Callers that ask about many tasks pass `owners` (computed once, `conversationOwners(rows)`) instead
 * of paying for it per task.
 */
export function rowsOfTask<R extends BoardRow>(
  task: Pick<Task, 'id'>,
  rows: readonly R[],
  owners: ReadonlyMap<string, string> = conversationOwners(rows),
): R[] {
  return rows.filter(r =>
    (r.taskId === task.id
      || (r.task !== undefined && legacyTaskId(r.task) === task.id))
    && (!r.conversationId || owners.get(r.conversationId) === task.id))
}

// The rule lives in `task-conversations.ts` (see there); re-exported so this module stays the one
// door every existing caller imports it through.
export { distinctConversations }

/**
 * HOW MANY SESSIONS ARE FILED ON A SUBTASK RIGHT NOW — the ONE answer, read by the write-side gates
 * (`patchSubtask`'s `subtask_has_sessions` group-join refusal and its `done_needs_session` gate) and
 * agreeing by construction with the read side (`subtaskViews`, `subtaskStats`), which bucket the very
 * same rows.
 *
 * A subtask "has a session" iff some CONVERSATION, described by its NEWEST row and owned by THIS task,
 * is filed on it: `distinctConversations(rowsOfTask(task, rows))`, then the ones naming `subtaskId`.
 * Counting RAW rows instead (`rows.some(r => r.subtaskId === id)`) is the bug this exists to prevent.
 * Every attach, reopen and restart mints a new managed id for the same conversation and retires the
 * old row WITHOUT removing it, and filing is a MOVE written on the newest row only — so a conversation
 * the person moved from subtask X to subtask Y still has an old row saying X. The board shows X with 0
 * sessions (the read side describes the conversation by its newest row), while a raw-row gate said X
 * had one: `subtask_has_sessions` on a group join, "detach the session first", with nothing on screen
 * to detach. Measured on the board task t-0539886b9c, subtask F5.2.
 *
 * `rows` MUST be the whole `rollupRows` — the registry plus the historical links — for the same reason
 * `rowsOfTask` says: ownership is a fact about every row of a conversation. A historical link counts
 * exactly like a live one (it is why they exist). A row with NO conversation link cannot be shown to
 * be a duplicate of anything and keeps counting on the subtask it names.
 *
 * Callers that ask about many subtasks pass `owners` (computed once) instead of paying for it each time.
 */
export function subtaskSessionCount(
  task: Pick<Task, 'id'>,
  subtaskId: string,
  rows: readonly BoardRow[],
  owners?: ReadonlyMap<string, string>,
): number {
  return distinctConversations(rowsOfTask(task, rows, owners)).filter(r => r.subtaskId === subtaskId).length
}

/** `subtaskSessionCount(...) > 0` — the question every write-side gate actually asks. */
export function subtaskHasSession(
  task: Pick<Task, 'id'>,
  subtaskId: string,
  rows: readonly BoardRow[],
  owners?: ReadonlyMap<string, string>,
): boolean {
  return subtaskSessionCount(task, subtaskId, rows, owners) > 0
}

/**
 * One `RollupSession` per CONVERSATION (`distinctConversations`).
 *
 * `provenance` is READ from the record rather than guessed: a link with no `conversationLink` was
 * written before that field existed and was an assigned one. A row whose conversation is not in the
 * store yields `meta: null` and still counts as a session used.
 *
 * `costMeasured` stays unset: nothing reads a harness's own cost figure yet, and claiming a figure
 * is measured when it was estimated is precisely the confusion that field exists to prevent.
 */
export function rollupSessionsFor(
  rows: readonly BoardRow[],
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
    // A NATIVE session's numbers are the engine's own snapshot (`task-native.ts`), never a meta.
    if (isNativeRow(r)) return nativeRollupSession(r)
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
  allRows: readonly BoardRow[],
  metas: ReadonlyMap<string, SessionMeta>,
  costOf: (m: SessionMeta) => number,
): AttemptView[] {
  // PARTITION THE CONVERSATIONS, NOT THE ROWS. A conversation reopened under a different attempt
  // has one row per reopening, each carrying the attempt it was filed under at the time; filtering
  // first and deduping inside each bucket counted the conversation once PER bucket it ever touched.
  // Deduping first makes the newest row — the current filing — the only one that is bucketed, so
  // every conversation lands in exactly one bucket. Idempotent: a caller that already deduped
  // (`buildTaskDetail`) pays nothing.
  const rows = distinctConversations(allRows)
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

/** One rollup for a subtask, a GROUP (§F.1), or the direct branch (`id: null`) — sessions filed on
 *  the task itself, under no subtask. Every row of a task falls into EXACTLY one of these buckets:
 *  a group MEMBER never appears here at all (it can never hold a session, so it has nothing to roll
 *  up — see `subtaskViews`), and everything else partitions `rowsOfTask(task, rows)` completely, the
 *  same guarantee `filedUnder` already gives every session a single owner. */
export interface SubtaskView {
  /** A loose subtask's own id, or a GROUP's own id — never a per-member id, because a member can
   *  never be the target of a filing to begin with. */
  id: string | null
  rollup: AttemptRollup
  /**
   * Set only when `id` names a GROUP (§F.1) — its own progress, from its members' `status`
   * (`groupProgress`, `@agentistics/core`, the same round-down rule `taskProgress` applies to a
   * task's own subtasks, one level down). Computed here rather than left for a reader to re-derive:
   * a caller counting `done` members itself would be a second implementation of the one rounding
   * rule this whole feature is built to keep single. Absent for a loose subtask or the direct
   * (`id: null`) bucket — neither has members to compute a percentage over.
   */
  groupProgress?: TaskProgress
  /**
   * The same delivery-evidence numbers `TaskDetail.stats` carries for the whole task, re-partitioned
   * to this bucket's own rows — files/errors/lines/tokens/commits/models/harnesses/duration. `null`
   * when nothing is filed under this bucket yet (see `scopedTaskStats`'s own null-vs-empty-block
   * distinction), never a block whose every field happens to be null. See
   * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §C.5.
   */
  stats: TaskStats | null
  /**
   * When this piece started / finished and how long it was ACTIVE, read from its sessions
   * (`task-times.ts`) — the status stamps answer only when no session is linked. A GROUP aggregates
   * its members' own times, since a member never holds a session itself.
   */
  times: PieceTimes
}

/**
 * A rollup per BUCKETABLE subtask (a loose subtask, or a GROUP — §F.1), plus one `id: null` bucket
 * for the sessions filed on the delivery directly — the same pattern `attemptViews` already applies
 * to attempts, over the same partition.
 *
 * `rows` is expected already scoped to the task (`rowsOfTask(task, allRows)`), exactly like
 * `attemptViews`'s own `rows` parameter — this never re-derives that scope, and never re-sums the
 * partitions back into a total: `TaskDetail.rollup` is computed once, over the whole set, and this
 * is only ever a breakdown of it. A subtask with no sessions filed under it yet still gets a row —
 * "nothing filed here" is a real, empty measurement, not an omission.
 *
 * **A GROUP MEMBER (`Subtask.parentGroupId` set) gets NO bucket of its own at all** — this
 * SUPERSEDES the §B "shared bucket" model (docs/superpowers/specs/
 * 2026-09-11-alm-session-linking-ux.md §F, which replaces §B.2–§B.5). Under §F.1 a member can never
 * hold a session directly (refused at filing time, `subtask_in_group` — `task-attach.ts`), so there
 * is nothing for it to roll up; publishing an always-empty view for it would be the same "measured,
 * and confidently zero" defect this codebase refuses everywhere else for a metric that was never
 * measurable to begin with. **A GROUP's own bucket is the sessions filed DIRECTLY on the group's own
 * subtask record** — simpler than §B's union-of-members, because under §F a member is never the
 * target of a filing, so there is nothing to union. A loose subtask (neither `isGroup` nor
 * `parentGroupId`) is bucketed by its own id, completely unaffected by any of this — exactly
 * today's pre-§B behaviour.
 */
/** The spans of the conversations behind these rows — meta first, the registry row as the fallback. */
function spansOfRows(rows: readonly BoardRow[], metas: ReadonlyMap<string, SessionMeta>): SessionSpan[] {
  const out: SessionSpan[] = []
  for (const r of rows) {
    const m = r.conversationId ? metas.get(r.conversationId) : undefined
    const span = spanOf({
      ...(m?.start_time ? { metaStart: m.start_time } : {}),
      ...(m?.end_time ? { metaEnd: m.end_time } : {}),
      ...(typeof m?.active_minutes === 'number' ? { activeMin: m.active_minutes } : {}),
      rowCreatedAt: r.createdAt,
      ...(r.endedAt ? { rowEndedAt: r.endedAt } : {}),
    })
    if (span) out.push(span)
  }
  return out
}

/** A group's times: its own sessions plus its members' pieces (a member holds none, so theirs are status-derived). */
function groupTimes(group: Subtask, members: readonly Subtask[], ownSpans: SessionSpan[]): PieceTimes {
  const own = pieceTimes({
    spans: ownSpans, done: group.done,
    ...(group.startedAt ? { statusStartedAt: group.startedAt } : {}),
    ...(group.deliveredAt ? { statusDeliveredAt: group.deliveredAt } : {}),
  })
  if (own.source === 'sessions' || members.length === 0) return own
  const parts = members.map(m => pieceTimes({
    spans: [], done: m.done,
    ...(m.startedAt ? { statusStartedAt: m.startedAt } : {}),
    ...(m.deliveredAt ? { statusDeliveredAt: m.deliveredAt } : {}),
  }))
  const starts = parts.map(p => p.startedAt).filter((x): x is string => !!x).sort()
  const ends = parts.map(p => p.completedAt).filter((x): x is string => !!x).sort()
  const startedAt = own.startedAt ?? starts[0] ?? null
  const completedAt = group.done ? (own.completedAt ?? (ends.length === members.length ? ends.at(-1)! : null)) : null
  const a = startedAt ? Date.parse(startedAt) : NaN
  const b = completedAt ? Date.parse(completedAt) : NaN
  return {
    startedAt, completedAt,
    durationMs: Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null,
    activeMinutes: null,
    source: startedAt || completedAt ? 'status' : null,
  }
}

export function subtaskViews(
  task: Task,
  subtasks: readonly Subtask[],
  allRows: readonly BoardRow[],
  metas: ReadonlyMap<string, SessionMeta>,
  costOf: (m: SessionMeta) => number,
): SubtaskView[] {
  // Same rule as `attemptViews`, and it matters more here because a filing is a MOVE: a conversation
  // filed on three subtasks in turn holds three rows, and only the newest names where it is NOW.
  // Bucketing before deduping put its cost under every subtask it ever visited and left the current
  // one unmeasured whenever an older row happened to come first.
  const rows = distinctConversations(allRows)
  const mine = subtasks.filter(s => s.taskId === task.id)
  // Every subtask that is NOT a group member gets its own bucket, keyed by its own id — a loose
  // subtask exactly as before, a group by the same rule (its rollup is simply the rows filed on
  // its own id, since no member can ever carry one).
  const bucketable = mine.filter(s => !isGroupMember(s))
  // One pass over `mine`, building the group -> members mapping `groupMembers` would otherwise
  // re-derive per group inside the `.map()` below (an O(groups × subtasks) re-scan instead of this
  // single O(subtasks) pass) — same membership `groupMembers` computes, just computed once. Order
  // matches `groupMembers`'s own "in the order they were created": `mine` is already in that order,
  // and this appends members as they are encountered.
  const membersByGroup = new Map<string, Subtask[]>()
  for (const s of mine) {
    if (!isGroupMember(s)) continue
    const list = membersByGroup.get(s.parentGroupId!)
    if (list) list.push(s)
    else membersByGroup.set(s.parentGroupId!, [s])
  }
  const views: SubtaskView[] = bucketable.map(s => {
    const mineRows = rows.filter(r => r.subtaskId === s.id)
    return {
      id: s.id,
      rollup: rollupAttempt({ sessions: rollupSessionsFor(mineRows, metas, costOf) }),
      stats: scopedTaskStats({
        rows: mineRows, metas, createdAt: task.createdAt,
        ...(task.deliveredAt ? { deliveredAt: task.deliveredAt } : {}),
      }),
      ...(isGroupSubtask(s)
        ? { groupProgress: groupProgress((membersByGroup.get(s.id) ?? []).map(m => m.done)) }
        : {}),
      times: isGroupSubtask(s) ? groupTimes(s, membersByGroup.get(s.id) ?? [], spansOfRows(mineRows, metas)) : pieceTimes({
        spans: spansOfRows(mineRows, metas), done: s.done,
        ...(s.startedAt ? { statusStartedAt: s.startedAt } : {}),
        ...(s.deliveredAt ? { statusDeliveredAt: s.deliveredAt } : {}),
      }),
    }
  })
  const direct = rows.filter(r => !r.subtaskId)
  if (direct.length > 0) {
    views.push({
      id: null,
      rollup: rollupAttempt({ sessions: rollupSessionsFor(direct, metas, costOf) }),
      stats: scopedTaskStats({
        rows: direct, metas, createdAt: task.createdAt,
        ...(task.deliveredAt ? { deliveredAt: task.deliveredAt } : {}),
      }),
      times: pieceTimes({ spans: spansOfRows(direct, metas), done: Boolean(task.deliveredAt) }),
    })
  }
  return views
}

/**
 * What is VISIBLE from a session filed on a GROUP (§F.2): the group itself and every one of its
 * members — never a sibling subtask/group of the same parent task, and never the parent task.
 * Visibility is downward-only, and the boundary is where the session is filed — the same
 * "hierarchy is a filter, never a merge" reasoning `rowsOfTask` already applies at the task level
 * (§A.3 of docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md).
 *
 * Returns the empty list for anything that is not, right now, an actual group — the id names no
 * subtask, or names one that is not `isGroup: true`. This is the pure building block a route/UI
 * scoping a session's aside to its group would filter subtasks/comments/rows against; it does not
 * itself touch comments (their thread rule — a group shows its own and its members' — lives in
 * `@agentistics/core`'s `commentThreads.ts`) or sessions — a caller filters those by the ids this
 * returns.
 */
export function groupVisibility(groupId: string, subtasks: readonly Subtask[]): readonly string[] {
  const group = subtasks.find(s => s.id === groupId)
  if (!group || !isGroupSubtask(group)) return []
  return [group.id, ...groupMembers(groupId, subtasks).map(m => m.id)]
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
  rows: readonly BoardRow[],
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

/** The board card's thread figures — the same `threadAttention` the task page draws. */
function threadCounts(taskId: string, threads: readonly TaskThread[], comments: readonly TaskComment[]): { threads: number; threadsAwaiting: number } {
  const mine = threads.filter(t => t.taskId === taskId)
  let awaiting = 0
  for (const t of mine) if (threadAttention(t, threadComments(comments, t.id)) === 'awaiting') awaiting++
  return { threads: mine.length, threadsAwaiting: awaiting }
}

export function buildTaskList(o: {
  tasks: readonly Task[]
  attempts: readonly Attempt[]
  rows: readonly BoardRow[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
  comments?: readonly TaskComment[]
  threads?: readonly TaskThread[]
  subtasks?: readonly Subtask[]
  files?: readonly TaskFile[]
}): TaskListRow[] {
  // Ownership is decided ONCE over the whole registry, not once per task.
  const owners = conversationOwners(o.rows)
  return o.tasks.map(task => {
    const mine = rowsOfTask(task, o.rows, owners)
    const subs = (o.subtasks ?? []).filter(t => t.taskId === task.id)
    const comments = commentCounts((o.comments ?? []).filter(c => c.taskId === task.id), subs)
    return {
      task,
      attempts: o.attempts.filter(a => a.taskId === task.id).length,
      rollup: rollupAttempt({ sessions: rollupSessionsFor(mine, o.metas, o.costOf) }),
      counts: {
        comments: comments.task,
        commentsBySubtask: comments.bySubtask,
        subtasks: subs.length,
        subtasksDone: subs.filter(t => t.done).length,
        files: (o.files ?? []).filter(f => f.taskId === task.id).length,
        ...threadCounts(task.id, o.threads ?? [], o.comments ?? []),
      },
      harnesses: [...new Set(mine.map(r => r.harness))],
      repos: reposOfRows(mine, o.metas),
    }
  })
}

export function buildTaskDetail(o: {
  task: Task
  attempts: readonly Attempt[]
  rows: readonly BoardRow[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
  comments?: readonly TaskComment[]
  threads?: readonly TaskThread[]
  subtasks?: readonly Subtask[]
  files?: readonly TaskFile[]
}): TaskDetail {
  // ONE ROW PER CONVERSATION, decided ONCE and handed to everything below — the newest row of each
  // conversation, because it carries the current filing and the current liveness. Every figure and
  // every list on this detail reads the same set, so a conversation cannot be in the list and
  // missing from a bucket, or counted twice in the evidence block, or filed in two places.
  const mine = distinctConversations(rowsOfTask(o.task, o.rows))
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
    times: pieceTimes({
      spans: spansOfRows(mine, o.metas), done: Boolean(o.task.deliveredAt),
      ...(o.task.startedAt ? { statusStartedAt: o.task.startedAt } : {}),
      ...(o.task.deliveredAt ? { statusDeliveredAt: o.task.deliveredAt } : {}),
    }),
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
    sessions: mine.map(r => {
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
        ...(isHistoricalRow(r) ? { historical: true } : {}),
        ...(isNativeRow(r) ? { native: true } : {}),
        ...(isNativeRow(r)
          ? {
            model: r.nativeUsage?.model ?? null,
            tokens: r.nativeUsage?.tokens ?? null,
            costUSD: r.nativeUsage?.costUSD ?? null,
            rounds: r.nativeUsage?.rounds ?? null,
          }
          : {
            model: meta?.model ?? null,
            tokens: meta ? sessionTokenTotal(meta) : null,
            costUSD: meta ? o.costOf(meta) : null,
            rounds: meta?.user_message_count ?? null,
          }),
      }
    }),
    // Newest last, the way a conversation reads.
    comments: [...(o.comments ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    commentThreads: commentsByTarget(
      o.comments ?? [],
      [...(o.subtasks ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ),
    threads: [...(o.threads ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
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
