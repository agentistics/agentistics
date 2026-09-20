/**
 * task-web.ts — `/api/tasks`, the one door the web, the VS Code extension and the MCP come through.
 *
 * It holds NO arithmetic: `task-source.ts` reads and `task-report.ts` decides, exactly as the CLI
 * does. A surface that computed a rollup of its own would be a second answer to "what did this
 * delivery cost", and the two would drift.
 */

import type { StagedSessionDraft } from '@agentistics/core'
import { loadTaskWorld } from './task-source'
import { buildTaskDetail, buildTaskList, findTask, rowsOfTask } from './task-report'
import { planDeliveryEvidence, type DeliveryEvidence } from './task-evidence'
import { buildBoardOverview, type BoardOverview } from './task-overview'
import { scopeMetas, type TaskFilter } from './task-filter'
import { getCommitsInWindow } from '../git'
import { readPreferences, writePreferences } from '../preferences'
import {
  isGroupMember, legacyTaskId, migratePriority, newCommentId, newEventId, newFileId, newLinkId,
  newSubtaskId, newTaskId, statusAfterAttach, statusAfterSubtaskProgress, subtaskDone,
  type Task, type TaskEvent, type TaskStatus,
} from './task-model'
import { boardProgress, DEFAULT_LEASE_MS, planNext } from './task-next'
import { checkParentGroup, planAttach, sanitizeSubtaskBlockedBy } from './task-attach'
import { planMove } from './task-rank'
import { compareBy } from '@agentistics/core'
import { deleteTaskFile, deleteTaskFiles, readTaskFile, writeTaskFile } from './task-files'
import type { TaskDetail, TaskListRow } from './task-report'

export interface TaskListReply {
  tasks: TaskListRow[]
  /** The board as a whole — what the page shows FIRST, before any kanban. */
  overview: BoardOverview
  /**
   * How many sessions the page's filters kept out of these numbers.
   *
   * Reported rather than swallowed: a rollup that silently shrank is the same defect as a confident
   * zero — the figure is smaller and nothing on screen says why.
   */
  excludedByFilter: number
}

export interface TaskDetailReply {
  task: TaskDetail
  /** See `TaskListReply.excludedByFilter`. */
  excludedByFilter?: number
  /** Present only once the task has been delivered. */
  evidence?: DeliveryEvidence
}

export async function listTasks(filter?: TaskFilter): Promise<TaskListReply> {
  const w = await loadTaskWorld()
  const scoped = scopeMetas(w.metas, filter)
  return {
    tasks: buildTaskList({
      tasks: w.book.tasks,
      attempts: w.book.attempts,
      rows: w.rows,
      metas: scoped.metas,
      costOf: w.costOf,
      comments: w.book.comments,
      subtasks: w.book.subtasks,
      files: w.book.files,
    }),
    overview: buildBoardOverview({
      tasks: w.book.tasks, rows: w.rows, metas: scoped.metas, costOf: w.costOf,
    }),
    excludedByFilter: scoped.excluded,
  }
}

export async function showTask(
  ref: string,
  filter?: TaskFilter,
): Promise<TaskDetailReply | null> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return null
  const scoped = scopeMetas(w.metas, filter)
  return {
    excludedByFilter: scoped.excluded,
    task: buildTaskDetail({
      task,
      attempts: w.book.attempts,
      rows: w.rows,
      metas: scoped.metas,
      costOf: w.costOf,
      comments: w.book.comments.filter(c => c.taskId === task.id),
      subtasks: w.book.subtasks.filter(t => t.taskId === task.id),
      files: w.book.files.filter(f => f.taskId === task.id),
    }),
  }
}

/** Create a task. Title is required; a description is not — a task nobody described is a task. */
export async function createTask(o: { title: string; detail?: string }): Promise<Task | null> {
  const title = o.title.trim()
  if (!title) return null
  const w = await loadTaskWorld()
  // Same title = same work. Creating a second one silently would split a delivery's metrics in two
  // with nothing on screen saying why.
  const existing = w.book.tasks.find(t => t.title === title)
  if (existing) return existing
  // Creating a name again lifts its tombstone: the delete was about that record, not a ban on the
  // words.
  await w.store.clearTombstone(legacyTaskId(title))
  const now = new Date().toISOString()
  const task: Task = {
    id: newTaskId(),
    title,
    status: 'todo',
    createdAt: now,
    updatedAt: now,
    ...(o.detail?.trim() ? { detail: o.detail.trim() } : {}),
  }
  await w.store.upsertTask(task)
  return task
}

