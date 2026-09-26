/**
 * tasks.ts — the browser's reader for `/api/tasks`.
 *
 * It holds NO arithmetic. Every figure on the screen was computed by `task-rollup.ts` on the
 * server and travels already decided, because a second implementation of "what did this delivery
 * cost" is a second answer, and the two would drift. The only thing this file decides is how to
 * ask and what to do when the answer does not come.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  sortTaskStatuses, type Filters, type StagedSessionDraft, type TaskPriorityId, type TaskProgress,
} from '@agentistics/core'
import { getDateRangeFilter } from '../hooks/useData'

export type LinkProvenance = 'assigned' | 'observed' | 'none'
/**
 * The status VOCABULARY is an editable list now (`@agentistics/core`'s `TaskStatusDef`), not a
 * closed union — see `task-model.ts`'s `TaskStatus` on the server for the full rationale. Kept as
 * its own named type here (rather than inlining `string` at every call site) so a future PR wiring
 * the dynamic list into the row/kanban rendering has one place to widen call sites that still expect
 * the old semantics, and so `TaskStatus` keeps meaning "a status id" rather than "any string" to a
 * reader of this file.
 */
export type TaskStatus = string
export type AttemptStatus = 'running' | 'delivered' | 'abandoned'

export interface AttemptRollup {
  sessionsUsed: number
  sessionsLinked: number
  provenance: Record<LinkProvenance, number>
  rounds: number | null
  activeMinutes: number | null
  tokens: number | null
  costUSD: number | null
  /** `costUSD` by harness — see the server's `AttemptRollup`. Optional: an older server omits it. */
  costByHarness?: Record<string, number> | null
  costMeasuredSessions: number
  costEstimatedSessions: number
  credits: { nanoAiu: number; premiumRequests: number } | null
  mixedCurrency: boolean
}

/** One machine's shared board, as `GET /api/team/tasks` reports it. */
export interface CentralTaskRow {
  memberId: string
  user: string
  task: TaskRecord
  comments: TaskComment[]
  subtasks: Subtask[]
  files: TaskFile[]
  counts: { comments: number; subtasks: number; subtasksDone: number; files: number }
  rollup: AttemptRollup
  harnesses: string[]
  repos: string[]
  /** Sessions its machine withholds from this central — a rule somebody set. */
  sessionsWithheld: number
  /** Sessions this central does not hold — a push in flight, or one removed since. */
  sessionsMissing: number
}

export interface CentralTaskMachine {
  memberId: string
  user: string
  rows: CentralTaskRow[]
}

export interface TaskRecord {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  /**
   * When real work actually began, ISO — system-stamped, never user-editable. See the server's
   * `Task.startedAt` for the full rule.
   */
  startedAt?: string
  repo?: string
  /** Task ids that must finish first. */
  blockedBy?: string[]
  links?: TaskLink[]
  /** Absent reads as `none` — "nobody has said", which is not the same as `low`. */
  priority?: TaskPriorityId
  /** SUPERSEDED by `startedAt`/`deliveredAt` — kept only so old records round-trip; no UI sets it. */
  dueDate?: string
  startDate?: string
  labels?: string[]
  /** Manual order, a fractional-index string. Absent = never dragged. */
  rank?: string
  /** Who is on it right now, and until when — a LEASE, so it expires on its own. */
  claim?: TaskClaim
  /** Why it is blocked. `blocked` cannot be recorded without this or a blocking task. */
  blockedReason?: string
  /** Does this delivery travel to a central? ABSENT READS AS NOT SHARED — see `TaskFieldPatch`. */
  shared?: boolean
}

export interface TaskClaim {
  by: string
  at: string
  expiresAt: string
  sessionId?: string
  note?: string
}

/** One thing that happened to a task. `kind`: status | claim | release | priority | assign | … */
export interface TaskEvent {
  id: string
  taskId: string
  at: string
  actor: string
  kind: string
  detail?: string
  from?: string
  to?: string
}

export interface TaskLink { id: string; url: string; label?: string; kind?: string }

export interface AttemptView {
  id: string | null
  label: string
  config?: { harness: string; model?: string; effort?: string; method?: string }
  status: AttemptStatus | 'unattributed'
  rollup: AttemptRollup
}

/**
 * One day of board-wide activity. A day nobody touched is ABSENT from `BoardOverview.daily` rather
 * than present at zero — see the server's `task-overview.ts` for the full rule. Mirror of the
 * server's `BoardDailyPoint`.
 */
