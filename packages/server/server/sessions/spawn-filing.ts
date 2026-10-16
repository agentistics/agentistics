/**
 * spawn-filing.ts — PURE: where a new session is FILED, decided once for every spawn site.
 *
 * The CLI (`session start`/`batch`) and the web/VS Code path (`spawnSession`) were two
 * implementations of one gesture and only the second filed anything: `--task t-…` became a free-text
 * NAME matching no title, `--subtask` reached the briefing and never the row, and the folder was
 * whatever the caller remembered to pass. The session's briefing said "you are on task X / subtask
 * Y" while the board said nobody was. This module is the one answer all three sites ask, BEFORE the
 * memory gate, so a refusal spawns nothing (spec `docs/superpowers/specs/2026-10-16-spawn-atomic.md`
 * § 2.1). It takes everything it needs as input — the board, the registry, the folders, and two
 * injected probes (`repoOf`, `liveInCwd`) — and touches no file, no process and no clock.
 *
 * The rules, each pinned by `spawn-filing.test.ts`:
 *  1. A reference that resolves to NOTHING is refused, never kept as a name; two exact matches are
 *     ambiguous; a subtask with no task is resolved board-wide; a group MEMBER is filed on its GROUP
 *     (a member can never hold a session — `planAttach`'s `subtask_in_group`).
 *  2. The plan carries the task's REAL title, for the row's `task` field.
 *  3. cwd: explicit, else the caller's — for a worker on a task with a `repo`, only when that cwd's
 *     repository is the task's; never guessed, the refusal lists known checkouts of the right one.
 *  4. A worker in a repository's MAIN checkout while another session is live there is refused —
 *     the shared-checkout corruption CLAUDE.md § "Concurrent work" records. `sharedCwd` overrides.
 *     Leaders are exempt from 3 and 4: their home (the workspace) is not a repository.
 *  5. Folder: explicit > the predecessor's (hand-off) > where the task's work already is (newest
 *     session of the same subtask, else of the task, skipping finished folders) > the caller's own
 *     folder when the caller is on the same task > none, with a warning. Nothing is stored on the
 *     task: moving sessions moves the default.
 *  6. A hand-off is always a leader and inherits the predecessor's cwd, filing and folder.
 *
 * Harness-agnostic by construction: nothing here reads a harness.
 */

import {
  groupOfSession, normalizeGitRemote, repoShortName, resolveFolderRef, sessionIdentityKey,
  type SessionUserGroup, type SessionUserGroupsValue,
} from '@agentistics/core'
import type { Subtask, Task, TaskBook } from './task-model'
import type { ManagedSession } from './types'
import { isFinishedFolder } from './finished-folder'

/**
 * What the injected `repoOf` says about a directory — a structural subset of `ResolvedRepoFacts`
 * (`repo-facts.ts`), so the memoized resolver plugs in as is.
 *
 * `null` or `missing: true` = the directory does not exist. `remote` (a `normalizeGitRemote` key)
 * and/or `repo` (its `org/repo` short form) name the repository; neither = not in a repository.
 * `worktree` is true only for a LINKED worktree — a main checkout is not one.
 */
export interface FilingRepo {
  remote?: string
  repo?: string
  worktree: boolean
  missing?: boolean
}

