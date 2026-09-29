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
import { isValidStatusColor, normalizeStagedSession, type TaskStatusDef } from '@agentistics/core'
import { withFileLock } from './file-lock'
import { historicalLinkId, migratePriority, migrateStatus, subtaskDone } from './task-model'
import { heldByOther } from './task-next'
import type {
  Attempt, AttemptStatus, HistoricalSession, Subtask, Task, TaskBook, TaskClaim, TaskComment,
  TaskEvent, TaskFile, TaskLink, TaskPriority, TaskStatus,
} from './task-model'

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
  tasks: [], attempts: [], comments: [], subtasks: [], files: [], tombstones: [], events: [],
  historicalSessions: [],
  // Absent/empty is exactly what `planStatusMigration` reads as "never seeded yet" — see
  // `task-source.ts`'s `ensureStatusesSeeded`, which fills this in on the very next load.
  statuses: [],
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
  /** False when no status carries that id — never a silent success. The caller (`task-web.ts`) is
   *  the one that checks `canDeleteStatus` BEFORE calling this; this method trusts that call. */
  removeStatus(id: string): Promise<boolean>

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
  const id = str(c.id); const taskId = str(c.taskId); const body = str(c.body)
  if (!id || !taskId || !body) return null
  return {
    id, taskId, body,
    author: str(c.author) ?? 'unknown',
    createdAt: str(c.createdAt) ?? new Date(0).toISOString(),
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
        tombstones: arr(raw.tombstones).filter((v): v is string => typeof v === 'string'),
        events: arr(raw.events).map(sanitizeEvent).filter((e): e is TaskEvent => e !== null),
        // Absent on a book written before this feature existed — same reason every field above goes
        // through `arr` rather than trusting it to be there.
        statuses: arr(raw.statuses).map(sanitizeStatusDef).filter((s): s is TaskStatusDef => s !== null),
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
          // A conversation filed on the removed subtask falls back to its DELIVERY — the repair
          // `reconcileAttachment` applies to a registry row whose `subtaskId` names nothing. Left
          // dangling it would still count on the task but sit in no bucket, in the same write.
          historicalSessions: book.historicalSessions.map(h => {
            if (h.subtaskId !== id) return h
            const { subtaskId: _dropped, ...rest } = h
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
          subtasks: book.subtasks.filter(t => t.taskId !== id),
          files: book.files.filter(f => f.taskId !== id),
          // A historical link is board data hanging off the task, so it goes with it. The
          // CONVERSATION does not — it is still in the consolidate store, and dropping the link is what
          // frees it to be filed elsewhere (a link left behind would name a task nobody can open and
          // keep the conversation from ever being owned by another one).
          historicalSessions: book.historicalSessions.filter(h => h.taskId !== id),
          events: book.events.filter(e => e.taskId !== id),
          // The status VOCABULARY is board-wide, not per-task — deleting a task never touches it.
          statuses: book.statuses,
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