export async function editTask(
  ref: string,
  patch: {
    title?: string
    detail?: string
    priority?: string
    assignee?: string
    dueDate?: string
    startDate?: string
    labels?: string[]
    /** Opt this delivery in or out of travelling to the centrals this machine is connected to. */
    shared?: boolean
    actor?: string
  },
): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const now = new Date().toISOString()
  // An UNKNOWN priority word is refused rather than coerced: `migratePriority` would read it as
  // `none`, which is a real answer ("nobody has said") and would silently overwrite a real one.
  const priority = patch.priority !== undefined ? migratePriority(patch.priority) : undefined
  const ok = await w.store.patchTask(task.id, {
    ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
    // An EMPTY description is a deliberate clearing, which is why it is not filtered out the way an
    // empty title is: a title is an identity, a description is a note. Same for every field below:
    // an empty string CLEARS, an absent key leaves the value alone.
    ...(patch.detail !== undefined ? { detail: patch.detail.trim() } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(patch.assignee !== undefined ? { assignee: patch.assignee.trim() } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate.trim() } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate.trim() } : {}),
    ...(patch.labels !== undefined
      ? { labels: patch.labels.map(l => l.trim()).filter(Boolean) }
      : {}),
    // Written as a BOOLEAN, never as an absence: turning sharing off must record `false` rather
    // than delete the key, so the log and the switch both say a person decided it. Absent still
    // READS as not shared (`taskShared`) — the two are the same for the uploader and different
    // for a reader asking whether anybody has ever chosen.
    ...(patch.shared !== undefined ? { shared: patch.shared === true } : {}),
    updatedAt: now,
  })
  if (!ok) return false
  const changes: TaskEvent[] = []
  const actor = patch.actor?.trim() || 'you'
  if (priority !== undefined && priority !== (task.priority ?? 'none')) {
    changes.push(event(task.id, actor, 'priority', { from: task.priority ?? 'none', to: priority }))
  }
  if (patch.shared !== undefined && (patch.shared === true) !== (task.shared === true)) {
    // Logged like every other decision: which central a delivery's text reaches is exactly the
    // kind of change somebody may need to account for later.
    changes.push(event(task.id, actor, 'shared', {
      from: task.shared === true ? 'shared' : 'not shared',
      to: patch.shared === true ? 'shared' : 'not shared',
    }))
  }
  if (patch.assignee !== undefined && patch.assignee.trim() !== (task.assignee ?? '')) {
    changes.push(event(task.id, actor, 'assign', {
      from: task.assignee ?? '', to: patch.assignee.trim() || 'nobody',
    }))
  }
  await w.store.logEvents(changes)
  return true
}

/** One log line. The store caps the log; this only ever writes what happened. */
function event(
  taskId: string,
  actor: string,
  kind: string,
  o: { from?: string; to?: string; detail?: string } = {},
): TaskEvent {
  return {
    id: newEventId(), taskId, actor, kind, at: new Date().toISOString(),
    ...(o.from !== undefined ? { from: o.from } : {}),
    ...(o.to !== undefined ? { to: o.to } : {}),
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
  }
}

/**
 * TAKE a task — the multi-agent primitive.
 *
 * The decision is the store's, under the lock (see `TaskStore.claimTask`); this layer only resolves
 * the reference, defaults the lease, and records what happened. A refusal NAMES the holder and when
 * their lease runs out, because "somebody has it" without saying who leaves the caller with nothing
 * to do but retry blindly.
 */
export async function claimTask(o: {
  ref: string
  by: string
  leaseMs?: number
  sessionId?: string
  note?: string
  takeover?: boolean
}): Promise<{ ok: boolean; task?: Task; reason?: string; heldBy?: string; until?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(o.ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const by = o.by.trim()
  if (!by) return { ok: false, reason: 'no_actor' }
  const res = await w.store.claimTask({
    id: task.id, by, nowMs: Date.now(),
    leaseMs: o.leaseMs && o.leaseMs > 0 ? o.leaseMs : DEFAULT_LEASE_MS,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.note ? { note: o.note } : {}),
    ...(o.takeover ? { takeover: true } : {}),
  })
  if (!res.ok) {
    return {
      ok: false,
      reason: res.reason,
      ...(res.task?.claim ? { heldBy: res.task.claim.by, until: res.task.claim.expiresAt } : {}),
    }
  }
  await w.store.logEvents([event(task.id, by, 'claim', {
    to: res.task.claim?.expiresAt ?? '',
    ...(o.takeover ? { detail: 'takeover' } : {}),
  })])
  return { ok: true, task: res.task }
}

