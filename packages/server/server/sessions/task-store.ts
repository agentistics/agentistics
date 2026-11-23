/**
 * task-store.ts — the task book on disk, and the only file in this feature that touches it.
 *
 * Shape and durability rules come from `tags-local-store.ts` and `registry.ts`, unchanged because
 * they were learned from real losses: temp-file-then-rename, so a crash cannot leave a truncated
 * file a reader would parse-fail on; corrupt bytes quarantined rather than overwritten, so a parse
 * failure degrades to "no tasks" instead of erasing them; a no-op mutation writing nothing.
 *
 * Mutations additionally run under `withFileLock`. The in-process promise chain is only half the
 * problem, because agentop runs as several processes: the server, the cockpit, and every one-shot
 * command. See `file-lock.ts`.
 *
 * A CONTENDED write is retried once. `withFileLock`'s wait is bounded and it runs the callback
 * ANYWAY when the wait expires, reporting `contended` — the right trade for a session that has
 * already been spawned, where a lost label beats a live session with no record, and the wrong one
 * here: nothing has been started, and a task silently lost has no running process to be adopted
 * back from. The retry re-runs the whole read-modify-write, which is idempotent, so the second pass
 * merges with whatever the other process wrote in between.
 */

import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { alertQuarantined, durableWrite, hasQuarantine, readLastGood, recoverVanished, refreshLastGood, sweepStaleDurableTmps } from '../durable-file'
import { dirname, join } from 'node:path'
import { isStatusStage, isValidStatusColor, normalizeStagedSession, sanitizeCommentAttachments, type TaskStatusDef, type TaskTypeDef } from '@agentistics/core'
import { inGuardTransaction, peekRuleA, RuleNoLongerOff, serializeGuardWrite, withGuardEnvelope } from '../delivery/guard-transaction'
import { withFileLock } from './file-lock'
import { createGuaranteesStore } from '../delivery/activation'
import { historicalLinkId, migratePriority, migrateStatus, nativeLinkId, subtaskDone } from './task-model'
import { heldByOther } from './task-next'
import { sanitizeNativeUsage } from './task-native'
import type { NativeSessionLink, NativeSessionUsage } from './task-model'
import type {
  Attempt, AttemptStatus, HistoricalSession, Subtask, Task, TaskBook, TaskClaim, TaskComment,
  TaskEvent, TaskFile, TaskLink, TaskPriority, TaskStatus, TaskThread,
} from './task-model'
import { isCommentKind, type ThreadDelivery, type ThreadParticipant } from '@agentistics/core'
import { GuardRefused, boardRaises, boardPieces, memberStatuses, subRank, type BoardSlice, type GuardContext } from '../delivery/guard'
import { guardedWrite, guardPathsOf, ruleAState, type GuardWiring } from '../delivery/guard-host'
import { GuardBusy } from '../delivery/guard-locks'
import { createGuardsStore } from '../delivery/guards-store'
import { activePlaceholder, type PlaceholderRecord, type SweepMemory } from '../delivery/sweep-plan'
import { createDeliveryStore } from '../delivery/store'
import { effectiveSubtasks } from './task-report'

export interface TaskPatch {
  title?: string
  detail?: string
  status?: TaskStatus
  deliveredAt?: string
  /** System-stamped, never set by an ordinary caller — see `Task.startedAt`'s own note. */
  startedAt?: string
  repo?: string
  updatedAt?: string
  blockedBy?: string[]
  links?: TaskLink[]
  priority?: TaskPriority
  dueDate?: string
  startDate?: string
  labels?: string[]
  type?: string
  rank?: string
  blockedReason?: string
}

export interface AttemptPatch {
  label?: string
  status?: AttemptStatus
  deliveredAt?: string
  updatedAt?: string
}

const EMPTY_BOOK = (): TaskBook => ({
  tasks: [], attempts: [], comments: [], threads: [], subtasks: [], files: [], tombstones: [], events: [],
  historicalSessions: [],
  nativeSessions: [],
  // Absent/empty is exactly what `planStatusMigration` reads as "never seeded yet" — see
  // `task-source.ts`'s `ensureStatusesSeeded`, which fills this in on the very next load.
  statuses: [],
  types: [],
})

/**
 * How much history the log keeps, across the whole board.
 *
 * A cap, because this file is read on every poll and an unbounded log turns a cheap read into a
 * growing one. Oldest go first — the question the log answers ("what has been happening") is about
 * the recent end, and the delivery numbers, which are the durable record, live on the tasks.
 */
export const MAX_EVENTS = 2000

export interface TaskStore {
  read(): Promise<TaskBook>
  /** True when this book was lost once (`<file>.corrupt-*` exists): an empty book is then not a fresh install. */
  wasQuarantined(): Promise<boolean>
  /** `guard` (S2a, optional): who is asking — a write that RAISES a piece's rank without one is refused when the guarantee is on. */
  upsertTask(task: Task, guard?: GuardContext): Promise<void>
  upsertAttempt(attempt: Attempt): Promise<void>
  /** False when no record carries that id — never a silent success. */
  patchTask(id: string, patch: TaskPatch, o?: { allowOpenSubtasks?: boolean; guard?: GuardContext }): Promise<boolean>
  patchAttempt(id: string, patch: AttemptPatch): Promise<boolean>
  addComment(c: TaskComment): Promise<void>
  /**
   * Change a comment's body. False when no comment carries that id.
   *
   * The body only: `author` and `createdAt` are the RECORD of who said it and when, and an edit
   * that rewrote either would turn a correction into a forgery.
   */
  editComment(id: string, body: string): Promise<boolean>
  removeComment(id: string): Promise<boolean>
  /**
   * Thread writes (2026-10-04). `upsertThread` replaces by id; `updateThread` and `updateComment`
   * run a pure updater INSIDE the store's lock, so a fan-out writing deliveries and a session
   * joining the same thread cannot lose each other's change. False when nothing carries that id.
   */
  upsertThread(t: TaskThread): Promise<void>
  updateThread(id: string, fn: (t: TaskThread) => TaskThread): Promise<boolean>
  updateComment(id: string, fn: (c: TaskComment) => TaskComment): Promise<boolean>
  upsertSubtask(t: Subtask, guard?: GuardContext): Promise<void>
  /** Atomic insert/adopt by message id; retries and adoption never overwrite progress. */
  registerComposerSubtask(t: Subtask, guard?: GuardContext): Promise<Subtask | null>
  /** `dismissPlaceholder`: a leader/owner removing a guard placeholder (B4) — the write records the removal and raises nothing. */
  removeSubtask(id: string, opts?: { dismissPlaceholder?: GuardContext; ownerRemoval?: GuardContext; guard?: GuardContext }): Promise<boolean>
  /** r3: the group this piece is an ACCEPTED (`done`) member of, per the sealed group checkpoint; null for any other piece (or an unreadable guards.json). */
  acceptedMemberOf(id: string): Promise<{ groupId: string; status: string } | null>
  /** B4 r2: the sweep's LEDGER record that makes this piece a placeholder (present, not dismissed), else null — the `restoredBy` flag alone is never authority. */
  placeholderOf(id: string): Promise<PlaceholderRecord | null>
  addFile(f: TaskFile): Promise<void>
  /** Removes the RECORD. The bytes on disk are the caller's to unlink — see `task-files.ts`. */
  removeFile(id: string, deletion?: TaskDeletionPort): Promise<boolean>
  /**
   * Delete a task and everything hanging off it.
   *
   * Sessions are NOT touched: a row's `taskId` becomes a dangling reference, which reads as
   * "no attempt named" rather than vanishing. Deleting a board entry must never delete work.
   */
  removeTask(id: string, deletion?: TaskDeletionPort, opts?: { guard?: GuardContext }): Promise<boolean>
  /** Forget a tombstone, so a name the user deleted can be created again. */
  clearTombstone(id: string): Promise<void>
  /**
   * TAKE a task, atomically, or report who already has it.
   *
   * The whole point is that this decides under the lock: two agents asking at the same moment
   * cannot both be told yes. `takeover` is for a person overriding a live claim on purpose — an
   * agent must never pass it, or the lease means nothing.
   */
  claimTask(o: {
    id: string
    by: string
    nowMs: number
    leaseMs: number
    sessionId?: string
    note?: string
    takeover?: boolean
  }): Promise<{ ok: true; task: Task } | { ok: false; reason: 'missing' | 'held'; task?: Task }>
  /** Give it back. Only the holder may, unless `force` — same reason `takeover` exists. */
  releaseTask(o: { id: string; by: string; force?: boolean }):
    Promise<{ ok: true; task: Task } | { ok: false; reason: 'missing' | 'other'; task?: Task }>
  /** Write several ranks at once — a drag is one write, a rebalance is one pass. */
  setRanks(ranks: ReadonlyArray<{ id: string; rank: string }>): Promise<void>
  /**
   * S2b — the guard sweep's batch: every board revert of one tick (status back, `ci` signal cleared), the comments and events
   * that say so, in ONE write. A revert only LOWERS a rank, so it needs no guard context and the store guard never refuses it.
   */
  /** S2b: the mirror of each status's stored stage, for readers that must judge a book an older writer stripped. */
  statusStageMirror(): Promise<Record<string, string> | undefined>
  /**
   * R5-1: a revert carrying `parentGroupId` puts an accepted member back in its group; with a `placeholder` and no subtask under that
   * id, it writes one carrying only the accepted record (id, status, group) — the group's status is derived from its members.
   */
  applyBoardReverts(batch: { at: string; reverts: ReadonlyArray<{ key: string; subtaskId?: string; to: string; clearCi: boolean; parentGroupId?: string; groupTaskId?: string; placeholder?: { taskId: string; title: string; description: string } }>; comments: readonly TaskComment[]; events: readonly TaskEvent[] }): Promise<void>
  /** Append to the activity log. Never throws on a task that has since gone. */
  logEvents(events: readonly TaskEvent[]): Promise<void>