export interface FilingInput {
  role: 'worker' | 'leader'
  /** Task id or exact title. */
  taskRef?: string
  /** Subtask id or exact title. */
  subtaskRef?: string
  /** Explicit `--folder`: id, exact name or "Parent/Child". */
  folderRef?: string
  /** Explicit `--cwd`, already absolute. */
  cwd?: string
  /** `--shared-cwd`: allow a main checkout another live session already works in. */
  sharedCwd?: boolean
  /** The caller's cwd, absolute. */
  callerCwd: string
  /** The calling session's row, when a session is the caller — for the `parent` folder. */
  caller?: ManagedSession
  /** The predecessor, for a leader hand-off. */
  handoffOf?: ManagedSession
  book: Pick<TaskBook, 'tasks' | 'subtasks'>
  /** The registry — where the task's work already sits, and known checkouts. */
  rows: readonly ManagedSession[]
  groups: SessionUserGroupsValue
  repoOf: (dir: string) => FilingRepo | null
  /**
   * Running sessions already in that directory, NOT counting `excludeId` — the planner passes the
   * calling session's own id, so a worker spawning from the main checkout it lives in is not refused
   * for sharing it with itself.
   *
   * Path contract: every path the planner receives (`cwd`, `callerCwd`, the predecessor's and the
   * rows') is expected absolute and canonical (realpath'd) by the CALLER; the planner only trims
   * trailing separators when it compares or lists checkouts.
   */
  liveInCwd: (dir: string, excludeId?: string) => number
  /** Optional extra checkouts/worktrees of a repository, keyed by its short `org/repo` (lowercase). */
  checkoutsOf?: (repoKey: string) => readonly string[]
}

export type FolderSource = 'explicit' | 'predecessor' | 'task' | 'parent' | 'none'
export type CwdSource = 'explicit' | 'caller' | 'predecessor'

/** Codes, not sentences: the surfaces (CLI, route) render them in the reader's language. */
export type FilingWarning = 'no_folder' | 'subtask_member_filed_on_group' | 'shared_checkout_override'

export type FilingRefusal =
  | 'no_such_task' | 'ambiguous_task'
  | 'no_such_subtask' | 'ambiguous_subtask' | 'subtask_needs_task'
  | 'no_such_folder' | 'ambiguous_folder'
  | 'cwd_missing' | 'cwd_wrong_repo' | 'cwd_needed' | 'cwd_shared_checkout'

export type FilingPlan = {
  ok: true
  taskId?: string
  /** The task's real title — what the row's `task` field carries. */
  taskTitle?: string
  /** Already redirected from a group member to its group. */
  subtaskId?: string
  /** Set when `subtaskRef` named a group member and the session is filed on its group. */
  memberOf?: { member: string; group: string }
  folderId?: string
  /** "Parent/Child" or the bare name, for output. */
  folderPath?: string
  folderSource: FolderSource
  cwd: string
  cwdSource: CwdSource
  role: 'worker' | 'leader'
  warnings: FilingWarning[]
} | { ok: false; code: FilingRefusal; detail: string; candidates?: string[] }

type Refusal = Extract<FilingPlan, { ok: false }>

const refuse = (code: FilingRefusal, detail: string, candidates?: string[]): Refusal =>
  ({ ok: false, code, detail, ...(candidates ? { candidates } : {}) })

const MAX_CANDIDATES = 5
const label = (x: { id: string; title: string }) => `${x.title} (${x.id})`
const clean = (s: string | undefined): string | undefined => {
  const t = s?.trim()
  return t ? t : undefined
}

// ── references ──────────────────────────────────────────────────────────────────────────────────

/** The closest titles to a reference nobody matched: case-insensitive containment either way. */
function closest<T extends { id: string; title: string }>(items: readonly T[], ref: string): string[] {
  const needle = ref.toLowerCase()
  return items
    .filter(i => { const t = i.title.trim().toLowerCase(); return t !== '' && (t.includes(needle) || needle.includes(t)) })
    .slice(0, MAX_CANDIDATES)
    .map(label)
}

type Pick1<T> = { ok: true; item: T } | { ok: false; matches: T[] }

/** By id, then by exact (trimmed) title; several exact titles come back as `matches`. */
function byIdOrTitle<T extends { id: string; title: string }>(items: readonly T[], ref: string): Pick1<T> {
  const byId = items.find(i => i.id === ref)
  if (byId) return { ok: true, item: byId }
  const hits = items.filter(i => i.title.trim() === ref)
  return hits.length === 1 ? { ok: true, item: hits[0]! } : { ok: false, matches: hits }
}

interface Filing { task?: Task; subtask?: Subtask; memberOf?: { member: string; group: string } }