export interface BoardDailyPoint {
  date: string
  /** Sessions whose OWN start day falls here. */
  sessionsStarted: number
  /** Tasks marked `done` on this day. */
  delivered: number
  /** Tasks opened on this day. */
  created: number
}

export interface BoardOverview {
  statusCounts: Record<string, number>
  tasks: number
  inFlight: number
  delivered: number
  abandoned: number
  totalCostUSD: number | null
  /** `totalCostUSD` (and so `avgCostPerTask`) split by harness; `null` when it is. */
  costByHarness?: Record<string, number> | null
  /** `avgCostPerDelivered`'s sessions split by harness; `null` when nothing delivered carries a cost. */
  deliveredCostByHarness?: Record<string, number> | null
  avgCostPerTask: number | null
  avgCostPerDelivered: number | null
  /** How many tasks carry no cost at all — the averages above name their own gap. */
  tasksWithoutCost: number
  /** Of the DELIVERED tasks specifically, how many carry no cost. See the server's `task-overview.ts`. */
  deliveredWithoutCost: number
  avgRoundsPerTask: number | null
  avgSessionsPerTask: number | null
  avgDeliveryMs: number | null
  totalSessions: number
  totalTokens: number | null
  topModels: Bucket[]
  topHarnesses: Bucket[]
  /** The board's activity over time, ascending. See `BoardDailyPoint`. */
  daily: BoardDailyPoint[]
}

export interface TaskListRow {
  task: TaskRecord
  attempts: number
  rollup: AttemptRollup
  counts: { comments: number; subtasks: number; subtasksDone: number; files: number }
  harnesses: string[]
  /**
   * The repositories this task's sessions touched — normalized remotes, `''` for the "no linked
   * repository" bucket. Decided on the server from the sessions themselves (see `reposOfRows`), so
   * the Repositories page and the board can never disagree about which deliveries belong where.
   */
  repos: string[]
}

export interface Bucket { key: string; sessions: number; tokens: number | null }

export interface TaskStats {
  models: Bucket[]
  harnesses: Bucket[]
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  agentRuns: number | null
  filesModified: number | null
  linesAdded: number | null
  linesRemoved: number | null
  commits: number | null
  toolErrors: number | null
  /** Null while the task is open — "still running" and "took N hours" are different sentences. */
  deliveryMs: number | null
  firstSessionAt: string | null
  lastSessionAt: string | null
}

export interface TaskSessionRow {
  id: string
  harness: string
  cwd: string
  attemptId: string | null
  /** The subtask it is filed under, or null for the delivery itself — never both. */
  subtaskId: string | null
  createdAt: string
  endedAt?: string
  label?: string
  conversationId?: string
  /**
   * A conversation filed on the board with NO session behind it (the fleet row was purged): its
   * numbers are real and it counts everywhere, but `id` (`hist:<conversationId>`) names nothing the
   * Sessions workspace can open — a surface must not link to `/sessions/<id>` for it.
   */
  historical?: boolean
  tokens: number | null
  costUSD: number | null
  rounds: number | null
}