  /**
   * Write the WHOLE status list at once — the seed-once migration's own write
   * (`task-source.ts`'s `ensureStatusesSeeded`), and the only caller that should ever replace the
   * list wholesale rather than editing one entry. Refuses when a list already exists and is
   * non-empty, mirroring `planStatusMigration`'s own idempotency rule at the point where it is
   * actually written — a second process racing to seed the same fresh book must not overwrite
   * whichever one got there first with a list built from stale reads.
   */
  seedStatuses(list: readonly TaskStatusDef[]): Promise<void>
  /** Once per book: append `def` to the status list unless it is there, and mark the book. */
  seedInReview(def: TaskStatusDef | null): Promise<void>
  /** Add a new status, or edit an existing one's label/color. The `id` is never rewritten by this —
   *  create mints a fresh entry, edit finds the existing one by `id` and replaces label/color only. */
  upsertStatus(def: TaskStatusDef): Promise<void>
  reorderStatuses(ids: readonly string[]): Promise<void>
  /**
   * Fill the stored stage of every status that has NONE (S0c load-time backfill/restore). Re-checked under the
   * lock against the freshest read: a status that already has a valid stage is never overwritten here — changing
   * a stage is `upsertStatus`, gated by `status_stage_in_use` in `task-web.ts`.
   */
  setStatusStages(stages: Readonly<Record<string, string>>): Promise<void>
  /** False when no status carries that id — never a silent success. The caller (`task-web.ts`) is
   *  the one that checks `canDeleteStatus` BEFORE calling this; this method trusts that call. */
  removeStatus(id: string): Promise<boolean>

  /** Seed the type list once (no-op when one exists) — `task-source.ts`'s `ensureTypesSeeded`. */
  seedTypes(list: readonly TaskTypeDef[]): Promise<void>
  /** Add a type or edit one's label/color; the id never changes. */
  upsertType(def: TaskTypeDef): Promise<void>
  reorderTypes(ids: readonly string[]): Promise<void>
  /** False when no type carries that id. The caller checks `canDeleteType` first. */
  removeType(id: string): Promise<boolean>

  /**
   * File a HISTORICAL conversation (see `HistoricalSession`) — or MOVE it, when it already holds a
   * link. One link per conversation, decided under the lock, so `replaced` is exactly what THIS write
   * displaced and a caller can say where it came from.
   */
  fileHistorical(link: HistoricalSession): Promise<{ replaced?: HistoricalSession }>
  /**
   * Drop a historical link, by its own id or by the conversation it names. Null when there was none —
   * never a silent success. Dropping the link simply removes the filing STATEMENT; nothing else is
   * written, because a conversation with no statement belongs to no task (`conversationOwners`).
   */
  unfileHistorical(ref: string): Promise<HistoricalSession | null>

  /**
   * File a NATIVE session (see `NativeSessionLink`) — or MOVE it. One link per session, decided under
   * the lock; a usage snapshot already on the link survives a move unless the new link carries one.
   */
  fileNative(link: NativeSessionLink): Promise<{ replaced?: NativeSessionLink }>
  /** Drop a native link by its own id or its session id. Null when there was none. */
  unfileNative(ref: string): Promise<NativeSessionLink | null>
  /**
   * Refresh the usage snapshot of a session ALREADY filed. Never files one: false when the session
   * holds no link (the engine reports after every run; an unfiled session has nowhere to roll up).
   * An OLDER snapshot than the one held is ignored (two reports racing cannot roll the cost back).
   */
  reportNativeUsage(sessionId: string, usage: NativeSessionUsage): Promise<boolean>
}

/**
 * A link with no usable URL is dropped.
 *
 * Only http(s): a `javascript:` URL rendered into an anchor is a script somebody else wrote running
 * on this page, and the board takes text from assistants.
 */
function sanitizeLink(raw: unknown): TaskLink | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  const id = typeof l.id === 'string' && l.id ? l.id : null
  const url = typeof l.url === 'string' ? l.url.trim() : ''
  if (!id || !/^https?:\/\//i.test(url)) return null
  return {
    id, url,
    ...(typeof l.label === 'string' && l.label ? { label: l.label } : {}),
    ...(typeof l.kind === 'string' && l.kind ? { kind: l.kind } : {}),
  }
}

/** Keep only records shaped enough to be used safely downstream. */
function sanitizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id) return null
  if (typeof t.title !== 'string' || !t.title) return null
  return {
    id: t.id,
    title: t.title,
    // An unknown word is not a status. `todo` is the safe read: it claims the least.
    status: migrateStatus(t.status) ?? 'todo',
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date(0).toISOString(),
    ...(typeof t.detail === 'string' ? { detail: t.detail } : {}),
    ...(typeof t.deliveredAt === 'string' ? { deliveredAt: t.deliveredAt } : {}),
    ...(typeof t.startedAt === 'string' ? { startedAt: t.startedAt } : {}),
    ...(typeof t.repo === 'string' ? { repo: t.repo } : {}),
    ...(Array.isArray(t.links)
      ? {
        links: t.links.map(sanitizeLink).filter((l): l is TaskLink => l !== null),
      }
      : {}),
    ...(Array.isArray(t.blockedBy)
      ? { blockedBy: t.blockedBy.filter((v): v is string => typeof v === 'string' && v !== t.id) }
      : {}),
    // Absent priority is `none`, never `medium`: see `TaskPriority`. Written explicitly so every
    // reader sees the same word rather than each deciding what absence means.
    priority: migratePriority(t.priority),
    ...(typeof t.dueDate === 'string' && t.dueDate ? { dueDate: t.dueDate } : {}),
    ...(typeof t.startDate === 'string' && t.startDate ? { startDate: t.startDate } : {}),
    ...(Array.isArray(t.labels)
      ? { labels: t.labels.filter((v): v is string => typeof v === 'string' && v !== '') }
      : {}),
    ...(typeof t.type === 'string' && t.type ? { type: t.type } : {}),
    ...(typeof t.rank === 'string' && t.rank ? { rank: t.rank } : {}),
    ...(typeof t.blockedReason === 'string' && t.blockedReason
      ? { blockedReason: t.blockedReason }
      : {}),
    ...(sanitizeClaim(t.claim) ? { claim: sanitizeClaim(t.claim)! } : {}),
  }
}

/**
 * A claim with no holder or no expiry is dropped.
 *
 * Deliberately strict on `expiresAt`: a claim that cannot expire is a permanent lock, and the
 * lease exists precisely so a dead agent cannot create one.
 */
function sanitizeClaim(raw: unknown): TaskClaim | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (typeof c.by !== 'string' || !c.by) return null
  if (typeof c.expiresAt !== 'string' || !c.expiresAt) return null
  return {
    by: c.by,
    at: typeof c.at === 'string' ? c.at : c.expiresAt,
    expiresAt: c.expiresAt,
    ...(typeof c.sessionId === 'string' && c.sessionId ? { sessionId: c.sessionId } : {}),
    ...(typeof c.note === 'string' && c.note ? { note: c.note } : {}),
  }
}

function sanitizeEvent(raw: unknown): TaskEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string' || !e.id) return null
  if (typeof e.taskId !== 'string' || !e.taskId) return null
  if (typeof e.kind !== 'string' || !e.kind) return null
  return {
    id: e.id, taskId: e.taskId, kind: e.kind,
    at: typeof e.at === 'string' ? e.at : new Date(0).toISOString(),
    actor: typeof e.actor === 'string' ? e.actor : 'unknown',
    ...(typeof e.subtaskId === 'string' && e.subtaskId ? { subtaskId: e.subtaskId } : {}),
    ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
    ...(typeof e.from === 'string' ? { from: e.from } : {}),
    ...(typeof e.to === 'string' ? { to: e.to } : {}),
  }
}

/**
 * An attempt is kept only when it names a TASK and a HARNESS.
 *
 * Without `taskId` it belongs to nothing and no reader that walks tasks would ever see it again;
 * without a harness it is not a configuration of anything. Both are load-bearing in the way
 * `sanitize`'s three fields are in `registry.ts` — the rest is trusted once these check out.
 */