function resolveFiling(input: FilingInput, taskRef: string | undefined, subtaskRef: string | undefined): Filing | Refusal {
  const { tasks, subtasks } = input.book
  let task: Task | undefined
  if (taskRef !== undefined) {
    const r = byIdOrTitle(tasks, taskRef)
    if (!r.ok) {
      return r.matches.length > 1
        ? refuse('ambiguous_task', `"${taskRef}" names ${r.matches.length} tasks — use the id`, r.matches.map(label))
        : refuse('no_such_task', `no task has the id or exact title "${taskRef}"`, closest(tasks, taskRef))
    }
    task = r.item
  }
  if (subtaskRef === undefined) return task ? { task } : {}

  let sub: Subtask
  if (task) {
    const taskId = task.id
    const own = subtasks.filter(s => s.taskId === taskId)
    const r = byIdOrTitle(own, subtaskRef)
    if (!r.ok) {
      return r.matches.length > 1
        ? refuse('ambiguous_subtask', `"${subtaskRef}" names ${r.matches.length} subtasks of ${task.id} — use the id`, r.matches.map(label))
        : refuse('no_such_subtask', `task ${task.id} has no subtask with the id or exact title "${subtaskRef}"`, own.slice(0, 10).map(label))
    }
    sub = r.item
  } else {
    const r = byIdOrTitle(subtasks, subtaskRef)
    if (!r.ok) {
      return r.matches.length > 1
        ? refuse('ambiguous_subtask', `"${subtaskRef}" names ${r.matches.length} subtasks — pass --task or the id`, r.matches.map(label))
        : refuse('no_such_subtask', `no subtask has the id or exact title "${subtaskRef}"`, closest(subtasks, subtaskRef))
    }
    sub = r.item
    task = tasks.find(t => t.id === sub.taskId)
    if (!task) return refuse('subtask_needs_task', `subtask ${sub.id} belongs to task ${sub.taskId}, which is not on the board`)
  }
  // A group MEMBER can never hold a session: file on its group, and say so.
  if (sub.parentGroupId) {
    const group = subtasks.find(s => s.id === sub.parentGroupId)
    if (group) return { task, subtask: group, memberOf: { member: sub.id, group: group.id } }
  }
  return { task, subtask: sub }
}

// ── repository ──────────────────────────────────────────────────────────────────────────────────

/** What identifies a repository: its short `org/repo` (lowercase) and, when a REMOTE said it, the host too. */
interface RepoId { short: string; full?: string }

function repoId(remote: string | undefined): RepoId | undefined {
  if (!remote) return undefined
  const full = (normalizeGitRemote(remote) || remote).toLowerCase()
  const short = repoShortName(full).toLowerCase()
  if (!short) return undefined
  return { short, ...(full !== short ? { full } : {}) }
}
/** `repo` is ALREADY the short form — normalizing it would read its org as a host. */
const idOfFacts = (f: FilingRepo | null | undefined): RepoId | undefined => {
  if (!f) return undefined
  const fromRemote = repoId(f.remote)
  if (fromRemote) return fromRemote
  const short = f.repo?.trim().toLowerCase()
  return short ? { short } : undefined
}
/** The short key, for the `checkoutsOf` probe and for "is this in any repository at all". */
const keyOfFacts = (f: FilingRepo | null | undefined): string | undefined => idOfFacts(f)?.short
const exists = (f: FilingRepo | null): f is FilingRepo => f !== null && !f.missing

/**
 * Whether a directory's repository IS the task's. Hosts are compared when BOTH sides carry one
 * (github.com/o/r is not gitlab.com/o/r); a host-less side (`ResolvedRepoFacts.repo`) falls back to
 * `org/repo`. A repository with no remote is only its folder name — one segment — and is accepted
 * when that is the task repo's last segment.
 */
function sameRepo(facts: FilingRepo, want: RepoId): boolean {
  const have = idOfFacts(facts)
  if (!have) return false
  if (have.full && want.full) return have.full === want.full
  if (have.short === want.short) return true
  return !facts.remote && !have.short.includes('/') && have.short === want.short.split('/').pop()
}

const trimSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
const msOf = (iso: string | undefined): number => { const n = Date.parse(iso ?? ''); return Number.isNaN(n) ? -Infinity : n }

/** Known places this repository is checked out: injected list, then EXISTING registry rows newest first. */
function checkoutsFor(input: FilingInput, want: RepoId): string[] {
  const out = new Set<string>((input.checkoutsOf?.(want.short) ?? []).map(trimSep))
  const rows = [...input.rows].sort((a, b) => msOf(b.createdAt) - msOf(a.createdAt))
  for (const r of rows) {
    const dir = trimSep(r.cwd)
    if (out.has(dir)) continue
    const live = input.repoOf(dir)
    if (!exists(live)) continue
    if (sameRepo(live, want) || (r.repo && sameRepo(r.repo, want))) out.add(dir)
  }
  return [...out].slice(0, 10)
}

function resolveCwd(input: FilingInput, role: 'worker' | 'leader', task: Task | undefined): { cwd: string; source: CwdSource; shared?: true } | Refusal {
  const explicit = clean(input.cwd)
  const fromPred = !explicit && input.handoffOf ? input.handoffOf.cwd : undefined
  const cwd = explicit ?? fromPred ?? input.callerCwd
  const source: CwdSource = explicit ? 'explicit' : fromPred ? 'predecessor' : 'caller'
  const facts = input.repoOf(cwd)
  if (!exists(facts)) return refuse('cwd_missing', `the directory ${cwd} does not exist`)
  if (role === 'leader') return { cwd, source }

  const want = repoId(task?.repo)
  if (want && !sameRepo(facts, want)) {
    const candidates = checkoutsFor(input, want)
    return source === 'explicit'
      ? refuse('cwd_wrong_repo', `${cwd} is not a checkout of ${task!.repo} (task ${task!.id}) — pass --cwd with one of its worktrees`, candidates)
      : refuse('cwd_needed', `task ${task!.id} belongs to ${task!.repo} and ${cwd} is outside it — pass --cwd with one of its worktrees`, candidates)
  }
  const inRepo = keyOfFacts(facts) !== undefined
  if (inRepo && !facts.worktree && input.liveInCwd(cwd, input.caller?.id) >= 1) {
    if (!input.sharedCwd) {
      return refuse('cwd_shared_checkout',
        `${cwd} is a main checkout another live session already works in — use a worktree (git worktree add .claude/worktrees/<name> -b <branch>) or pass --shared-cwd`)
    }
    return { cwd, source, shared: true }
  }
  return { cwd, source }
}

// ── folder ──────────────────────────────────────────────────────────────────────────────────────

const folderOf = (groups: SessionUserGroupsValue, row: ManagedSession): SessionUserGroup | undefined => {
  const g = groupOfSession(groups, sessionIdentityKey(row))
  return g && !isFinishedFolder(groups, g) ? g : undefined
}

/** The folder of the newest row matching `pick`, skipping rows in no folder or a finished one. */
function newestFolder(input: FilingInput, pick: (r: ManagedSession) => boolean): SessionUserGroup | undefined {
  const rows = input.rows.filter(pick).sort((a, b) => msOf(b.createdAt) - msOf(a.createdAt))
  for (const r of rows) {
    const g = folderOf(input.groups, r)
    if (g) return g
  }
  return undefined
}