export async function releaseTask(o: { ref: string; by: string; force?: boolean }):
Promise<{ ok: boolean; reason?: string; heldBy?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(o.ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const res = await w.store.releaseTask({
    id: task.id, by: o.by.trim(), ...(o.force ? { force: true } : {}),
  })
  if (!res.ok) {
    return { ok: false, reason: res.reason, ...(res.task?.claim ? { heldBy: res.task.claim.by } : {}) }
  }
  await w.store.logEvents([event(task.id, o.by.trim() || 'you', 'release')])
  return { ok: true }
}

/**
 * What an agent can pick up right now, and why the rest is withheld.
 *
 * The FILTER applies to the sessions a task's numbers are read from, not to which tasks exist, so
 * this deliberately takes none: "what can I work on" is not a question about a date range.
 */
export async function nextTasks(o: { actor?: string; limit?: number } = {}): Promise<{
  ready: Array<{ task: Task; position: number }>
  withheld: Array<{ id: string; title: string; why: string; detail?: string }>
  progress: ReturnType<typeof boardProgress>
}> {
  const w = await loadTaskWorld()
  const nowMs = Date.now()
  const plan = planNext({
    tasks: w.book.tasks, nowMs,
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
  })
  return {
    ready: plan.ready,
    withheld: plan.withheld.map(x => ({
      id: x.task.id,
      title: x.task.title,
      why: x.why.reason,
      ...(x.why.reason === 'blocked' ? { detail: x.why.by.join(', ') } : {}),
      ...(x.why.reason === 'claimed' ? { detail: `${x.why.by} until ${x.why.until}` } : {}),
      ...(x.why.reason === 'status' ? { detail: x.why.status } : {}),
    })),
    progress: boardProgress(w.book.tasks, nowMs),
  }
}

/** The activity log, newest FIRST here — a reader starts at what just happened. */
export async function taskActivity(o: { ref?: string; limit?: number } = {}): Promise<TaskEvent[]> {
  const w = await loadTaskWorld()
  const task = o.ref ? findTask(o.ref, w.book.tasks) : null
  if (o.ref && !task) return []
  const all = task ? w.book.events.filter(e => e.taskId === task.id) : w.book.events
  const newestFirst = [...all].reverse()
  return o.limit !== undefined ? newestFirst.slice(0, Math.max(0, o.limit)) : newestFirst
}

/**
 * Move a card by hand, within the column it is being dropped into.
 *
 * `index` is the position among the cards of that STATUS after the move, which is what a drag
 * actually knows. Moving between columns is a status change and is `markTask`'s job — done here it
 * would be two facts written by one call, and a failure halfway would leave the card in a column
 * its status does not name.
 */
export async function moveTask(o: { ref: string; index: number; actor?: string }):
Promise<{ ok: boolean; reason?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(o.ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const column = w.book.tasks
    .filter(t => t.status === task.status)
    .sort((a, b) => compareBy({ key: 'manual', dir: 'asc' }, { task: a }, { task: b }))
  await w.store.setRanks(planMove(column, task.id, o.index))
  await w.store.logEvents([event(task.id, o.actor?.trim() || 'you', 'move', {
    detail: `${task.status}#${o.index + 1}`,
  })])
  return { ok: true }
}

export async function deleteTask(ref: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const ok = await w.store.removeTask(task.id)
  if (!ok) return false
  // The bytes go with the record. The SESSIONS do not — see `TaskStore.removeTask`.
  await deleteTaskFiles(task.id)
  // And the NAME leaves `preferences.finishedTasks`, which is the other place the migration reads
  // from: a tombstone alone would stop the re-mint while the cockpit went on listing it as finished.
  const prefs = await readPreferences().catch(() => null)
  const current = prefs?.finishedTasks ?? []
  if (current.includes(task.title)) {
    await writePreferences({ finishedTasks: current.filter(t => t !== task.title) }).catch(() => undefined)
  }
  return true
}

export async function addComment(ref: string, o: { author: string; body: string }): Promise<boolean> {
  const body = o.body.trim()
  if (!body) return false
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  await w.store.addComment({
    id: newCommentId(),
    taskId: task.id,
    author: o.author.trim() || 'unknown',
    body,
    createdAt: new Date().toISOString(),
  })
  return true
}

/** An empty body is a DELETE by another name, so it is refused rather than silently blanking a row. */
export async function editComment(commentId: string, body: string): Promise<boolean> {
  const text = body.trim()
  if (!text) return false
  const w = await loadTaskWorld()
  return await w.store.editComment(commentId, text)
}

export async function removeComment(commentId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  return await w.store.removeComment(commentId)
}

/**
 * Add a subtask — loose by default, or a GROUP (§F.1) when `o.isGroup` is true. `isGroup` is decided
 * only here: nothing today offers a way to convert an existing subtask into a group afterwards (or
 * a group back into a loose subtask), so a group's shape is fixed at creation.
 *
 * Returns the new subtask's id, or `null` on failure — the "create a group with…" gesture needs the
 * id back to join both the picked sibling and the row it was started from to it in the same flow
 * (`patchSubtask({ parentGroupId })`), which a bare boolean could not carry.
 */
export async function addSubtask(
  ref: string, title: string, o: { isGroup?: boolean } = {},
): Promise<string | null> {
  const t = title.trim()
  if (!t) return null
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return null
  const now = new Date().toISOString()
  const id = newSubtaskId()
  await w.store.upsertSubtask({
    id, taskId: task.id, title: t,
    status: 'todo', done: false, createdAt: now, updatedAt: now,
    ...(o.isGroup === true ? { isGroup: true } : {}),
  })
  return id
}

/**
 * Change any column of a subtask.
 *
 * `done` is never taken from the caller — it is derived from `status`, because two fields for one
 * fact drift and a row reading `done: false, status: 'done'` has no correct interpretation. A
 * caller that ticks the box sends `status: 'done'`; one that moves the status gets the tick free.
 *
 * A move INTO `done` requires a session filed under this specific subtask — see
 * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §A.2. The guard is
 * `found.status !== 'done'`: a patch that is not actually a transition into `done` (editing the due
 * date of an already-done subtask) must not re-trigger it.
 *
 * `parentGroupId` (joining/leaving a group, §F.1) is checked BEFORE any of the above: a bad
 * reference is refused outright (`invalid_group`) rather than silently dropped, because joining a
 * group is a deliberate act and a caller who asked to join something needs to know it did not
 * happen — see `checkParentGroup`. Joining a group is ALSO refused when the subtask already has a
 * session filed on it (`subtask_has_sessions`) — a MEMBER never gets a rollup bucket of its own
 * (`subtaskViews` excludes it outright), so that session's cost would silently drop out of every
 * visible breakdown the instant it joins, while the task's own total keeps counting it.
 *
 * The `done_needs_session` gate below is SKIPPED for a group MEMBER (`Subtask.parentGroupId` set):
 * `task-attach.ts`'s `planAttach` unconditionally refuses filing a session on a member
 * (`subtask_in_group`), so a member can never satisfy "a session filed under this specific
 * subtask" — checking it here would make `done` permanently unreachable for every member and
 * defeat the whole point of `groupProgress` (§F.1): a member earns `done` through its own
 * completion (comments/attachments/status), never through a session it can never carry. A subtask
 * that is itself a GROUP (`isGroup: true`) keeps the gate unchanged — it is filed on exactly like a
 * loose subtask and still needs one of its own to close.
 *
 * That membership check runs against the EFFECTIVE post-patch `parentGroupId`
 * (`nextParentGroupId`), never against `found`'s pre-patch value: a single PATCH can combine
 * leaving a group (`parentGroupId: ''`) with `status: 'done'` in one call, and `found` still names
 * the OLD group while the record actually being written is already a loose subtask. Gating on the
 * stale value let a member leave its group and reach `done` with zero sessions filed on it, in one
 * request — the exact invariant this gate exists to hold.
 *
 * **The legacy `groupId` (§B) and the current `isGroup`/`parentGroupId` pair (§F) may never both
 * name a group on the same record** — two independent, unreconciled "which group" answers on one
 * subtask. Refused (`group_field_conflict`, the same 422 shape as `invalid_group`) rather than
 * having one silently win over the other, checked ONLY when this patch actually writes to one of
 * the two fields — an old row that already carries a stale `groupId` from before this rule existed
 * is left alone until the caller next touches either column. `isGroup` itself is never checked here
 * because it is decided at creation and this patch type offers no way to change it.
 *
 * `stagedSession` (board task t-918cc82233) is refused with `subtask_in_group` when this subtask is
 * a group MEMBER — reusing `isGroupMember`, never reimplementing the rule `task-attach.ts` already
 * states for filing a real session: a member can never receive one, so a draft that could never be
 * fired there is refused at the same point, judged against the EFFECTIVE post-patch
 * `parentGroupId` (`nextParentGroupId`) for the same reason the `done` gate below is. CLEARING the
 * draft (`stagedSession: null`) is never refused this way — a stale draft left over from before a
 * subtask joined a group must still be removable.
 */
export async function patchSubtask(subtaskId: string, patch: {
  title?: string
  status?: TaskStatus
  assignee?: string
  dueDate?: string
  startDate?: string
  sessionId?: string
  notes?: string
  /** Sanitized against this subtask's OWN siblings — see `sanitizeSubtaskBlockedBy`. */
  blockedBy?: string[]
  /**
   * SUPERSEDED (§F) — see `Subtask.groupId`'s own docblock in `task-model.ts`. Still writable so
   * the §B-era UI keeps working until it moves to `parentGroupId`; no longer read by `subtaskViews`.
   */
  groupId?: string | null
  /**
   * Join (a group's own subtask id) or leave (`null`) a group — §F.1. Refused with
   * `invalid_group` when the id does not name an actual group of this SAME task, or when this
   * subtask is itself a group (a group can never be a member); refused with
   * `subtask_has_sessions` when this subtask already has a session filed on it — see
   * `checkParentGroup`.
   */
  parentGroupId?: string | null
  /** Set (a validated draft) or clear (`null`) the staged session — see this function's own note. */
  stagedSession?: StagedSessionDraft | null
}): Promise<
  {
    ok: true
  } | {
    ok: false
    message:
      | 'no_such_subtask' | 'done_needs_session' | 'invalid_group' | 'subtask_has_sessions'
      | 'group_field_conflict' | 'subtask_in_group'
  }
> {
  const w = await loadTaskWorld()
  const found = w.book.subtasks.find(t => t.id === subtaskId)
  if (!found) return { ok: false, message: 'no_such_subtask' }

  // Computed once, before any of the checks below: whether THIS subtask id already has a session
  // filed on it right now, regardless of what it is currently filed under. Read by `checkParentGroup`
  // (`subtask_has_sessions`) and by the `done_needs_session` gate further down — both ask the exact
  // same question.
  const hasSession = w.rows.some(r => r.subtaskId === found.id)

  // The EFFECTIVE post-patch `parentGroupId` — what this subtask's group membership will be AFTER
  // this write, not what `found` (the pre-patch record) currently holds. A single PATCH can combine
  // leaving a group (`parentGroupId: ''`) with `status: 'done'` in the same call, so the
  // `done_needs_session` gate below must judge the record it is actually about to write, never the
  // stale one — see this function's own docblock.
  const nextParentGroupId = patch.parentGroupId !== undefined
    ? (patch.parentGroupId?.trim() ? patch.parentGroupId.trim() : undefined)
    : found.parentGroupId

  // The superseded `groupId` (§B) and the current `isGroup`/`parentGroupId` pair (§F) may never
  // both name a group on one record — see this function's own docblock. Checked only when this
  // patch actually touches one of the two fields, against the EFFECTIVE post-patch state of both.
  if (patch.groupId !== undefined || patch.parentGroupId !== undefined) {
    const nextGroupId = patch.groupId !== undefined
      ? (patch.groupId?.trim() ? patch.groupId.trim() : undefined)
      : found.groupId
    if (nextGroupId && (found.isGroup === true || nextParentGroupId)) {
      return { ok: false, message: 'group_field_conflict' }
    }
  }

  if (patch.parentGroupId !== undefined && patch.parentGroupId !== null) {
    const wanted = patch.parentGroupId.trim()
    if (wanted) {
      const check = checkParentGroup({
        subtaskId: found.id,
        taskId: found.taskId,
        isGroup: found.isGroup === true,
        parentGroupId: wanted,
        siblings: w.book.subtasks,
        hasSession,
      })
      if (!check.ok) return { ok: false, message: check.reason }
    }
  }

  const status = patch.status ?? found.status
  // See this function's own docblock: a group MEMBER can never hold a session, so the gate is
  // unreachable for it by construction and is skipped rather than left to refuse forever. Judged on
  // `nextParentGroupId` (the post-patch value), not `found` — see above.
  if (status === 'done' && found.status !== 'done' && !isGroupMember({ parentGroupId: nextParentGroupId })) {
    if (!hasSession) return { ok: false, message: 'done_needs_session' }
  }

  // SETTING a staged draft on a group member is refused for the exact reason `planAttach` refuses
  // to file a real session there — a draft that could never be fired on this row is not a draft
  // worth saving. CLEARING (`null`) is always allowed: a stale draft left over from before this
  // subtask joined a group must still be removable. Judged on `nextParentGroupId`, same as `done`.
  if (patch.stagedSession !== undefined && patch.stagedSession !== null
    && isGroupMember({ parentGroupId: nextParentGroupId })) {
    return { ok: false, message: 'subtask_in_group' }
  }

  await w.store.upsertSubtask({
    ...found,
    ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
    status,
    done: subtaskDone(status),
    // An empty string CLEARS the column — that is how a date or an assignee is removed, and it is
    // why these are not filtered out the way an empty title is.
    ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.blockedBy !== undefined ? {
      blockedBy: sanitizeSubtaskBlockedBy({
        subtaskId: found.id, taskId: found.taskId, ids: patch.blockedBy, siblings: w.book.subtasks,
      }),
    } : {}),
    // `undefined` is what the store writes as "absent": `JSON.stringify` drops the key, so the
    // subtask reads back as its own group of one — the pre-group behaviour, exactly.
    ...(patch.groupId !== undefined
      ? { groupId: patch.groupId?.trim() ? patch.groupId.trim() : undefined }
      : {}),
    // Already validated above (or cleared, or left alone) — this only ever writes the trimmed,
    // checked value (the same `nextParentGroupId` the gate above judged), `undefined` to leave the
    // column alone.
    ...(patch.parentGroupId !== undefined ? { parentGroupId: nextParentGroupId } : {}),
    // `null` clears (the store drops the key, same convention as every other identity field here);
    // an object SETS it, already validated above. `undefined` leaves the column alone.
    ...(patch.stagedSession !== undefined
      ? { stagedSession: patch.stagedSession ?? undefined }
      : {}),
    updatedAt: new Date().toISOString(),
  })

  // See `statusAfterSubtaskProgress` — a subtask (or group member, §F.1) that actually STARTS work
  // is the same kind of evidence `statusAfterAttach` already reacts to when a session is filed
  // directly on the task: real progress on a piece of a delivery still sitting in
  // `backlog`/`todo` is exactly the confusion this fixes ("mudei uma subtask pra 'em andamento' e
  // o status da task pai simplesmente continuou em 'a fazer'"). Guarded on an ACTUAL transition
  // (`found.status !== status`) so a patch that leaves the status alone — or repeats the one it
  // already had — never re-triggers a write nobody asked for. `markTask` re-reads the task world
  // itself, so this always judges the task's CURRENT status, never a value cached before this
  // subtask's own write landed.
  if (patch.status !== undefined && status !== found.status) {
    const parent = w.book.tasks.find(t => t.id === found.taskId)
    if (parent) {
      const advanced = statusAfterSubtaskProgress(parent.status, status)
      if (advanced) await markTask(parent.id, advanced, found.title || found.id)
    }
  }

  return { ok: true }
}

export async function removeSubtask(subtaskId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const found = w.book.subtasks.find(t => t.id === subtaskId)
  if (!found) return false
  await w.store.removeSubtask(subtaskId)
  return true
}

/** The tick, expressed as what it means: a move to `done`, or back to `todo`. */
export async function setSubtaskDone(subtaskId: string, done: boolean): Promise<
  {
    ok: true
  } | {
    ok: false
    message:
      | 'no_such_subtask' | 'done_needs_session' | 'invalid_group' | 'subtask_has_sessions'
      | 'group_field_conflict' | 'subtask_in_group'
  }
> {
  // Only ever passes `status`, so `group_field_conflict`/`subtask_in_group` cannot actually fire
  // through this path — the union member exists to match `patchSubtask`'s own return type exactly.
  return await patchSubtask(subtaskId, { status: done ? 'done' : 'todo' })
}

/** The bytes land FIRST. A failed write must leave no record claiming the file exists. */
/**
 * Returns the new file's ID, never a bare `true`.
 *
 * A COMMENT can carry an attachment, and it references it by id — so an upload that answered only
 * "it worked" left the caller having to guess which of the task's files it had just created, which
 * on two screenshots pasted in the same second is a guess that goes wrong.
 */
export async function attachFile(
  ref: string,
  o: { name: string; bytes: Uint8Array; kind?: string; author?: string },
): Promise<string | null> {
  const name = o.name.trim()
  if (!name) return null
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return null
  const id = newFileId()
  let size: number
  try {
    size = await writeTaskFile(task.id, id, o.bytes)
  } catch {
    return null
  }
  await w.store.addFile({
    id, taskId: task.id, name, size,
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.author ? { author: o.author } : {}),
    createdAt: new Date().toISOString(),
  })
  return id
}