export interface TaskComment {
  id: string; taskId: string; author: string; body: string; createdAt: string
}
export interface Subtask {
  id: string
  taskId: string
  title: string
  done: boolean
  status: TaskStatus
  createdAt: string
  updatedAt: string
  /** SUPERSEDED by `startedAt`/`deliveredAt` — kept only so old records round-trip; no UI sets it. */
  dueDate?: string
  startDate?: string
  /** System-stamped, never user-editable — mirror of the server's `Subtask.startedAt`. */
  startedAt?: string
  /** System-stamped, never user-editable — mirror of the server's `Subtask.deliveredAt`. */
  deliveredAt?: string
  sessionId?: string
  notes?: string
  /**
   * Sibling subtask ids, of the SAME task, that must be `done` before a session may file under
   * this one. See `task-attach.ts`'s `planAttach` — the rule lives on the server; this is the fact.
   */
  blockedBy?: string[]
  /**
   * SUPERSEDED by `isGroup`/`parentGroupId` — see docs/superpowers/specs/
   * 2026-09-11-alm-session-linking-ux.md §F, which replaces this §B "shared bucket" model (subtasks
   * sharing a `groupId` read as one rollup) with a real hierarchy level. Mirrored here only because
   * the server (`task-model.ts`'s `Subtask.groupId`) still writes it, for the same §B-era UI
   * compatibility reason — no current web code should read it for bucketing.
   */
  groupId?: string
  /**
   * A GROUP is a real hierarchy level (§F.1), not a label two subtasks share: a peer of a loose
   * subtask in the listing, and the only thing a session may be filed on inside this branch of the
   * tree — never one of its own members. Absent reads as "not a group". Mirror of the server's
   * `Subtask.isGroup` (`task-model.ts`).
   */
  isGroup?: boolean
  /**
   * The GROUP this subtask is a MEMBER of — the group's own subtask id, from the SAME task. A
   * member never receives a session of its own and therefore has no rollup bucket of its own
   * either (`SubtaskView.groupProgress` lives on the GROUP's own view, not the member's); it still
   * has its own `status`/dates/comments, and its `status` is what feeds the group's
   * `groupProgress`. Absent reads as "not a member". Mirror of the server's
   * `Subtask.parentGroupId` (`task-model.ts`).
   */
  parentGroupId?: string
  /**
   * A dormant session draft composed ahead of time on this subtask/group (t-918cc82233) — see
   * `@agentistics/core`'s `stagedSession.ts`. Absent means no draft. Mirror of the server's
   * `Subtask.stagedSession` (`task-model.ts`); never present on a group MEMBER
   * (`isGroupMember`/`parentGroupId` set) — the server refuses that write outright.
   */
  stagedSession?: StagedSessionDraft
}
export interface TaskFile {
  id: string; taskId: string; name: string; size: number
  kind?: string; author?: string; createdAt: string
}

/** One rollup for a subtask, or for the direct branch (`id: null`) — sessions filed on the task
 *  itself, under no subtask. Mirror of the server's `SubtaskView` (`task-report.ts`); see the
 *  2026-09-10 task-session-hierarchy spec §4.2/§4.3. */
export interface SubtaskView {
  id: string | null
  rollup: AttemptRollup
  /**
   * The same delivery-evidence numbers `TaskDetail.stats` carries for the whole task, re-partitioned
   * to this bucket's own rows. `null` when nothing is filed under this bucket yet — never a block
   * whose every field happens to be null. See
   * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §C.5.
   */
  stats: TaskStats | null
  /**
   * Present only when this bucket's `id` names a subtask GROUP (§F.1) — the group's own progress,
   * computed from its members' `done` flags (`groupProgress`, `@agentistics/core`), the same
   * round-down "no bar without anything to measure" rule `TaskProgress` already applies at the task
   * level, read one hierarchy level down. Absent for a loose subtask's bucket and for the direct
   * (`id: null`) one — neither has members to measure. Mirror of the server's
   * `SubtaskView.groupProgress` (`task-report.ts`).
   */
  groupProgress?: TaskProgress
}

export interface TaskDetail {
  task: TaskRecord
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
 * Three states, and an empty list is only ever ONE of them.
 *
 * `refused` is what a central (or a profile with no host power) answers — the board is a local
 * store and there is nothing there to show. Rendering that as "no tasks yet" would invite someone
 * to look for work that was never going to appear. Same rule the fleet already follows.
 */
export type TasksError = 'down' | 'refused' | null

/**
 * The page's filters, as `/api/tasks` takes them.
 *
 * Built from the SAME `Filters` the rest of the dashboard edits and resolved through the SAME
 * `getDateRangeFilter`, so "last 7 days" means one thing across the product. The day is the UTC one
 * (`toISOString().slice(0,10)`), matching `tagSessionDay` and the server's `sessionDay`.
 *
 * `all` with no custom dates sends no window at all rather than a window starting at the epoch —
 * an unbounded range is the absence of a filter, and saying so lets the server skip the walk.
 */
export function taskQuery(filters: Filters | undefined): string {
  if (!filters) return ''
  const p = new URLSearchParams()
  const unbounded = filters.dateRange === 'all' && !filters.customStart && !filters.customEnd
  if (!unbounded) {
    const { start, end } = getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)
    if (start.getTime() > 0) p.set('from', start.toISOString().slice(0, 10))
    p.set('to', end.toISOString().slice(0, 10))
  }
  if (filters.harnesses?.length) p.set('harnesses', filters.harnesses.join(','))
  else if (filters.harness) p.set('harnesses', filters.harness)
  if (filters.projects?.length) p.set('projects', filters.projects.join(','))
  // `repos: ['']` deliberately targets the "no linked repository" bucket, so presence matters more
  // than emptiness here.
  if (filters.repos !== undefined && filters.repos.length > 0) p.set('repos', filters.repos.join(','))
  const q = p.toString()
  return q ? `?${q}` : ''
}