function resolveFolder(input: FilingInput, filing: Filing): { group?: SessionUserGroup; path?: string; source: FolderSource } | Refusal {
  const ref = clean(input.folderRef)
  if (ref !== undefined) {
    const r = resolveFolderRef(input.groups, ref)
    if (!r.ok) {
      return r.code === 'ambiguous_group'
        ? refuse('ambiguous_folder', `"${ref}" names ${r.matches.length} folders — use the id`, r.matches)
        : refuse('no_such_folder', `no folder has the id, name or path "${ref}"`)
    }
    return { group: r.group, path: r.path, source: 'explicit' }
  }
  if (input.handoffOf) {
    const g = folderOf(input.groups, input.handoffOf)
    if (g) return { group: g, source: 'predecessor' }
  }
  const taskId = filing.task?.id
  if (taskId) {
    const subId = filing.subtask?.id
    const g = (subId ? newestFolder(input, r => r.taskId === taskId && r.subtaskId === subId) : undefined)
      ?? newestFolder(input, r => r.taskId === taskId)
    if (g) return { group: g, source: 'task' }
    if (input.caller && input.caller.taskId === taskId) {
      const c = folderOf(input.groups, input.caller)
      if (c) return { group: c, source: 'parent' }
    }
  }
  return { source: 'none' }
}

const pathOf = (groups: SessionUserGroupsValue, g: SessionUserGroup): string => {
  const parent = g.parentId ? groups.groups.find(p => p.id === g.parentId) : undefined
  return parent ? `${parent.name.trim()}/${g.name.trim()}` : g.name.trim()
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────

/** A refusal about a ref the caller never typed says where it came from, so the fix is obvious. */
function fromPredecessor(r: Refusal, pred: ManagedSession | undefined, task: boolean, sub: boolean): Refusal {
  if (!pred) return r
  const taskCode = r.code === 'no_such_task' || r.code === 'ambiguous_task'
  const subCode = r.code === 'no_such_subtask' || r.code === 'ambiguous_subtask' || r.code === 'subtask_needs_task'
  if ((taskCode && task) || (subCode && sub)) {
    return { ...r, detail: `${r.detail} (inherited from the predecessor ${pred.id}; pass --task${sub ? ' and --subtask' : ''} to file elsewhere)` }
  }
  return r
}

export function planFiling(input: FilingInput): FilingPlan {
  const pred = input.handoffOf
  const role: 'worker' | 'leader' = pred ? 'leader' : input.role
  const explicitTask = clean(input.taskRef)
  const explicitSub = clean(input.subtaskRef)
  // A hand-off inherits the predecessor's filing unless one was named outright. A SUBTASK named
  // alone still inherits the predecessor's task, so it resolves inside it rather than board-wide
  // (where a title like "Planner" is on several tasks and refuses as ambiguous).
  const inheritedTask = !explicitTask && pred ? clean(pred.taskId) : undefined
  const inheritedSub = !explicitSub && !explicitTask && pred ? clean(pred.subtaskId) : undefined
  const taskRef = explicitTask ?? inheritedTask
  const subtaskRef = explicitSub ?? inheritedSub

  let filing = resolveFiling(input, taskRef, subtaskRef)
  // The predecessor's task is gone but a subtask was named: resolve that board-wide instead.
  if ('ok' in filing && filing.code === 'no_such_task' && inheritedTask && explicitSub) {
    filing = resolveFiling(input, undefined, subtaskRef)
  }
  if ('ok' in filing) return fromPredecessor(filing, pred, inheritedTask !== undefined, inheritedSub !== undefined)

  const cwd = resolveCwd(input, role, filing.task)
  if ('ok' in cwd) return cwd

  const folder = resolveFolder(input, filing)
  if ('ok' in folder) return folder

  const warnings: FilingWarning[] = []
  if (filing.memberOf) warnings.push('subtask_member_filed_on_group')
  if (cwd.shared) warnings.push('shared_checkout_override')
  if (folder.source === 'none') warnings.push('no_folder')

  return {
    ok: true,
    ...(filing.task ? { taskId: filing.task.id, taskTitle: filing.task.title } : {}),
    ...(filing.subtask ? { subtaskId: filing.subtask.id } : {}),
    ...(filing.memberOf ? { memberOf: filing.memberOf } : {}),
    ...(folder.group ? { folderId: folder.group.id, folderPath: folder.path ?? pathOf(input.groups, folder.group) } : {}),
    folderSource: folder.source,
    cwd: cwd.cwd,
    cwdSource: cwd.source,
    role,
    warnings,
  }
}