export async function fetchFile(fileId: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const w = await loadTaskWorld()
  const rec = w.book.files.find(f => f.id === fileId)
  if (!rec) return null
  const bytes = await readTaskFile(rec.taskId, rec.id)
  // A record whose bytes are gone is a FACT, reported as a miss rather than an empty download that
  // looks like an empty file.
  return bytes ? { name: rec.name, bytes } : null
}

export async function removeFile(fileId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const rec = w.book.files.find(f => f.id === fileId)
  if (!rec) return false
  await deleteTaskFile(rec.taskId, rec.id)
  return await w.store.removeFile(fileId)
}

/**
 * Mark a task delivered or abandoned.
 *
 * `delivered` attaches the git evidence of the window; `abandoned` attaches NONE — commits under an
 * attempt that was given up on would read as a delivery, which is the one thing this record must
 * not say.
 *
 * The finished NAME is mirrored into `preferences.finishedTasks` so the cockpit's own `finishTask`,
 * which reads that list, never disagrees with the board about what is done.
 */
/**
 * Set which tasks block this one.
 *
 * Self-blocking is refused rather than sanitised away silently — asking for it is a mistake worth
 * hearing about. A blocker that does not exist is dropped: a dangling id would render as a blocker
 * nobody can find or clear.
 */
export async function setBlockedBy(ref: string, ids: readonly string[]): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const known = new Set(w.book.tasks.map(t => t.id))
  const clean = [...new Set(ids)].filter(id => id !== task.id && known.has(id))
  return await w.store.patchTask(task.id, { blockedBy: clean, updatedAt: new Date().toISOString() })
}