export function useTaskList(filters?: Filters) {
  const [rows, setRows] = useState<TaskListRow[] | null>(null)
  const [overview, setOverview] = useState<BoardOverview | null>(null)
  /** Sessions the page's filters kept out of these numbers — stated, never swallowed. */
  const [excluded, setExcluded] = useState(0)
  const [error, setError] = useState<TasksError>(null)

  const q = useMemo(() => taskQuery(filters), [filters])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks${q}`)
      if (res.status === 403 || res.status === 404) { setError('refused'); setRows([]); return }
      if (!res.ok) { setError('down'); setRows([]); return }
      const body = await res.json() as {
        tasks: TaskListRow[]; overview: BoardOverview; excludedByFilter?: number
      }
      setError(null)
      setRows(body.tasks ?? [])
      setOverview(body.overview ?? null)
      setExcluded(body.excludedByFilter ?? 0)
    } catch {
      setError('down')
      setRows([])
    }
  }, [q])

  useEffect(() => { void load() }, [load])
  return { rows, overview, excluded, error, reload: load }
}

/**
 * The central's board: what each machine of this central chose to share.
 *
 * A DIFFERENT route from `useTaskList`, deliberately. `/api/tasks` is the local store — on a
 * central it answers `refused`, and it should keep doing so: there is no board on that machine.
 * This one reads team data through the team surface, is read-only, and groups by machine because a
 * board belongs to the person whose machine runs it.
 */
export function useCentralTasks(enabled: boolean) {
  const [machines, setMachines] = useState<CentralTaskMachine[] | null>(null)
  const [error, setError] = useState<TasksError>(null)

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      const res = await fetch('/api/team/tasks')
      if (res.status === 403 || res.status === 404) { setError('refused'); setMachines([]); return }
      if (!res.ok) { setError('down'); setMachines([]); return }
      const body = await res.json() as { machines: CentralTaskMachine[] }
      setError(null)
      setMachines(body.machines ?? [])
    } catch {
      setError('down')
      setMachines([])
    }
  }, [enabled])

  useEffect(() => { void load() }, [load])
  return { machines, error, reload: load }
}

export function useTaskDetail(ref: string | undefined, filters?: Filters) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<TasksError | 'missing'>(null)

  const load = useCallback(async () => {
    if (!ref) return
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}${taskQuery(filters)}`)
      if (res.status === 404) { setError('missing'); setDetail(null); return }
      if (res.status === 403) { setError('refused'); setDetail(null); return }
      if (!res.ok) { setError('down'); setDetail(null); return }
      const body = await res.json() as { task: TaskDetail }
      setError(null)
      setDetail(body.task)
    } catch {
      setError('down')
      setDetail(null)
    }
  }, [ref, JSON.stringify(filters ?? null)])

  useEffect(() => { void load() }, [load])
  return { detail, error, reload: load }
}

/**
 * A status write the server can refuse for a NAMED reason — same shape `attachSession` uses for
 * `blocked`. `done_needs_session` is `task-web.ts`'s refusal of a `done` with no session filed
 * under the task or subtask yet; the caller opens the matching dialog rather than reporting a bare
 * failure, so the rule reads as a question and not as a bug. `invalid_group`/`subtask_has_sessions`/
 * `group_field_conflict` are `patchSubtask`'s own refusals of a bad `parentGroupId` write (§F.1 of
 * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md) — see `checkParentGroup`
 * (`task-attach.ts`). A refusal with no `reason` is anything else (a bad ref, a network hiccup) —
 * nothing this shape names, so there is nothing to ask about.
 */
export type StatusRefusalReason =
  | 'done_needs_session' | 'invalid_group' | 'subtask_has_sessions' | 'group_field_conflict'
const STATUS_REFUSAL_REASONS: readonly StatusRefusalReason[] =
  ['done_needs_session', 'invalid_group', 'subtask_has_sessions', 'group_field_conflict']
export type StatusWriteResult = { ok: true } | { ok: false; reason?: StatusRefusalReason }