function sanitizeAttempt(raw: unknown): Attempt | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.id) return null
  if (typeof a.taskId !== 'string' || !a.taskId) return null
  const cfg = (a.config ?? {}) as Record<string, unknown>
  if (typeof cfg.harness !== 'string' || !cfg.harness) return null
  const status = a.status
  return {
    id: a.id,
    taskId: a.taskId,
    label: typeof a.label === 'string' ? a.label : a.id,
    config: {
      harness: cfg.harness as Attempt['config']['harness'],
      ...(typeof cfg.model === 'string' ? { model: cfg.model } : {}),
      ...(typeof cfg.effort === 'string' ? { effort: cfg.effort } : {}),
      ...(typeof cfg.method === 'string' ? { method: cfg.method } : {}),
    },
    status: status === 'delivered' || status === 'abandoned' ? status : 'running',
    startedAt: typeof a.startedAt === 'string' ? a.startedAt : new Date(0).toISOString(),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : new Date(0).toISOString(),
    ...(typeof a.deliveredAt === 'string' ? { deliveredAt: a.deliveredAt } : {}),
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** A comment with no body says nothing; one with no task belongs to nothing. Both are dropped. */
function sanitizeComment(raw: unknown): TaskComment | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const id = str(c.id); const taskId = str(c.taskId); const body = str(c.body) ?? ''
  const attachments = sanitizeCommentAttachments(c.attachments)
  // Words, files or both — a comment with neither says nothing.
  if (!id || !taskId || (!body && attachments.length === 0)) return null
  const subtaskId = str(c.subtaskId)
  return {
    id, taskId, body,
    ...(attachments.length > 0 ? { attachments } : {}),
    // Absent on every comment written before threads existed — read as the task's own.
    ...(subtaskId ? { subtaskId } : {}),
    author: str(c.author) ?? 'unknown',
    createdAt: str(c.createdAt) ?? new Date(0).toISOString(),
    // Thread fields (2026-10-04). Each is ABSENT on a comment written before threads existed, and
    // this whitelist is what a value survives the next read through.
    ...(str(c.threadId) ? { threadId: str(c.threadId)! } : {}),
    ...(c.role === 'owner' || c.role === 'session' ? { role: c.role } : {}),
    ...(str(c.sessionId) ? { sessionId: str(c.sessionId)! } : {}),
    ...(isCommentKind(c.kind) && c.kind !== 'note' ? { kind: c.kind } : {}),
    ...(Array.isArray(c.deliveries) ? { deliveries: c.deliveries.map(sanitizeDelivery).filter((d): d is ThreadDelivery => d !== null) } : {}),
  }
}

const DELIVERY_STATES = new Set(['delivered', 'queued', 'undeliverable', 'muted', 'failed'])
const DELIVERY_REASONS = new Set(['not-running', 'dialog-open', 'external', 'unknown-session', 'muted', 'refused'])

function sanitizeDelivery(raw: unknown): ThreadDelivery | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const sessionId = str(d.sessionId)
  if (!sessionId || typeof d.state !== 'string' || !DELIVERY_STATES.has(d.state)) return null
  return {
    sessionId,
    state: d.state as ThreadDelivery['state'],
    at: str(d.at) ?? new Date(0).toISOString(),
    ...(str(d.conversationId) ? { conversationId: str(d.conversationId)! } : {}),
    ...(typeof d.reason === 'string' && DELIVERY_REASONS.has(d.reason) ? { reason: d.reason as ThreadDelivery['reason'] } : {}),
    ...(str(d.detail) ? { detail: str(d.detail)!.slice(0, 300) } : {}),
  }
}

const THREAD_KINDS = new Set(['topic', 'handback', 'block'])

function sanitizeThread(raw: unknown): TaskThread | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const id = str(t.id); const taskId = str(t.taskId); const title = str(t.title)
  if (!id || !taskId || !title) return null
  const participants = (Array.isArray(t.participants) ? t.participants : [])
    .map((p): ThreadParticipant | null => {
      if (!p || typeof p !== 'object') return null
      const q = p as Record<string, unknown>
      const sessionId = str(q.sessionId)
      if (!sessionId) return null
      return {
        sessionId,
        joinedAt: str(q.joinedAt) ?? new Date(0).toISOString(),
        ...(str(q.conversationId) ? { conversationId: str(q.conversationId)! } : {}),
        ...(str(q.label) ? { label: str(q.label)! } : {}),
        ...(str(q.harness) ? { harness: str(q.harness)! } : {}),
      }
    })
    .filter((p): p is ThreadParticipant => p !== null)
  const muted = Array.isArray(t.mutedSessions) ? t.mutedSessions.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  return {
    id, taskId, title,
    kind: typeof t.kind === 'string' && THREAD_KINDS.has(t.kind) ? t.kind as TaskThread['kind'] : 'topic',
    openedBy: str(t.openedBy) ?? 'unknown',
    createdAt: str(t.createdAt) ?? new Date(0).toISOString(),
    participants,
    ...(str(t.subtaskId) ? { subtaskId: str(t.subtaskId)! } : {}),
    ...(str(t.openedBySession) ? { openedBySession: str(t.openedBySession)! } : {}),
    ...(str(t.resolvedAt) ? { resolvedAt: str(t.resolvedAt)! } : {}),
    ...(muted.length > 0 ? { mutedSessions: muted } : {}),
  }
}

function validOwnerRequest(v: unknown): v is NonNullable<Subtask['ownerRequest']> {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return ['messageId', 'sessionId', 'conversationId', 'at', 'text', 'pedidoId'].every(k => typeof r[k] === 'string' && r[k] !== '')
}

function sanitizeSubtask(raw: unknown): Subtask | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const id = str(t.id); const taskId = str(t.taskId); const title = str(t.title)
  if (!id || !taskId || !title) return null
  // A row written before subtasks had a status carries only `done`, and that IS its status. Reading
  // it as `todo` would silently un-tick every completed subtask on the board.
  const status = migrateStatus(t.status) ?? (t.done === true ? 'done' : 'todo')
  return {
    id, taskId, title,
    ...(typeof t.priority === 'string' && ['urgent', 'high', 'medium', 'low'].includes(t.priority) ? { priority: t.priority as TaskPriority } : {}),
    ...(t.assignee === 'leader' || t.assignee === 'worker' ? { assignee: t.assignee } : {}),
    ...(validOwnerRequest(t.ownerRequest) ? { ownerRequest: t.ownerRequest } : {}),
    status,
    // Derived, never trusted from the file: two fields for one fact drift, and a row saying
    // `done: false, status: 'done'` has no correct reading.
    done: subtaskDone(status),
    createdAt: str(t.createdAt) ?? new Date(0).toISOString(),
    updatedAt: str(t.updatedAt) ?? new Date(0).toISOString(),
    ...(str(t.dueDate) ? { dueDate: str(t.dueDate)! } : {}),
    ...(str(t.startDate) ? { startDate: str(t.startDate)! } : {}),
    ...(str(t.startedAt) ? { startedAt: str(t.startedAt)! } : {}),
    ...(str(t.deliveredAt) ? { deliveredAt: str(t.deliveredAt)! } : {}),
    ...(str(t.sessionId) ? { sessionId: str(t.sessionId)! } : {}),
    ...(str(t.notes) ? { notes: str(t.notes)! } : {}),
    ...(str(t.blockedReason) ? { blockedReason: str(t.blockedReason)! } : {}),
    // A sibling-subtask blocker list — same trap as the hierarchy fields below: `patchSubtask`
    // already sanitizes it against the delivery's own subtasks before it is written
    // (`sanitizeSubtaskBlockedBy`, `task-attach.ts`), so this whitelist only needs to carry the
    // array THROUGH, not re-validate it. Without this line the write round-trips (it lands on
    // disk) and the very next `read()` drops it silently — a blocker set once and gone on the
    // next page load, discovered while wiring `SubtaskActionsMenu`'s "Blocked by" step.
    ...(Array.isArray(t.blockedBy)
      ? { blockedBy: t.blockedBy.filter((v): v is string => typeof v === 'string' && v !== id) }
      : {}),
    // SUPERSEDED (§F) — see the field's own docblock in `task-model.ts`. Still round-tripped so the
    // already-shipped §B-era UI keeps reading what it wrote; `subtaskViews` no longer buckets on it.
    ...(str(t.groupId) ? { groupId: str(t.groupId)! } : {}),
    // The hierarchy fields (§F.1). Both have to be carried here or the write is a no-op: `patchSubtask`
    // stamps them, the next `read()` drops them, and the group `subtaskViews`/`planAttach` resolve
    // never exists. `isGroup` is kept only when `true` — absent means "not a group," and a stray
    // `false` written by an older client is read the same as absent rather than as a distinct value.
    ...(t.isGroup === true ? { isGroup: true } : {}),
    // B4: the mark the guard sweep puts on a placeholder it restored; carried or the next `read()` drops it and the placeholder reads as work.
    ...(t.restoredBy === 'guard' ? { restoredBy: 'guard' as const } : {}),
    ...(str(t.parentGroupId) ? { parentGroupId: str(t.parentGroupId)! } : {}),
    // A staged session draft (t-918cc82233) — same reason the hierarchy fields above are carried
    // here explicitly: written by `patchSubtask` and dropped silently by the next `read()` unless
    // this whitelist parses it back. `normalizeStagedSession` is total and never repairs a
    // half-read draft, the same rule `normalizeSessionPresets` applies to a saved preset.
    ...(normalizeStagedSession(t.stagedSession) ? { stagedSession: normalizeStagedSession(t.stagedSession)! } : {}),
    // FLUXO.ENTREGA-DSL — the delivery flow's CI signal; same whitelist reason as the fields above.
    ...(t.ci && typeof t.ci === 'object' ? { ci: sanitizeCi(t.ci) } : {}),
  }
}