/** Attach a link. Refused unless it is http(s) — see `sanitizeLink`. */
export async function addLink(
  ref: string,
  o: { url: string; label?: string; kind?: string },
): Promise<boolean> {
  const url = o.url.trim()
  if (!/^https?:\/\//i.test(url)) return false
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const link = {
    id: newLinkId(), url,
    ...(o.label?.trim() ? { label: o.label.trim() } : {}),
    ...(o.kind?.trim() ? { kind: o.kind.trim() } : {}),
  }
  return await w.store.patchTask(task.id, {
    links: [...(task.links ?? []), link],
    updatedAt: new Date().toISOString(),
  })
}

export async function removeLink(ref: string, linkId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  return await w.store.patchTask(task.id, {
    links: (task.links ?? []).filter(l => l.id !== linkId),
    updatedAt: new Date().toISOString(),
  })
}

/**
 * File an existing session under a task.
 *
 * Writes BOTH `taskId` and the free-text `task`: the id is what every rollup joins on, and the name
 * is what the cockpit, `session ls` and the harness-facing surfaces already read. Writing only one
 * would make the same session look filed in one place and loose in another.
 *
 * The task INHERITS the session's repository when it has none of its own. That is the point of
 * linking a live session first: the work is already somewhere, and asking a person to retype where
 * is asking them for a fact the machine holds. It never OVERWRITES a repo the task already carries
 * — a task that spans two repos keeps the one it was given.
 */
/**
 * File a session under a delivery, or under one of its SUBTASKS.
 *
 * `subtaskId` makes it a subtask filing, and it is a MOVE either way: `planAttach` decides the
 * whole pair, so filing under a subtask replaces a direct filing and filing under the task clears
 * the subtask. A session is never under both — see `task-attach.ts`, which is the only place that
 * rule exists.
 */
/**
 * What `attachSession` answers, instead of a bare boolean.
 *
 * A client that ends up here because a subtask is BLOCKED needs to say so in words and name what
 * is still open — the whole point of "diz que a subtask ainda está bloqueada e pergunta se você já
 * finalizou". A caller that only wants the yes/no still gets it: `ok` is always there.
 */
export type AttachResult =
  | { ok: true }
  | {
    ok: false
    reason: 'no_such_task' | 'no_such_session' | 'no_such_subtask' | 'needs_subtask'
      | 'wrong_delivery' | 'blocked' | 'subtask_in_group'
    /** Set only for `reason: 'blocked'` — the subtask ids still open. */
    blockedBy?: readonly string[]
  }

export async function attachSession(
  ref: string,
  sessionId: string,
  o: { subtaskId?: string } = {},
): Promise<AttachResult> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const row = w.rows.find(r => r.id === sessionId)
  if (!row) return { ok: false, reason: 'no_such_session' }

  // Direct filing under the task is allowed too — `o.subtaskId` is optional. `planAttach` decides
  // the pair either way, which is what makes this a MOVE rather than an add: filing under a
  // subtask replaces a direct filing and filing under the task clears the subtask.
  const plan = planAttach({
    target: o.subtaskId ? { kind: 'subtask', id: o.subtaskId } : { kind: 'task', id: task.id },
    taskIds: w.book.tasks.map(t => t.id),
    subtasks: w.book.subtasks.map(st => ({
      id: st.id, taskId: st.taskId, done: st.done, blockedBy: st.blockedBy,
      parentGroupId: st.parentGroupId,
    })),
  })
  if (!plan.ok) {
    return plan.reason === 'blocked'
      ? { ok: false, reason: 'blocked', blockedBy: plan.blockedBy }
      : { ok: false, reason: plan.reason }
  }
  // A subtask of ANOTHER delivery is refused rather than quietly re-parenting the session: the
  // caller named a task, and honouring a subtask outside it would file the work somewhere nobody
  // asked for.
  if (plan.taskId !== task.id) return { ok: false, reason: 'wrong_delivery' }

  const { patchSession } = await import('./registry')
  const ok = await patchSession(row.id, {
    taskId: task.id,
    task: task.title,
    // `null` CLEARS — a move from a subtask back to the delivery leaves nothing behind.
    subtaskId: plan.subtaskId,
  })
  if (!ok) return { ok: false, reason: 'no_such_session' }

  // See `statusAfterAttach` — a session actually filed under this delivery is real progress, and a
  // status still reading "backlog"/"todo" beside it is exactly the confusion this fixes ("não faz
  // sentido ter sessão working ou waiting e status estarem em todo"). `task.status` here is read
  // from the SAME `task` object resolved from `ref` above: attaching never renames or moves the
  // task itself, so it is still that task's current status.
  const advanced = statusAfterAttach(task.status)
  if (advanced) await markTask(task.id, advanced, row.label || sessionId)

  // The record first, then LIVE git. Every row written before `ManagedSession.repo` existed carries
  // nothing, which is most of the fleet on a machine that has been running a while — and reading
  // `row.repo` alone made "link a session to inherit its repo" inherit nothing at all. `repoFacts`
  // is the same resolver the fleet uses: it prefers live git, falls back to the record, and says
  // `missing` for a directory that is gone rather than inventing a name from the path.
  if (!task.repo) {
    const { repoFacts } = await import('./repo-facts')
    const facts = await repoFacts(row.cwd, row.repo).catch(() => null)
    const repo = facts?.repo
    if (repo) await w.store.patchTask(task.id, { repo, updatedAt: new Date().toISOString() })
  }
  await w.store.logEvents([event(task.id, row.label || sessionId, 'session', {
    to: sessionId, detail: row.harness,
  })])
  return { ok: true }
}