async function postStatus(path: string, body: unknown): Promise<StatusWriteResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return { ok: true }
    // A 422 is the server refusing a `blocked` with nothing to say, a `done` with no session
    // filed, or a group write it cannot honor — every one of them names a piece of work this
    // request cannot do YET. Read the body for WHICH one; anything else stays a bare refusal.
    if (res.status === 422) {
      const refused = await res.json().catch(() => null) as { message?: string } | null
      if (refused?.message && (STATUS_REFUSAL_REASONS as readonly string[]).includes(refused.message)) {
        return { ok: false, reason: refused.message as StatusRefusalReason }
      }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

export function markTask(
  ref: string,
  status: TaskStatus,
  o: { reason?: string; blockedBy?: string[]; actor?: string } = {},
): Promise<StatusWriteResult> {
  return postStatus(`/api/tasks/${encodeURIComponent(ref)}`, {
    status,
    ...(o.reason ? { reason: o.reason } : {}),
    ...(o.blockedBy ? { blockedBy: o.blockedBy } : {}),
    ...(o.actor ? { actor: o.actor } : {}),
  })
}

async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function createTask(title: string, detail?: string): Promise<TaskRecord | null> {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, detail }),
    })
    if (!res.ok) return null
    return (await res.json() as { task: TaskRecord }).task
  } catch {
    return null
  }
}

export interface TaskFieldPatch {
  title?: string
  detail?: string
  priority?: TaskPriorityId
  dueDate?: string
  startDate?: string
  labels?: string[]
  /**
   * Does this delivery travel to the centrals this machine is connected to?
   *
   * Absent reads as NOT shared on the server, and `false` here is a DECISION rather than an
   * absence — which is why the route tests it as a boolean instead of for truthiness.
   */
  shared?: boolean
  /** Who is making the change — it goes into the activity log. */
  actor?: string
}

/** An absent field is left alone; an EMPTY STRING clears it. Same rule as the server's. */
export const editTask = (ref: string, patch: TaskFieldPatch) =>
  post(`/api/tasks/${encodeURIComponent(ref)}`, patch)

export const addComment = (ref: string, author: string, body: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { author, body })

/**
 * Add a subtask — loose by default, or a GROUP (§F.1) when `isGroup` is true — and return its new
 * id, or `null` on failure. The id is what the group-forming gesture needs next: minting the group
 * is only step one of "create a group with…", which then joins both this row and the picked
 * sibling to it via `patchSubtask({ parentGroupId })`.
 */
export async function addSubtask(
  ref: string, title: string, o: { isGroup?: boolean } = {},
): Promise<string | null> {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, ...(o.isGroup ? { isGroup: true } : {}) }),
    })
    if (!res.ok) return null
    const body = await res.json().catch(() => null) as { id?: unknown } | null
    return typeof body?.id === 'string' ? body.id : null
  } catch {
    return null
  }
}

export const setSubtaskDone = (ref: string, id: string, done: boolean) =>
  postStatus(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { id, done })

export async function deleteTask(ref: string): Promise<boolean> {
  try {
    return (await fetch(`/api/tasks/${encodeURIComponent(ref)}`, { method: 'DELETE' })).ok
  } catch { return false }
}

/** The new file's ID, or `null` — a comment references its attachment by id, never by name. */
export async function uploadFile(ref: string, file: File, author?: string): Promise<string | null> {
  const form = new FormData()
  form.append('file', file)
  if (author) form.append('author', author)
  try {
    const r = await fetch(`/api/tasks/${encodeURIComponent(ref)}/files`, { method: 'POST', body: form })
    if (!r.ok) return null
    const body = await r.json() as { id?: unknown }
    return typeof body.id === 'string' ? body.id : null
  } catch { return null }
}