/** A status entry with no `id`, no `label` or an invalid `color` is dropped outright — a half-read
 *  status is worse than none, the same rule `sanitizeLink` applies to a task's outbound links. */
function sanitizeTypeDef(raw: unknown): TaskTypeDef | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const id = str(s.id); const label = str(s.label)
  if (!id || !label || !isValidStatusColor(s.color)) return null
  return { id, label, color: s.color, order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : 0 }
}

function sanitizeStatusDef(raw: unknown): TaskStatusDef | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const id = str(s.id); const label = str(s.label)
  if (!id || !label) return null
  if (!isValidStatusColor(s.color)) return null
  return {
    id, label, color: s.color,
    protected: s.protected === true,
    order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : 0,
    // The stored stage (S0c). An invalid value reads as absent: the load-time pass restores it from the mirror.
    ...(isStatusStage(s.stage) ? { stage: s.stage } : {}),
  }
}

/**
 * A link is kept only when it names a CONVERSATION and a TASK — without either it prices nothing and
 * belongs to nothing. The id is re-derived rather than trusted, so two records for one conversation
 * (a hand edit, a lost race) can only ever be one link: `read` keeps the LAST in file order.
 */
function sanitizeHistorical(raw: unknown): HistoricalSession | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Record<string, unknown>
  const conversationId = str(h.conversationId); const taskId = str(h.taskId)
  if (!conversationId || !taskId) return null
  return {
    id: historicalLinkId(conversationId),
    conversationId, taskId,
    harness: (str(h.harness) ?? 'claude') as HistoricalSession['harness'],
    ...(str(h.subtaskId) ? { subtaskId: str(h.subtaskId)! } : {}),
    linkedAt: str(h.linkedAt) ?? new Date(0).toISOString(),
    ...(str(h.note) ? { note: str(h.note)! } : {}),
  }
}

/** A native link is kept only when it names a SESSION and a TASK; its id is re-derived, never trusted. */
function sanitizeNative(raw: unknown): NativeSessionLink | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  const sessionId = str(n.sessionId); const taskId = str(n.taskId)
  if (!sessionId || !taskId) return null
  const usage = sanitizeNativeUsage(n.usage)
  return {
    id: nativeLinkId(sessionId),
    sessionId, taskId,
    ...(str(n.subtaskId) ? { subtaskId: str(n.subtaskId)! } : {}),
    linkedAt: str(n.linkedAt) ?? new Date(0).toISOString(),
    ...(str(n.label) ? { label: str(n.label)!.slice(0, 300) } : {}),
    ...(str(n.cwd) ? { cwd: str(n.cwd)! } : {}),
    ...(usage ? { usage } : {}),
  }
}

function sanitizeFile(raw: unknown): TaskFile | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  const id = str(f.id); const taskId = str(f.taskId); const name = str(f.name)
  if (!id || !taskId || !name) return null
  return {
    id, taskId, name,
    // A size that is not a finite number would render as NaN beside a real one; 0 is honest here
    // because the bytes are on disk either way and the listing is an index, not the measurement.
    size: typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : 0,
    ...(str(f.kind) ? { kind: str(f.kind)! } : {}),
    ...(str(f.author) ? { author: str(f.author)! } : {}),
    createdAt: str(f.createdAt) ?? new Date(0).toISOString(),
  }
}

/** Listeners told after every durable book write (status, filing, comment…). The server wires the SSE
 *  `change` event here so the Live view and the board refresh on the push, not on a heartbeat. */
const bookWriteListeners = new Set<() => void>()
export function onBookWrite(fn: () => void): () => void {
  bookWriteListeners.add(fn)
  return () => { bookWriteListeners.delete(fn) }
}

// Freezing a 15 MB book makes every later property access ~10x slower (measured), so it is a test-only
// guard: production callers are known not to mutate a read book.
const FREEZE_BOOKS = process.env.NODE_ENV === 'test'

// One parse per FILE, shared by every store instance of that path (loadTaskWorld builds a new store per
// request); any instance's write drops the entry.
const bookMemo = new Map<string, { stamp: string; book: TaskBook }>()