/**
 * Unfile a session.
 *
 * The row keeps existing and keeps its history — only the attribution goes. `patchSession` writes
 * fields rather than clearing them, so the empty strings here are what "no longer filed" looks like
 * on this record; `rowsOfTask` matches on a non-empty id or name, so an empty one belongs to no task.
 */
export async function detachSession(sessionId: string): Promise<boolean> {
  const { patchSession } = await import('./registry')
  // The SUBTASK goes with it. Unfiling a session that left a `subtaskId` behind would leave it
  // drawn under a subtask of a delivery it is no longer part of.
  return await patchSession(sessionId, {
    taskId: '', attemptId: '', task: '', subtaskId: null,
  })
}

export async function markTask(
  ref: string,
  to: TaskStatus,
  actor?: string,
  o: {
    /** Why, in the blocker's own words. Required by `blocked` unless a blocking TASK is named. */
    reason?: string
    /** Blocking task ids to set as part of the same move — the other way to answer "why". */
    blockedBy?: readonly string[]
  } = {},
): Promise<{ ok: boolean; evidence?: DeliveryEvidence; message?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, message: 'no_such_task' }

  const now = new Date().toISOString()
  const reason = o.reason?.trim() ?? ''

  /*
   * `blocked` must SAY what it is waiting on.
   *
   * It is the one status that names a problem somebody has to go and solve, and a board of blocked
   * cards that do not say why is a board nobody can unblock: the fact lives only in the head of
   * whoever moved it, who by then has moved on. `task_next` already reports these as withheld —
   * without a reason that report is "you cannot have this" with no way forward.
   *
   * The check is HERE and not in the browser, so it binds the MCP and the CLI too. An assistant
   * that cannot say why it is blocked has not finished thinking about being blocked.
   */
  if (to === 'blocked') {
    const blockers = o.blockedBy ?? task.blockedBy ?? []
    if (!reason && blockers.length === 0) {
      return { ok: false, message: 'blocked_needs_reason' }
    }
    if (o.blockedBy) {
      await w.store.patchTask(task.id, {
        blockedBy: [...new Set(o.blockedBy.filter(id => id !== task.id))],
        updatedAt: now,
      })
    }
  }
  /*
   * `done` requires a session filed under the task — same shape as `blocked_needs_reason` above,
   * checked BEFORE the write so it binds the browser, the CLI and the MCP alike. `rowsOfTask`
   * counts a session ANYWHERE under the task — filed directly, or under any of its subtasks,
   * regardless of `subtaskId` — so this one check is correct for a task with subtasks, without
   * subtasks, or a mix, with no new counting logic (see
   * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §A.3). The guard is
   * `task.status !== 'done'`: a move that is not actually a transition into `done` (re-marking an
   * already-done task) must not re-trigger it. Computed once and reused below for the
   * delivery-evidence block, rather than calling `rowsOfTask` a second time.
   */
  const mine = to === 'done' && task.status !== 'done' ? rowsOfTask(task, w.rows) : undefined
  if (mine && mine.length === 0) return { ok: false, message: 'done_needs_session' }

  // `done` is the ONE status that stamps a delivery. Every other move is a change of where the work
  // stands, and stamping one of those would close rounds-to-delivery on work that is not delivered.
  const done = to === 'done'
  await w.store.patchTask(task.id, {
    status: to,
    updatedAt: now,
    ...(done ? { deliveredAt: now } : {}),
    // The reason belongs to THIS block. Leaving `blocked` clears it: a sentence that outlived its
    // block reads as current, which is worse than none.
    ...(to === 'blocked' ? { blockedReason: reason } : { blockedReason: '' }),
  })
  // Attempts only ever settle when the TASK settles. An in-progress task leaves them running.
  if (done || to === 'abandoned') {
    for (const a of w.book.attempts.filter(a => a.taskId === task.id && a.status === 'running')) {
      await w.store.patchAttempt(a.id, {
        status: done ? 'delivered' : 'abandoned',
        updatedAt: now,
        ...(done ? { deliveredAt: now } : {}),
      })
    }
  }

  // The status change is the log's most important line: on a board several agents drive, "who
  // moved this to blocked, and when" is not rhetorical.
  await w.store.logEvents([event(task.id, actor?.trim() || 'you', 'status', {
    from: task.status, to,
    // The log carries the reason with the move, so "why was this blocked on Tuesday" survives the
    // task being unblocked and the field being cleared.
    ...(to === 'blocked' && reason ? { detail: reason } : {}),
  })])

  const prefs = await readPreferences().catch(() => null)
  const current = prefs?.finishedTasks ?? []
  const next = done
    ? [...new Set([...current, task.title])]
    : current.filter(t => t !== task.title)
  if (next.length !== current.length) {
    await writePreferences({ finishedTasks: next }).catch(() => undefined)
  }

  if (!done) return { ok: true }

  const rows = mine ?? rowsOfTask(task, w.rows)
  const dirs = [...new Set(rows.map(r => r.cwd).filter(Boolean))]
  const bySha = new Map<string, { sha: string; message: string; atMs: number }>()
  for (const dir of dirs) {
    // Deduped by sha: two sessions of one task routinely share a checkout, and the same commit read
    // twice would double every count in the evidence block.
    for (const c of await getCommitsInWindow(dir, task.createdAt, now)) {
      if (!bySha.has(c.sha)) bySha.set(c.sha, c)
    }
  }
  return {
    ok: true,
    evidence: planDeliveryEvidence({
      startedMs: Date.parse(task.createdAt) || 0,
      deliveredMs: Date.parse(now),
      commits: [...bySha.values()],
    }),
  }
}