export async function deleteFile(fileId: string): Promise<boolean> {
  try {
    return (await fetch(`/api/task-files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })).ok
  } catch { return false }
}

export const fileUrl = (fileId: string) => `/api/task-files/${encodeURIComponent(fileId)}`

/**
 * A `TaskFile` reduced to the one thing `AttachmentLightbox` reads off a "path" — its extension,
 * off `attachmentKind()` — while still resolving back to the exact id `fileUrl` needs.
 *
 * The lightbox's own contract is a list of PATHS (it was built for the composer's attachment
 * chips, which really are paths); a task file is keyed by an opaque id with no extension of its
 * own, so a bare id would always read as `attachmentKind === 'other'` and fall into the broken
 * `<img>` branch. `id/name` keeps the name's extension where `attachmentKind` looks for it (the
 * LAST path segment) while the id stays the first — `fileIdFromLightboxPath` reads it back.
 */
export function fileLightboxPath(f: Pick<TaskFile, 'id' | 'name'>): string {
  return `${f.id}/${f.name}`
}

/** The inverse of `fileLightboxPath` — the id half, for `fileUrl`. */
export function fileIdFromLightboxPath(path: string): string {
  const i = path.indexOf('/')
  return i === -1 ? path : path.slice(0, i)
}

/** Hours and days, from ms. Null in, null out — an open task has no duration. */
export function fmtDuration(ms: number | null): string | null {
  if (ms === null) return null
  const h = ms / 3_600_000
  if (h < 1) return `${Math.round(ms / 60_000)} min`
  if (h < 48) return `${h.toFixed(1)} h`
  return `${(h / 24).toFixed(1)} d`
}

export const setBlockedBy = (ref: string, blockedBy: string[]) =>
  post(`/api/tasks/${encodeURIComponent(ref)}`, { blockedBy })

export const addLink = (ref: string, url: string, label?: string, kind?: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/links`, { url, label, kind })

export const removeLink = (ref: string, remove: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/links`, { remove })

/**
 * File a session under a delivery, or under one of its subtasks.
 *
 * Passing `subtaskId` MOVES it there; passing none moves it back to the delivery itself. A session
 * is filed under one or the other and never both — the rule lives in the server's `task-attach.ts`,
 * and this client only ever states a target.
 */
export type AttachRefusalReason =
  | 'no_such_task' | 'no_such_session' | 'no_such_subtask' | 'needs_subtask' | 'wrong_delivery'
  | 'blocked'
  /**
   * §F.1: the target is a group MEMBER (`Subtask.parentGroupId` set) — only the group itself may
   * hold a session (`task-attach.ts`'s `planAttach`). File on the group's own id instead.
   */
  | 'subtask_in_group'
  // This function's own addition — the server can never say a request never reached it.
  | 'network'

export type AttachResult =
  | { ok: true }
  | {
    ok: false
    reason: AttachRefusalReason
    /** Set only for `reason: 'blocked'` — the subtask ids still open. */
    blockedBy?: string[]
  }

/**
 * File a session under a delivery's subtask — the STRUCTURED answer, not just a boolean.
 *
 * `post()` (below) collapses every outcome to `ok`/`not ok`, which is the right shape for a plain
 * write and the wrong one here: a REFUSED attach carries WHY, and `reason: 'blocked'` carries WHICH
 * subtasks are still open, so a caller can open `BlockedSubtaskResolve` instead of reporting a bare
 * failure. `network` is this function's own addition for a request that never reached the server —
 * the server can never say that about itself.
 */
export async function attachSession(ref: string, sessionId: string, subtaskId?: string): Promise<AttachResult> {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subtaskId ? { sessionId, subtaskId } : { sessionId }),
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null) as { reason?: string; blockedBy?: string[] } | null
    return {
      ok: false,
      reason: (body?.reason as AttachRefusalReason | undefined) ?? 'no_such_task',
      ...(body?.blockedBy ? { blockedBy: body.blockedBy } : {}),
    }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

export const detachSession = (ref: string, detach: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/sessions`, { detach })

export const editComment = (ref: string, id: string, body: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { id, body })

export const removeComment = (ref: string, id: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { id, remove: true })

/**
 * A subtask patch, plus the one field `Partial<Subtask>` cannot express: `parentGroupId` is
 * `string | undefined` on the record itself (absent = "leave it alone" everywhere else in this
 * app), but joining/leaving a group (§F.1) needs a THIRD state — `null` CLEARS it (leave the
 * group) — so it is typed apart rather than folded into `Partial<Pick<Subtask, …>>`.
 */
export type SubtaskPatch = Partial<Pick<Subtask,
  'title' | 'status' | 'dueDate' | 'startDate' | 'sessionId' | 'notes' | 'blockedBy'
>> & {
  /** Join (a group's own subtask id) or leave (`null`) a group — see `checkParentGroup`
   *  (`task-attach.ts`). Absent leaves membership alone. */
  parentGroupId?: string | null
}

export const patchSubtask = (ref: string, id: string, patch: SubtaskPatch) =>
  postStatus(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { id, ...patch })

export const removeSubtask = (ref: string, id: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { id, remove: true })

/**
 * Save (or replace) a subtask/group's staged session draft (t-918cc82233).
 *
 * A structured result, not a bare boolean: the one refusal worth naming is `subtask_in_group` — the
 * target is a group MEMBER, which can never hold a session and therefore never a draft either (see
 * `task-attach.ts`'s identical refusal for filing a real one). The UI should never actually reach
 * this for a member row (the compose control is withheld there), so this is defence in depth.
 */
export type StagedSessionWriteResult = { ok: true } | { ok: false; reason?: 'subtask_in_group' }

export async function saveStagedSession(
  ref: string, subtaskId: string, draft: StagedSessionDraft,
): Promise<StagedSessionWriteResult> {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: subtaskId, stagedSession: draft }),
    })
    if (res.ok) return { ok: true }
    if (res.status === 422) {
      const body = await res.json().catch(() => null) as { message?: string } | null
      if (body?.message === 'subtask_in_group') return { ok: false, reason: 'subtask_in_group' }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

/** Discard a subtask/group's staged draft, keeping the subtask itself untouched. */
export const clearStagedSession = (ref: string, subtaskId: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { id: subtaskId, stagedSession: null })

/**
 * Turn a staged draft's `attachmentIds` (TaskFile ids) into real local paths the new session can be
 * pointed at — the same `/api/fleet/attach` store the ordinary composer uses, so a freshly spawned
 * session reads these exactly as it would read anything else attached through the chat.
 *
 * One attachment that cannot be read (deleted since the draft was composed, a transient network
 * error) is SKIPPED rather than failing the whole fire — a session started with N-1 of N attachments
 * is still the session that was asked for; one started with none because of a single bad file is not.
 */
export async function materializeStagedAttachments(
  lang: 'pt' | 'en', attachmentIds: readonly string[], files: readonly TaskFile[],
): Promise<string[]> {
  const paths: string[] = []
  for (const fileId of attachmentIds) {
    const meta = files.find(f => f.id === fileId)
    if (!meta) continue
    try {
      const got = await fetch(fileUrl(fileId))
      if (!got.ok) continue
      const blob = await got.blob()
      const form = new FormData()
      form.append('file', new File([blob], meta.name))
      const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body: form })
      if (!res.ok) continue
      const body = await res.json() as { ok: boolean; path?: string }
      if (body.ok && body.path) paths.push(body.path)
    } catch {
      // One bad attachment must not sink the rest — see this function's own note.
    }
  }
  return paths
}