function deepFreeze<T>(v: T): T {
  if (!FREEZE_BOOKS) return v
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

/**
 * Optional deletion composition, invoked inside `enqueue` before any read/mutation. It owns later locks and byte cleanup.
 * `held.tasks` says whether the cross-process tasks lock is REALLY held: `withFileLock` proceeds without it after its
 * wait (`contended`), and a port that takes later locks must not claim tasks as already held then (QA S1c r2 R2).
 */
export type TaskDeletionPort = (remove: () => Promise<boolean>, held: { tasks: boolean }) => Promise<boolean>
const directDeletion: TaskDeletionPort = remove => remove()

export function createTaskStore(file: string, opts: { guard?: GuardWiring } = {}): TaskStore {
  // Temp files a killed writer left beside the board (other pid, older than 10 min) are removed once per store.
  void sweepStaleDurableTmps(dirname(file)).catch(() => {})
  // One in-process writer. Each mutation appends to this chain, so read-modify-write sequences run
  // strictly one after another even when several land at once.
  let queue: Promise<unknown> = Promise.resolve()
  // Set when a read failed to parse. The bad bytes are still on disk at that point; they are moved
  // aside (not overwritten) by the next write, so the empty book a corrupt file produces can never
  // become permanent data loss.
  let corrupt = false

  // The last parsed book lives in the module-level `bookMemo`, valid while the file's (ino, size, mtime)
  // stamp is unchanged. Frozen deep under NODE_ENV=test so a mutating caller fails loudly.

  async function read(): Promise<TaskBook> {
    let stamp = ''
    try {
      const st = await stat(file)
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`
      const memo = bookMemo.get(file)
      if (memo && memo.stamp === stamp) return memo.book
    } catch { /* unreadable below */ }
    const book = await readUncached()
    // Only a successful parse is memoised (a corrupt file must keep re-quarantining on the next write).
    if (stamp && !corrupt) bookMemo.set(file, { stamp, book: deepFreeze(book) })
    else bookMemo.delete(file)
    return book
  }

  async function readUncached(): Promise<TaskBook> {
    let text: string | null
    try {
      text = await readFile(file, 'utf8')
    } catch {
      text = null
    }
    if (text === null || !text.trim()) {
      // Missing or 0 bytes: a fresh install has no `.bak` either; one that does lost its file.
      const lost = await recoverVanished(file, text, t => { try { parseBook(t); return true } catch { return false } })
      if (!lost) { corrupt = false; return EMPTY_BOOK() }
      corrupt = lost.empty // an empty file is quarantined by the next write; a missing one has nothing to move
      void alertOnce(true)
      return parseBook(lost.good)
    }
    try {
      const book = parseBook(text)
      corrupt = false
      return book
    } catch {
      // Unreadable (a zero-filled file after a disk fault parses as nothing). Prefer the last good
      // copy to an empty board: the bytes stay on disk, `corrupt` makes the next write quarantine them.
      corrupt = true
      const good = await readLastGood(file, t => { try { parseBook(t); return true } catch { return false } })
      void alertOnce(good !== null)
      return good !== null ? parseBook(good) : EMPTY_BOOK()
    }
  }

  let alerted = false
  function alertOnce(restored: boolean): Promise<void> {
    if (alerted) return Promise.resolve()
    alerted = true
    return alertQuarantined(file, restored)
  }

  function parseBook(text: string): TaskBook {
    {
      const raw = JSON.parse(text) as Record<string, unknown>
      const arr = (v: unknown) => (Array.isArray(v) ? v : [])
      return {
        tasks: arr(raw.tasks).map(sanitizeTask).filter((t): t is Task => t !== null),
        attempts: arr(raw.attempts).map(sanitizeAttempt).filter((a): a is Attempt => a !== null),
        // Absent on a book written before these existed, which is why every read goes through
        // `arr` rather than trusting the field to be there.
        comments: arr(raw.comments).map(sanitizeComment).filter((c): c is TaskComment => c !== null),
        threads: arr(raw.threads).map(sanitizeThread).filter((t): t is TaskThread => t !== null),
        subtasks: arr(raw.subtasks).map(sanitizeSubtask).filter((t): t is Subtask => t !== null),
        files: arr(raw.files).map(sanitizeFile).filter((f): f is TaskFile => f !== null),
        // Absent on a book written before historical links existed. This whitelist is what a value
        // survives the next `read()` through — `sanitizeSubtask` dropped `blockedBy` for exactly this
        // reason — so the collection is carried here explicitly, and `task-store.test.ts` round-trips it.
        historicalSessions: [
          ...new Map(
            arr(raw.historicalSessions)
              .map(sanitizeHistorical)
              .filter((h): h is HistoricalSession => h !== null)
              .map(h => [h.id, h] as const),
          ).values(),
        ],
        // Same whitelist rule: the engine's links survive every read-modify-write of the board
        // (engine-interface spec §4.6 — a community build must not delete them either).
        nativeSessions: [
          ...new Map(
            arr(raw.nativeSessions)
              .map(sanitizeNative)
              .filter((n): n is NativeSessionLink => n !== null)
              .map(n => [n.id, n] as const),
          ).values(),
        ],
        tombstones: arr(raw.tombstones).filter((v): v is string => typeof v === 'string'),
        events: arr(raw.events).map(sanitizeEvent).filter((e): e is TaskEvent => e !== null),
        // Absent on a book written before this feature existed — same reason every field above goes
        // through `arr` rather than trusting it to be there.
        statuses: arr(raw.statuses).map(sanitizeStatusDef).filter((s): s is TaskStatusDef => s !== null),
        types: arr(raw.types).map(sanitizeTypeDef).filter((s): s is TaskTypeDef => s !== null),
        ...(raw.typesSeeded === true || arr(raw.types).length > 0 ? { typesSeeded: true } : {}),
        ...(raw.inReviewSeeded === true ? { inReviewSeeded: true } : {}),
      }
    }
  }

  // S2a (§2.5): the context and the lock state of the mutation being run — set by `enqueue`, read by `write`. One writer per
  // store instance runs at a time (the queue), so one pair of slots is enough.
  let currentGuard: GuardContext | undefined
  let currentContended = false
  /** `base`: rule A was off when this mutation started, so it holds ONLY the tasks file lock (the base's semantics, N2). */
  let currentBase = false
  /** B4: the mutation is the DISMISSAL of a guard placeholder by a leader/owner: the write records the member's removal and raises nothing. */
  let dismissing = false
  /** r8 C: set only inside one upsertSubtask by the vault-proven owner (serialised by the queue). */
  let classifyExempt: ReadonlySet<string> | undefined
  const anchor = guardPathsOf({ tasksFile: file })
  /** The authenticated mirror of each status's stored stage (the guard's and the sweep's one reader of it). */
  const stageMirror = async () => (await createGuaranteesStore(join(anchor.dir, 'guarantees.json')).read()).doc.statusStages
  const sliceOf = (b: TaskBook): BoardSlice => ({ tasks: b.tasks, subtasks: effectiveSubtasks(b.subtasks), statuses: b.statuses })

  /**
   * THE CHOKE POINT. Every task-board writer ends here. When the guarantee is on (rule A), a write that raises any piece's
   * ladder rank is decided by `guardedWrite` BEFORE a byte lands; with the rule `off` (the default, and every machine that
   * never turned it on) this is one diff of references and three `stat`s, and the write is exactly what it always was.
   */
  /** The sweep's memory (the placeholder ledger) from the sealed guards.json; null when it cannot be read (then nothing is stripped or believed). */
  const readLedger = async (): Promise<SweepMemory | null> => {
    try { return (await createGuardsStore(anchor.paths.guards).read()).sweep ?? { reverts: {} } } catch { return null }
  }
  /** r7: the pieces of `book` that are ACCEPTED members (`done` in their group's sealed checkpoint) and match `pred`; [] when guards.json cannot be read (the write itself then refuses). */
  async function acceptedMembers(book: TaskBook, pred: (s: TaskBook['subtasks'][number]) => boolean): Promise<Array<{ id: string; groupId: string }>> {
    const candidates = book.subtasks.filter(s => s.parentGroupId && pred(s))
    if (!candidates.length) return []
    let cps: Record<string, { members?: Record<string, { status: string }> }>
    try { cps = (await createGuardsStore(anchor.paths.guards).read()).checkpoints } catch { return [] }
    return candidates.flatMap(s => cps[s.parentGroupId!]?.members?.[s.id]?.status === 'done' ? [{ id: s.id, groupId: s.parentGroupId! }] : [])
  }
  /** r7: only the owner whose proof is the vault may remove or reopen an ACCEPTED piece; every session, flow or header owner is refused HERE, at the write, so every door is covered. */
  const isVaultOwner = (g?: GuardContext): boolean => g?.principal.kind === 'owner' && g.principal.via === 'vault-credential'
  const acceptedRefusal = (code: 'accepted_members' | 'accepted_reopen', what: string, ids: string[]): GuardRefused => new GuardRefused({
    code, piece: ids[0] ?? '', missing: ['an owner proof from the vault'],
    message: `${what} holds ${ids.length} accepted piece(s) (${ids.join(', ')}); a session may not remove or reopen accepted work — only the owner, with a vault proof, may.`,
    messagePt: `${what} tem ${ids.length} peça(s) aceita(s) (${ids.join(', ')}); uma sessão não pode remover nem reabrir trabalho aceito — só o dono, com prova do cofre.`,
  })
  /** r7: the owner's removal of accepted pieces is recorded in the ledger (same locked section) and WARNed, so the sweep neither restores nor reports them. */
  async function recordOwnerRemoval(accepted: ReadonlyArray<{ id: string; groupId: string }>): Promise<void> {
    if (!accepted.length) return
    console.warn(`[guard] owner removed accepted piece(s): ${accepted.map(a => a.id).join(', ')}`)
    if (currentBase) return
    const g = createGuardsStore(anchor.paths.guards)
    const doc = await g.read()
    const at = new Date().toISOString()
    await g.write({ ...doc, sweep: { ...(doc.sweep ?? { reverts: {} }), ownerRemoved: { ...(doc.sweep?.ownerRemoved ?? {}), ...Object.fromEntries(accepted.map(a => [a.id, { groupId: a.groupId, at }])) } } })
  }
  /** B4 r2: a `restoredBy: 'guard'` mark with no active ledger record is a forged label — dropped from the next write (the sweep reports it). */
  async function stripForgedMarks(book: TaskBook): Promise<TaskBook> {
    if (!book.subtasks.some(s => s.restoredBy === 'guard')) return book
    const ledger = await readLedger()
    if (!ledger) return book
    if (book.subtasks.every(s => s.restoredBy !== 'guard' || activePlaceholder(ledger, s.id))) return book
    return { ...book, subtasks: book.subtasks.map(s => { if (s.restoredBy !== 'guard' || activePlaceholder(ledger, s.id)) return s; const { restoredBy: _forged, ...rest } = s; return rest }) }
  }

  async function write(input: TaskBook): Promise<void> {
    const book = await stripForgedMarks(input)
    // The production memo is mutable. Only persisted bytes may describe the guarded before image.
    if (!currentBase) bookMemo.delete(file)
    const before = currentBase ? await read() : await readUncached()
    // Cheap exits first: the guard only cares about three collections.
    if (before === book || (before.tasks === book.tasks && before.subtasks === book.subtasks && before.statuses === book.statuses)) return writeRaw(book)
    // A downgrade may strip stages from tasks.json. The authenticated mirror is still the stored stage,
    // so restoring it is not new progress and must keep an existing checkpoint intact.
    let prior = sliceOf(before)
    let after = sliceOf(book)
    if ([...before.statuses, ...book.statuses].some(s => !isStatusStage(s.stage))) {
      const doc = { statusStages: await stageMirror() }
      prior = { ...prior, statuses: before.statuses.map(s => ({ ...s, stage: s.stage ?? doc.statusStages?.[s.id] })) }
      after = { ...after, statuses: book.statuses.map(s => ({ ...s, stage: s.stage ?? doc.statusStages?.[s.id] })) }
    }
    const raised = dismissing ? [] : boardRaises(prior, after)
    const groupKeys = new Set(after.subtasks.flatMap(s => s.parentGroupId ? [s.parentGroupId] : []))
    const isGroupKey = (key: string) => groupKeys.has(key)
    const beforePieces = new Map(boardPieces(prior).map(p => [p.key, p]))
    const retreats = currentGuard ? boardPieces(after).flatMap(p => {
      const was = beforePieces.get(p.key)
      return was && Math.max(p.statusRank, p.ciRank) < Math.max(was.statusRank, was.ciRank)
        ? [{ key: p.key, rank: Math.max(p.statusRank, p.ciRank), fromBoardStatus: was.status, boardStatus: p.status, boardStage: after.statuses.find(s => s.id === p.status)?.stage ?? '',
          ...(isGroupKey(p.key) ? { members: memberStatuses(after, p.key, Math.max(p.statusRank, p.ciRank)) } : {}) }] : []
    }) : []
    // Record only members changed by this accepted write; unrelated raw changes are not accepted with them.
    const beforeMembers = new Map(before.subtasks.map(s => [s.id, s]))
    // R5-4: only what the write CHANGED. A status it set is recorded as such; a member it only MOVED into a group keeps the status it
    // already had, which is accepted only as far as an authority covers it (its old group's accepted record, or its own checkpoint)
    // — a status a raw writer forged in `before` is never laundered by a move. A member that left its group is dropped from the record.
    const afterSubs = new Map(book.subtasks.map(s => [s.id, s]))
    const memberChanges: Array<{ key: string; id: string; status?: string; removed?: true; moved?: { fromGroup?: string; rank: number } }> = [
      ...before.subtasks.flatMap(s => s.parentGroupId && afterSubs.get(s.id)?.parentGroupId !== s.parentGroupId ? [{ key: s.parentGroupId, id: s.id, removed: true as const }] : []),
      ...book.subtasks.flatMap(s => {
        const was = beforeMembers.get(s.id)
        if (!s.parentGroupId || !s.status || (was?.status === s.status && was.parentGroupId === s.parentGroupId)) return []
        if (!was || was.status !== s.status) return [{ key: s.parentGroupId, id: s.id, status: s.status }]
        return [{ key: s.parentGroupId, id: s.id, status: s.status, moved: { ...(was.parentGroupId ? { fromGroup: was.parentGroupId } : {}), rank: subRank(prior, was) } }]
      }),
    ]
    if (raised.length === 0 && retreats.length === 0 && memberChanges.length === 0) return writeRaw(book)
    if (currentBase) {
      // Rule off when the mutation started: re-read it under the tasks lock. The activation takes tasks first, so while
      // that lock is really held the answer cannot change under us; a rule that moved means retake the full envelope.
      if (await ruleAState(anchor.dir) === 'off') return writeRaw(book)
      throw new RuleNoLongerOff()
    }
    // `withFileLock` goes ahead WITHOUT the lock after its wait; a guard never does (§2.6.1).
    if (currentContended) throw new GuardBusy('tasks')
    const subs = new Map(after.subtasks.map(s => [s.id, s] as const))
    const tasks = new Map(book.tasks.map(t => [t.id, t] as const))
    const stageOf = (status: string) => after.statuses.find(d => d.id === status)?.stage ?? 'none'
    await guardedWrite({
      raised, retreats, memberChanges, ctx: currentGuard, ...(classifyExempt ? { exemptClassification: classifyExempt } : {}), paths: anchor.paths, wiring: opts.guard,
      locks: [], alreadyHeld: ['tasks', 'deliveries', 'guards'],
      recordOf: async key => (await createDeliveryStore(anchor.paths.deliveries).read()).deliveries[key] ?? null,
      stateOf: r => { const status = (r.subtaskId ? subs.get(r.key)?.status : tasks.get(r.key)?.status) ?? ''; return { boardStatus: status, boardStage: stageOf(status), phase: null, ...(isGroupKey(r.key) ? { members: memberStatuses(after, r.key) } : {}) } },
      writeDocuments: () => writeRaw(book),
    })
  }


  async function writeRaw(book: TaskBook): Promise<void> {
    bookMemo.delete(file)
    await mkdir(dirname(file), { recursive: true })
    if (corrupt) {
      // Same rule as the registry: bytes we could not set aside are the only record of the board, so a
      // failed rename ABORTS the write (`corrupt` stays set and the next write retries it).
      const aside = `${file}.corrupt-${Date.now()}`
      try { await rename(file, aside) } catch (err) {
        console.error('[tasks] unreadable board at', file, 'could not be backed up — write aborted')
        throw new Error(`refusing to overwrite an unreadable board at ${file}: ${String(err)}`)
      }
      corrupt = false
    }
    const text = JSON.stringify(book, null, 2)
    await durableWrite(file, text)
    await refreshLastGood(file, text, Date.now(), undefined, book.tasks.length === 0 && book.subtasks.length === 0)
    for (const fn of [...bookWriteListeners]) { try { fn() } catch { /* a listener never fails a write */ } }
  }

  /**
   * One mutation. Rule A off (N2): exactly the base — the tasks file lock, re-run once when it was contended, never a
   * guards lock and never a fail-closed wait. Rule A shadow/on: the full tasks → deliveries → guards envelope, fail closed.
   */
  function enqueue<T>(fn: (held: { contended: boolean }) => Promise<T>, guard?: GuardContext): Promise<T> {
    const mutate = (base: boolean) => async (held: { contended: boolean }): Promise<T> => {
      const previous = [currentGuard, currentContended, currentBase] as const
      currentGuard = guard; currentContended = held.contended; currentBase = base
      try { return await fn(held) } finally { [currentGuard, currentContended, currentBase] = previous }
    }
    // A transaction already holds all files. Do not wait behind a queued mutation waiting for those same locks.
    const serialized = () => serializeGuardWrite(anchor.paths, 'tasks', () => mutate(false)({ contended: false }))
    if (inGuardTransaction(anchor.paths)) return serialized()
    const enveloped = () => withGuardEnvelope(anchor.paths, serialized)
    const run = async (): Promise<T> => {
      if (await peekRuleA(anchor.paths) !== 'off') return enveloped()
      try {
        let contended = false
        const first = await withFileLock(file, async held => { contended = held.contended; return mutate(true)(held) })
        if (!contended) return first
        return await withFileLock(file, held => mutate(true)(held))
      } catch (e) {
        if (e instanceof RuleNoLongerOff) return enveloped()
        throw e
      }
    }
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    read,
    wasQuarantined: () => hasQuarantine(file),
    registerComposerSubtask(subtask, guard) {
      return enqueue(async () => {
        const book = await read()
        const request = subtask.ownerRequest
        if (!request || !book.tasks.some(t => t.id === subtask.taskId)) return null
        const existing = book.subtasks.find(s => s.ownerRequest?.messageId === request.messageId)
        if (existing) return existing
        const adopted = book.subtasks.find(s => s.id === subtask.id)
        if (adopted && (adopted.taskId !== subtask.taskId || adopted.ownerRequest || !adopted.title.includes(request.pedidoId))) return null
        // Read progress under THIS lock: filing may have started the engine's card since the caller read it.
        const saved: Subtask = adopted ? { ...adopted, title: subtask.title, priority: subtask.priority,
          notes: subtask.notes, dueDate: subtask.dueDate, ownerRequest: request, updatedAt: subtask.updatedAt,
          assignee: adopted.assignee ?? subtask.assignee } : subtask
        const registered: TaskEvent = { id: `e-${saved.id.slice(2)}`, taskId: saved.taskId, subtaskId: saved.id,
          actor: 'owner:composer', kind: 'create', at: request.at, detail: saved.title, to: saved.status }
        await write({ ...book, subtasks: [...book.subtasks.filter(s => s.id !== saved.id), saved],
          tasks: book.tasks.map(t => t.id === subtask.taskId ? { ...t, updatedAt: request.at } : t),
          events: [...book.events, registered].slice(-MAX_EVENTS) })
        return saved
      }, guard)
    },
    upsertTask(task, guard) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, tasks: [...book.tasks.filter(t => t.id !== task.id), task] })
      }, guard)
    },
    upsertAttempt(attempt) {
      return enqueue(async () => {
        const book = await read()
        await write({
          ...book,
          attempts: [...book.attempts.filter(a => a.id !== attempt.id), attempt],
        })
      })
    },
    patchTask(id, patch, o) {
      return enqueue(async () => {
        const book = await read()
        const target = book.tasks.find(t => t.id === id)
        // Nothing to change: writing anyway would touch the file, and pointlessly clear a pending
        // corrupt-quarantine, for a no-op.
        if (!target) return false
        if (patch.status === 'in_review' && o?.allowOpenSubtasks !== true && book.subtasks.some(s => s.taskId === id && !s.parentGroupId && !['done', 'abandoned'].includes(s.status))) return false
        const next = { ...target, ...patch }
        await write({ ...book, tasks: book.tasks.map(t => (t.id === id ? next : t)) })
        return true
      }, o?.guard)
    },
    addComment(c) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, comments: [...book.comments, c] })
      })
    },
    editComment(id, body) {
      return enqueue(async () => {
        const book = await read()
        const target = book.comments.find(c => c.id === id)
        if (!target) return false
        const next = { ...target, body }
        await write({ ...book, comments: book.comments.map(c => (c.id === id ? next : c)) })
        return true
      })
    },
    removeComment(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.comments.some(c => c.id === id)) return false
        await write({ ...book, comments: book.comments.filter(c => c.id !== id) })
        return true
      })
    },
    upsertThread(t) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, threads: [...book.threads.filter(x => x.id !== t.id), t] })
      })
    },
    updateThread(id, fn) {
      return enqueue(async () => {
        const book = await read()
        const target = book.threads.find(t => t.id === id)
        if (!target) return false
        const next = fn(target)
        await write({ ...book, threads: book.threads.map(t => (t.id === id ? next : t)) })
        return true
      })
    },
    updateComment(id, fn) {
      return enqueue(async () => {
        const book = await read()
        const target = book.comments.find(c => c.id === id)
        if (!target) return false
        const next = fn(target)
        await write({ ...book, comments: book.comments.map(c => (c.id === id ? next : c)) })
        return true
      })
    },
    upsertSubtask(t, guard) {
      return enqueue(async () => {
        const book = await read()
        const next = { ...t }
        if (next.status !== 'blocked') delete next.blockedReason
        // r7 (re-QA r5 F2 + F3): an ACCEPTED member is not reopened (done -> anything else) and does not leave its group
        // (`parentGroupId` cleared or changed) except by the owner with a vault proof; judged here so no door can bypass it.
        const prior = book.subtasks.find(x => x.id === t.id)
        let exempt: string | undefined
        if (prior && ((prior.status === 'done' && next.status !== 'done') || next.parentGroupId !== prior.parentGroupId)) {
          const accepted = await acceptedMembers(book, x => x.id === prior.id)
          if (accepted.length) {
            if (!isVaultOwner(guard)) throw acceptedRefusal('accepted_reopen', `Piece ${prior.id}`, [prior.id])
            exempt = prior.id // r8 C: the vault-proven owner is not stopped by guard A's classification for this one operation
          }
        }
        classifyExempt = exempt ? new Set([exempt]) : undefined
        try { await write({ ...book, subtasks: [...book.subtasks.filter(x => x.id !== t.id), next] }) } finally { classifyExempt = undefined }
      }, guard)
    },
    removeSubtask(id, opts) {
      return enqueue(async () => {
        const book = await read()
        if (!book.subtasks.some(t => t.id === id)) return false
        // B4 r2: only a piece the sweep's ledger names may be dismissed this way; the dismissal is marked in the ledger in the same locked section.
        const ledger = opts?.dismissPlaceholder ? await readLedger() : null
        if (opts?.dismissPlaceholder && !activePlaceholder(ledger ?? undefined, id)) return false
        // r7: a GROUP holding an accepted member goes only by the owner with a vault proof (its members would be orphaned from the acceptance).
        const acceptedInGroup = await acceptedMembers(book, t => t.parentGroupId === id)
        if (acceptedInGroup.length && !isVaultOwner(opts?.ownerRemoval ?? opts?.guard)) throw acceptedRefusal('accepted_members', `Group ${id}`, acceptedInGroup.map(a => a.id))
        // r8 B: an individual ACCEPTED member goes only by the vault-proven owner too (with or without opts).
        const acceptedSelf = await acceptedMembers(book, t => t.id === id)
        if (acceptedSelf.length && !isVaultOwner(opts?.ownerRemoval ?? opts?.guard)) throw acceptedRefusal('accepted_members', `Piece ${id}`, [id])
        dismissing = !!opts?.dismissPlaceholder || !!opts?.ownerRemoval || (acceptedInGroup.length > 0) || (acceptedSelf.length > 0)
        const removedGroup = opts?.ownerRemoval ? book.subtasks.find(t => t.id === id)?.parentGroupId : undefined
        try {
        // A GROUP's former MEMBERS become ordinary loose subtasks again — the natural fallback,
        // since a member without a group is exactly what a loose subtask is (§F.1). Done in the
        // SAME write as the deletion, under the same lock, or a crash between the two could leave a
        // member pointing at an id nothing names — permanently, since nothing else ever clears
        // `parentGroupId` and `subtaskViews`'s member-exclusion filter would keep excluding it
        // forever with no UI/API path back (unlike `attemptViews`'s handling of a dangling
        // `attemptId`, which folds an orphan into a documented "unattributed" bucket rather than
        // losing track of it). Only a record whose `parentGroupId` names THIS id is touched — every
        // other subtask, member of another group or not, is passed through untouched.
        await write({
          ...book,
          subtasks: book.subtasks
            .filter(t => t.id !== id)
            .map(t => (t.parentGroupId === id ? { ...t, parentGroupId: undefined } : t)),
          // Its comments are RE-HOMED onto the task, in the same write — deleting a board entry
          // never deletes what people said on it. Clearing the target is exactly how a comment
          // written before threads existed reads, so nothing downstream needs a new case.
          comments: book.comments.map(c => {
            if (c.subtaskId !== id) return c
            const { subtaskId: _gone, ...rest } = c
            return rest
          }),
          // A thread opened on it is re-homed the same way: it becomes the task's.
          threads: book.threads.map(t => {
            if (t.subtaskId !== id) return t
            const { subtaskId: _gone, ...rest } = t
            return rest
          }),
          // A conversation filed on the removed subtask falls back to its DELIVERY — the repair
          // `reconcileAttachment` applies to a registry row whose `subtaskId` names nothing. Left
          // dangling it would still count on the task but sit in no bucket, in the same write.
          historicalSessions: book.historicalSessions.map(h => {
            if (h.subtaskId !== id) return h
            const { subtaskId: _dropped, ...rest } = h
            return rest
          }),
          nativeSessions: book.nativeSessions.map(n => {
            if (n.subtaskId !== id) return n
            const { subtaskId: _dropped, ...rest } = n
            return rest
          }),
        })
        // r3: an OWNER removal of an accepted member is recorded in the ledger (same locked section) so the sweep neither restores nor reports it.
        // With the rule off (`currentBase`) only the tasks lock is held and no sweep runs, so there is nothing to record.
        if (opts?.ownerRemoval && removedGroup && !currentBase) {
          const g = createGuardsStore(anchor.paths.guards)
          const doc = await g.read()
          await g.write({ ...doc, sweep: { ...(doc.sweep ?? { reverts: {} }), ownerRemoved: { ...(doc.sweep?.ownerRemoved ?? {}), [id]: { groupId: removedGroup, at: new Date().toISOString() } } } })
        }
        await recordOwnerRemoval([...acceptedInGroup, ...acceptedSelf])
        if (opts?.dismissPlaceholder && !currentBase) {
          const g = createGuardsStore(anchor.paths.guards)
          const doc = await g.read()
          const rec = doc.sweep?.placeholders?.[id]
          if (rec) await g.write({ ...doc, sweep: { ...(doc.sweep ?? { reverts: {} }), placeholders: { ...doc.sweep!.placeholders, [id]: { ...rec, dismissedAt: new Date().toISOString() } } } })
        }
        return true
        } finally { dismissing = false }
      }, opts?.dismissPlaceholder ?? opts?.ownerRemoval ?? opts?.guard)
    },
    async acceptedMemberOf(id) {
      const group = (await read()).subtasks.find(t => t.id === id)?.parentGroupId
      if (!group) return null
      try {
        const status = (await createGuardsStore(anchor.paths.guards).read()).checkpoints[group]?.members?.[id]?.status
        return status === 'done' ? { groupId: group, status } : null
      } catch { return null }
    },
    async placeholderOf(id) { return activePlaceholder((await readLedger()) ?? undefined, id) },
    addFile(f) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, files: [...book.files, f] })
      })
    },
    removeFile(id, deletion = directDeletion) {
      return enqueue(held => deletion(async () => {
        const book = await read()
        if (!book.files.some(f => f.id === id)) return false
        await write({ ...book, files: book.files.filter(f => f.id !== id) })
        return true
      }, { tasks: !held.contended }))
    },
    removeTask(id, deletion = directDeletion, opts) {
      return enqueue(held => deletion(async () => {
        const book = await read()
        if (!book.tasks.some(t => t.id === id)) return false
        // r7 (re-QA r5 F1): a task holding an ACCEPTED member is deleted only by the owner with a vault proof; the refusal is at the store write.
        const accepted = await acceptedMembers(book, s => s.taskId === id)
        if (accepted.length && !isVaultOwner(opts?.guard)) throw acceptedRefusal('accepted_members', `Task ${id}`, accepted.map(a => a.id))
        await write({
          tasks: book.tasks.filter(t => t.id !== id),
          attempts: book.attempts.filter(a => a.taskId !== id),
          comments: book.comments.filter(c => c.taskId !== id),
          threads: book.threads.filter(t => t.taskId !== id),
          subtasks: book.subtasks.filter(t => t.taskId !== id),
          files: book.files.filter(f => f.taskId !== id),
          // A historical link is board data hanging off the task, so it goes with it. The
          // CONVERSATION does not — it is still in the consolidate store, and dropping the link is what
          // frees it to be filed elsewhere (a link left behind would name a task nobody can open and
          // keep the conversation from ever being owned by another one).
          historicalSessions: book.historicalSessions.filter(h => h.taskId !== id),
          // A native link goes with its task too; the SESSION stays in the engine, free to be filed again.
          nativeSessions: book.nativeSessions.filter(n => n.taskId !== id),
          events: book.events.filter(e => e.taskId !== id),
          // The status VOCABULARY is board-wide, not per-task — deleting a task never touches it.
          statuses: book.statuses,
          types: book.types,
          ...(book.typesSeeded ? { typesSeeded: true } : {}),
          ...(book.inReviewSeeded ? { inReviewSeeded: true } : {}),
          // Remembered as DELETED, or the legacy migration mints it again on the next read.
          tombstones: [...new Set([...book.tombstones, id])],
        })
        await recordOwnerRemoval(accepted)
        return true
      }, { tasks: !held.contended }))
    },
    clearTombstone(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.tombstones.includes(id)) return
        await write({ ...book, tombstones: book.tombstones.filter(t => t !== id) })
      })
    },
    patchAttempt(id, patch) {
      return enqueue(async () => {
        const book = await read()
        const target = book.attempts.find(a => a.id === id)
        if (!target) return false
        const next = { ...target, ...patch }
        await write({ ...book, attempts: book.attempts.map(a => (a.id === id ? next : a)) })
        return true
      })
    },
    claimTask(o) {
      return enqueue(async () => {
        const book = await read()
        const target = book.tasks.find(t => t.id === o.id)
        if (!target) return { ok: false as const, reason: 'missing' as const }
        // The decision happens HERE, inside the lock: two agents asking in the same millisecond
        // cannot both be told yes, which is the entire reason this is a store method and not a
        // read-then-patch in the caller.
        if (heldByOther(target, o.by, o.nowMs) && !o.takeover) {
          return { ok: false as const, reason: 'held' as const, task: target }
        }
        const claim: TaskClaim = {
          by: o.by,
          at: new Date(o.nowMs).toISOString(),
          expiresAt: new Date(o.nowMs + o.leaseMs).toISOString(),
          ...(o.sessionId ? { sessionId: o.sessionId } : {}),
          ...(o.note ? { note: o.note } : {}),
        }
        const next: Task = { ...target, claim, updatedAt: new Date(o.nowMs).toISOString() }
        await write({ ...book, tasks: book.tasks.map(t => (t.id === o.id ? next : t)) })
        return { ok: true as const, task: next }
      })
    },
    releaseTask(o) {
      return enqueue(async () => {
        const book = await read()
        const target = book.tasks.find(t => t.id === o.id)
        if (!target) return { ok: false as const, reason: 'missing' as const }
        if (target.claim && target.claim.by !== o.by && !o.force) {
          return { ok: false as const, reason: 'other' as const, task: target }
        }
        const next: Task = { ...target }
        delete next.claim
        await write({ ...book, tasks: book.tasks.map(t => (t.id === o.id ? next : t)) })
        return { ok: true as const, task: next }
      })
    },
    setRanks(ranks) {
      return enqueue(async () => {
        if (ranks.length === 0) return
        const book = await read()
        const by = new Map(ranks.map(r => [r.id, r.rank]))
        await write({
          ...book,
          tasks: book.tasks.map(t => (by.has(t.id) ? { ...t, rank: by.get(t.id)! } : t)),
        })
      })
    },
    statusStageMirror: () => stageMirror(),
    applyBoardReverts(batch) {
      return enqueue(async () => {
        const book = await read()
        const bySub = new Map(batch.reverts.filter(r => r.subtaskId).map(r => [r.subtaskId!, r] as const))
        const byTask = new Map(batch.reverts.filter(r => !r.subtaskId).map(r => [r.key, r] as const))
        const subtasks = book.subtasks.map(s => {
          const r = bySub.get(s.id)
          if (!r) return s
          const next = { ...s, status: r.to, done: r.to === 'done', updatedAt: batch.at, ...(r.parentGroupId ? { parentGroupId: r.parentGroupId } : {}), ...(r.parentGroupId && r.groupTaskId ? { taskId: r.groupTaskId } : {}) }
          if (r.clearCi) delete next.ci
          if (r.to === 'blocked') next.blockedReason = 'externo: an unknown writer keeps moving this piece'
          else delete next.blockedReason
          return next
        })
        const present = new Set(book.subtasks.map(s => s.id))
        for (const r of batch.reverts) {
          if (!r.subtaskId || !r.placeholder || !r.parentGroupId || present.has(r.subtaskId)) continue
          if (!book.subtasks.some(s => s.id === r.parentGroupId)) continue
          subtasks.push({
            id: r.subtaskId, taskId: r.placeholder.taskId, title: r.placeholder.title, notes: r.placeholder.description, restoredBy: 'guard', parentGroupId: r.parentGroupId, status: r.to, done: r.to === 'done',
            createdAt: batch.at, updatedAt: batch.at, ...(r.to === 'blocked' ? { blockedReason: 'externo: an unknown writer keeps moving this piece' } : {}),
          })
        }
        const tasks = book.tasks.map(t => (byTask.has(t.id) ? { ...t, status: byTask.get(t.id)!.to, updatedAt: batch.at, ...(byTask.get(t.id)!.to === 'blocked' ? { blockedReason: 'externo: an unknown writer keeps moving this piece' } : {}) } : t))
        const events = [...book.events, ...batch.events]
        await write({ ...book, subtasks, tasks, comments: [...book.comments, ...batch.comments], events: events.slice(Math.max(0, events.length - MAX_EVENTS)) })
      })
    },
    logEvents(events) {
      return enqueue(async () => {
        if (events.length === 0) return
        const book = await read()
        const all = [...book.events, ...events]
        // Oldest go first once the cap is reached — the question the log answers is about the
        // recent end, and the durable record lives on the tasks themselves.
        await write({ ...book, events: all.slice(Math.max(0, all.length - MAX_EVENTS)) })
      })
    },
    seedStatuses(list) {
      return enqueue(async () => {
        const book = await read()
        // Re-checked HERE, under the lock, against the freshest read — not the caller's own
        // (possibly now-stale) read that decided a migration was needed. Two processes racing to
        // open the same brand-new book must not both win: the second one through the lock sees the
        // first one's write and refuses.
        if (book.statuses.length > 0) return
        await write({ ...book, statuses: [...list] })
      })
    },
    seedInReview(def) {
      return enqueue(async () => {
        const book = await read()
        if (book.inReviewSeeded) return
        const add = def && !book.statuses.some(s => s.id === def.id) ? [def] : []
        await write({ ...book, statuses: [...book.statuses, ...add], inReviewSeeded: true })
      })
    },
    upsertStatus(def) {
      return enqueue(async () => {
        const book = await read()
        await write({
          ...book,
          statuses: [...book.statuses.filter(s => s.id !== def.id), def],
        })
      })
    },
    setStatusStages(stages) {
      return enqueue(async () => {
        const book = await read()
        let changed = false
        const next = book.statuses.map(s => {
          const st = stages[s.id]
          if (isStatusStage(s.stage) || !isStatusStage(st)) return s
          changed = true
          return { ...s, stage: st }
        })
        if (changed) await write({ ...book, statuses: next })
      })
    },
    reorderStatuses(ids) {
      return enqueue(async () => {
        const book = await read(); const rank = new Map(ids.map((id, i) => [id, i]))
        await write({ ...book, statuses: book.statuses.map(s => ({ ...s, order: rank.get(s.id) ?? s.order })).sort((a, b) => a.order - b.order) })
      })
    },
    fileHistorical(link) {
      return enqueue(async () => {
        const book = await read()
        const replaced = book.historicalSessions.find(h => h.id === link.id)
        await write({
          ...book,
          historicalSessions: [...book.historicalSessions.filter(h => h.id !== link.id), link],
        })
        return replaced ? { replaced } : {}
      })
    },
    unfileHistorical(ref) {
      return enqueue(async () => {
        const book = await read()
        const found = book.historicalSessions.find(h => h.id === ref || h.conversationId === ref)
        if (!found) return null
        await write({
          ...book,
          historicalSessions: book.historicalSessions.filter(h => h.id !== found.id),
        })
        return found
      })
    },
    fileNative(link) {
      return enqueue(async () => {
        const book = await read()
        const replaced = book.nativeSessions.find(n => n.id === link.id)
        const usage = link.usage ?? replaced?.usage
        await write({
          ...book,
          nativeSessions: [...book.nativeSessions.filter(n => n.id !== link.id), { ...link, ...(usage ? { usage } : {}) }],
        })
        return replaced ? { replaced } : {}
      })
    },
    unfileNative(ref) {
      return enqueue(async () => {
        const book = await read()
        const found = book.nativeSessions.find(n => n.id === ref || n.sessionId === ref)
        if (!found) return null
        await write({ ...book, nativeSessions: book.nativeSessions.filter(n => n.id !== found.id) })
        return found
      })
    },
    reportNativeUsage(sessionId, usage) {
      return enqueue(async () => {
        const book = await read()
        const found = book.nativeSessions.find(n => n.sessionId === sessionId)
        if (!found) return false
        if (found.usage && Date.parse(found.usage.updatedAt) > Date.parse(usage.updatedAt)) return true
        await write({
          ...book,
          nativeSessions: book.nativeSessions.map(n => (n.id === found.id ? { ...n, usage } : n)),
        })
        return true
      })
    },
    seedTypes(list) {
      return enqueue(async () => {
        const book = await read()
        if (book.typesSeeded || book.types.length > 0) return
        await write({ ...book, types: [...list], typesSeeded: true })
      })
    },
    upsertType(def) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, types: [...book.types.filter(s => s.id !== def.id), def] })
      })
    },
    reorderTypes(ids) {
      return enqueue(async () => {
        const book = await read(); const rank = new Map(ids.map((id, i) => [id, i]))
        await write({ ...book, types: book.types.map(t => ({ ...t, order: rank.get(t.id) ?? t.order })).sort((a, b) => a.order - b.order) })
      })
    },
    removeType(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.types.some(s => s.id === id)) return false
        await write({ ...book, types: book.types.filter(s => s.id !== id) })
        return true
      })
    },
    removeStatus(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.statuses.some(s => s.id === id)) return false
        await write({ ...book, statuses: book.statuses.filter(s => s.id !== id) })
        return true
      })
    },
  }
}

/** The CI signal exactly as `task-live.ts` trusts it: booleans, a tag string or null, a PR number or null. */
function sanitizeCi(raw: unknown): { mergedMain: boolean; releaseGreen: boolean; tagPublished: boolean; tag: string | null; pr: number | null } {
  const o = raw as Record<string, unknown>
  return {
    mergedMain: o.mergedMain === true, releaseGreen: o.releaseGreen === true, tagPublished: o.tagPublished === true,
    tag: typeof o.tag === 'string' && o.tag ? o.tag : null,
    pr: typeof o.pr === 'number' && Number.isFinite(o.pr) ? o.pr : null,
  }
}
