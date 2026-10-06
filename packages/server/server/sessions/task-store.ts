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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isValidStatusColor, normalizeStagedSession, sanitizeCommentAttachments, type TaskStatusDef, type TaskTypeDef } from '@agentistics/core'
import { withFileLock } from './file-lock'
import { historicalLinkId, migratePriority, migrateStatus, nativeLinkId, subtaskDone } from './task-model'
import { heldByOther } from './task-next'
import { sanitizeNativeUsage } from './task-native'
import type { NativeSessionLink, NativeSessionUsage } from './task-model'
import type {
  Attempt, AttemptStatus, HistoricalSession, Subtask, Task, TaskBook, TaskClaim, TaskComment,
  TaskEvent, TaskFile, TaskLink, TaskPriority, TaskStatus, TaskThread,
} from './task-model'
import { isCommentKind, type ThreadDelivery, type ThreadParticipant } from '@agentistics/core'

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
  /**
   * Does this delivery travel to a central? See `Task.shared` — absent reads as NOT shared.
   *
   * A field missing from THIS list is silently dropped by `patchTask` (`{...target, ...patch}`)
   * while every caller is told the write succeeded, and TypeScript cannot catch it: `editTask`
   * builds its patch out of spreads, where excess-property checking does not fire. That is
   * exactly what happened to this field, and `task-store.test.ts` now pins it.
   */
  shared?: boolean
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
  upsertTask(task: Task): Promise<void>
  upsertAttempt(attempt: Attempt): Promise<void>
  /** False when no record carries that id — never a silent success. */
  patchTask(id: string, patch: TaskPatch): Promise<boolean>
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
  upsertSubtask(t: Subtask): Promise<void>
  removeSubtask(id: string): Promise<boolean>
  addFile(f: TaskFile): Promise<void>
  /** Removes the RECORD. The bytes on disk are the caller's to unlink — see `task-files.ts`. */
  removeFile(id: string): Promise<boolean>
  /**
   * Delete a task and everything hanging off it.
   *
   * Sessions are NOT touched: a row's `taskId` becomes a dangling reference, which reads as
   * "no attempt named" rather than vanishing. Deleting a board entry must never delete work.
   */
  removeTask(id: string): Promise<boolean>
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
  /** Add a new status, or edit an existing one's label/color. The `id` is never rewritten by this —
   *  create mints a fresh entry, edit finds the existing one by `id` and replaces label/color only. */
  upsertStatus(def: TaskStatusDef): Promise<void>
  reorderStatuses(ids: readonly string[]): Promise<void>
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
    // A BOOLEAN only, and only when it is really one: anything else is not an answer to "may this
    // travel", and the absent reading is the safe one. Kept explicitly rather than defaulted to
    // `false`, so "nobody has decided" and "somebody said no" stay distinguishable in the file —
    // both read as NOT shared through `taskShared`, which is the only reading anything uses.
    ...(typeof t.shared === 'boolean' ? { shared: t.shared } : {}),
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
    ...(str(t.parentGroupId) ? { parentGroupId: str(t.parentGroupId)! } : {}),
    // A staged session draft (t-918cc82233) — same reason the hierarchy fields above are carried
    // here explicitly: written by `patchSubtask` and dropped silently by the next `read()` unless
    // this whitelist parses it back. `normalizeStagedSession` is total and never repairs a
    // half-read draft, the same rule `normalizeSessionPresets` applies to a saved preset.
    ...(normalizeStagedSession(t.stagedSession) ? { stagedSession: normalizeStagedSession(t.stagedSession)! } : {}),
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

export function createTaskStore(file: string): TaskStore {
  // One in-process writer. Each mutation appends to this chain, so read-modify-write sequences run
  // strictly one after another even when several land at once.
  let queue: Promise<unknown> = Promise.resolve()
  // Set when a read failed to parse. The bad bytes are still on disk at that point; they are moved
  // aside (not overwritten) by the next write, so the empty book a corrupt file produces can never
  // become permanent data loss.
  let corrupt = false

  async function read(): Promise<TaskBook> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      corrupt = false
      return EMPTY_BOOK()
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      corrupt = false
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
      }
    } catch {
      corrupt = true
      return EMPTY_BOOK()
    }
  }

  async function write(book: TaskBook): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    if (corrupt) {
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      corrupt = false
    }
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(book, null, 2), 'utf8')
    await rename(tmp, file)
  }

  /** One mutation, under the cross-process lock, re-run once when the lock was contended. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      let contended = false
      const first = await withFileLock(file, async held => {
        contended = held.contended
        return fn()
      })
      if (!contended) return first
      return await withFileLock(file, () => fn())
    }
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    read,
    upsertTask(task) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, tasks: [...book.tasks.filter(t => t.id !== task.id), task] })
      })
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
    patchTask(id, patch) {
      return enqueue(async () => {
        const book = await read()
        const target = book.tasks.find(t => t.id === id)
        // Nothing to change: writing anyway would touch the file, and pointlessly clear a pending
        // corrupt-quarantine, for a no-op.
        if (!target) return false
        const next = { ...target, ...patch }
        await write({ ...book, tasks: book.tasks.map(t => (t.id === id ? next : t)) })
        return true
      })
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
    upsertSubtask(t) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, subtasks: [...book.subtasks.filter(x => x.id !== t.id), t] })
      })
    },
    removeSubtask(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.subtasks.some(t => t.id === id)) return false
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
        return true
      })
    },
    addFile(f) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, files: [...book.files, f] })
      })
    },
    removeFile(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.files.some(f => f.id === id)) return false
        await write({ ...book, files: book.files.filter(f => f.id !== id) })
        return true
      })
    },
    removeTask(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.tasks.some(t => t.id === id)) return false
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
          // Remembered as DELETED, or the legacy migration mints it again on the next read.
          tombstones: [...new Set([...book.tombstones, id])],
        })
        return true
      })
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
    upsertStatus(def) {
      return enqueue(async () => {
        const book = await read()
        await write({
          ...book,
          statuses: [...book.statuses.filter(s => s.id !== def.id), def],
        })
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