/**
 * TAKE a task, or give it back.
 *
 * A LEASE, not a lock: it expires on its own, so a browser tab closed mid-task does not hold work
 * forever. A refusal comes back `ok: false` naming the holder — rendered as a sentence, never as a
 * silent no-op.
 */
export async function claimTask(ref: string, o: {
  by: string
  release?: boolean
  sessionId?: string
  takeover?: boolean
  force?: boolean
  leaseMs?: number
}): Promise<{ ok: boolean; reason?: string; heldBy?: string; until?: string }> {
  try {
    const r = await fetch(`/api/tasks/${encodeURIComponent(ref)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(o),
    })
    return await r.json() as { ok: boolean; reason?: string; heldBy?: string; until?: string }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

/** Drop a card at `index` within the column it is being dropped into. Status is `markTask`'s job. */
export const moveTask = (ref: string, index: number, actor?: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/move`, { index, ...(actor ? { actor } : {}) })

/** The activity log, newest first. No `ref` = the whole board. */
export function useTaskActivity(ref?: string, limit = 60) {
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    const q = new URLSearchParams()
    if (ref) q.set('task', ref)
    q.set('limit', String(limit))
    try {
      const r = await fetch(`/api/tasks/activity?${q}`)
      const body = await r.json() as { events?: TaskEvent[] }
      setEvents(body.events ?? [])
    } catch {
      // An unreachable server keeps the last log rather than reporting an empty one — the same
      // rule the fleet poller follows. "Nothing happened" and "nobody answered" are different.
    } finally {
      setLoading(false)
    }
  }, [ref, limit])
  useEffect(() => { void reload() }, [reload])
  return { events, loading, reload }
}

export interface NextReply {
  ready: Array<{ task: TaskRecord; position: number }>
  withheld: Array<{ id: string; title: string; why: string; detail?: string }>
  progress: {
    total: number
    done: number
    abandoned: number
    open: number
    blocked: number
    claimed: number
    ready: number
    settled: boolean
  }
}

/** What can be picked up right now, why the rest cannot, and whether the board is settled. */
export function useNextTasks(actor?: string, intervalMs = 15000) {
  const [next, setNext] = useState<NextReply | null>(null)
  const reload = useCallback(async () => {
    const q = new URLSearchParams()
    if (actor) q.set('actor', actor)
    try {
      const r = await fetch(`/api/tasks/next?${q}`)
      setNext(await r.json() as NextReply)
    } catch { /* keep the last answer — see `useTaskActivity` */ }
  }, [actor])
  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), intervalMs)
    return () => clearInterval(t)
  }, [reload, intervalMs])
  return { next, reload }
}

// ------------------------------------------------------------------- status vocabulary (§ Statuses)

/**
 * One entry of the board's status LIST — see `@agentistics/core`'s `TaskStatusDef` and
 * `task-web.ts`'s `TaskStatusRow` on the server, which this mirrors. `usageCount` is what lets the
 * management UI grey out a delete control and say "in use by N" without a failed round-trip first.
 */
export interface TaskStatusRow {
  id: string
  label: string
  color: string
  protected: boolean
  order: number
  usageCount: number
}

export type StatusDeleteRefusal = 'protected' | 'in_use' | 'no_such_status'

async function readStatusesReply(res: Response): Promise<TaskStatusRow[]> {
  const body = await res.json().catch(() => null) as { statuses?: TaskStatusRow[] } | null
  return body?.statuses ?? []
}

/** Every status this board currently has, left to right. */
export async function fetchTaskStatuses(): Promise<TaskStatusRow[]> {
  try {
    const res = await fetch('/api/tasks/statuses')
    if (!res.ok) return []
    return await readStatusesReply(res)
  } catch {
    return []
  }
}

/**
 * The board's LIVE status list, for every surface that renders a column, a pill or a picker off it
 * — the one fetch every one of them shares rather than each rolling its own. `null` means "still
 * loading" (the first render, or a failed fetch): every consumer must treat that as "show a sane
 * fallback", never as "there are no statuses" — see `board.ts`'s `statusStyle`/`liveStatusOrder`,
 * which fall back to the fixed legacy vocabulary while this is `null`.
 *
 * A failed fetch keeps whatever was last loaded rather than clearing it back to `null` — the same
 * rule `useTaskActivity` follows: "nothing changed" and "nobody answered" are different, and a
 * board that blanks its columns because one poll dropped would be worse than one showing a stale
 * list for a few seconds.
 */
export function useTaskStatuses() {
  const [statuses, setStatuses] = useState<TaskStatusRow[] | null>(null)
  const reload = useCallback(async () => {
    const list = await fetchTaskStatuses()
    if (list.length > 0) setStatuses(sortTaskStatuses(list) as TaskStatusRow[])
    // An empty reply from a reachable server ("no statuses at all") cannot happen — the board always
    // seeds the four protected ones — so an empty list here is treated as a failed read, not a real
    // answer, and the previous list (or `null` on the very first load) is kept.
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { statuses, reload }
}

/** Create a new, non-protected status. The id is DERIVED server-side from the label — never chosen
 *  by the caller, so two people typing the same label cannot collide on an id neither of them typed. */
export async function createTaskStatus(label: string, color: string): Promise<
  { ok: true; status: TaskStatusRow } | { ok: false; message?: string }
> {
  try {
    const res = await fetch('/api/tasks/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, color }),
    })
    const body = await res.json().catch(() => ({})) as { status?: TaskStatusRow; message?: string }
    if (!res.ok || !body.status) return { ok: false, ...(body.message ? { message: body.message } : {}) }
    return { ok: true, status: { ...body.status, usageCount: 0 } }
  } catch {
    return { ok: false }
  }
}

/** Edit a status's label and/or color — works on a protected one too; only its `id` never changes. */
export async function editTaskStatus(
  id: string, patch: { label?: string; color?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks/statuses/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Delete a status. Refused (422) with a NAMED reason — `protected` (todo/in_progress/blocked/done,
 * regardless of usage) or `in_use` (any other status still referenced by at least one task or
 * subtask) — which the caller renders as a sentence rather than a bare failure, the same shape
 * `StatusRefusalReason` already uses for a status MOVE.
 */
export async function deleteTaskStatus(id: string): Promise<
  { ok: true } | { ok: false; message?: StatusDeleteRefusal; usageCount?: number }
> {
  try {
    const res = await fetch(`/api/tasks/statuses/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => ({})) as { message?: StatusDeleteRefusal; usageCount?: number }
    return { ok: false, ...(body.message ? { message: body.message } : {}), ...(body.usageCount !== undefined ? { usageCount: body.usageCount } : {}) }
  } catch {
    return { ok: false }
  }
}
