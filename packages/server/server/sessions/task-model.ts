/**
 * task-model.ts — what a Task and an Attempt ARE. Pure: no clock, no filesystem.
 *
 * Three levels, and the middle one is not optional. A Task is the work ("landing page for a
 * pizzeria"); an Attempt is one CONFIGURATION of that work ("opus, prompt only"); the sessions hang
 * off the attempt. Without the middle level, running one task under four configurations produces
 * one task holding a dozen unattributed sessions and nothing is comparable, which is the whole
 * point of the feature.
 *
 * See docs/superpowers/specs/2026-09-05-task-measurement-design.md.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PRIORITY_ORDER, type TaskPriorityId, type TaskStatusDef } from '@agentistics/core'
import type { HarnessId, StagedSessionDraft } from '@agentistics/core'

/**
 * Where the work stands.
 *
 * This USED TO BE a closed seven-value union (`backlog | todo | in_progress | blocked | in_review |
 * done | abandoned`). A product owner asked for the status list itself to be editable — new
 * statuses, renamed labels, chosen colours, deletion of the ones nobody uses — so it is now a plain
 * `string`, validated at WRITE time (`markTask` / `patchSubtask`, below and in `task-web.ts`)
 * against the board's own `TaskBook.statuses` list rather than against a type the compiler can
 * check. See `@agentistics/core`'s `taskStatus.ts` for the list itself, its migration, and the four
 * ids (`PROTECTED_STATUS_IDS`) several rules in THIS file still compare against by exact string:
 *
 *  `todo`        — queued, nothing started. PROTECTED.
 *  `in_progress` — something is running or a session has touched it. PROTECTED.
 *  `blocked`     — it CANNOT proceed. Distinct from `todo` on purpose: "nobody picked it up" and
 *                  "somebody tried and cannot" are different facts, and only the second is a
 *                  problem to go and solve. PROTECTED.
 *  `done`        — DELIVERED. This is the state that closes rounds-to-delivery and stamps
 *                  `deliveredAt`; there is exactly one, so the metric cannot be ambiguous. PROTECTED.
 *
 * `backlog`, `in_review` and `abandoned` are the three words this board also shipped with — kept
 * working as ordinary, ordinary NON-protected statuses (a machine already using one of them keeps
 * using it; see `planStatusMigration`), and everything past those seven is whatever a person has
 * since typed into the status editor.
 */
export type TaskStatus = string

/**
 * The seven words this board shipped with before the list became editable — used ONLY by
 * `migrateStatus` and by tests asserting the pure rules below still hold for every one of them.
 * Never treat this as "the current valid statuses": read `TaskBook.statuses` for that.
 */
export const TASK_STATUSES: readonly TaskStatus[] =
  ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned'] as const

/**
 * The two words this board used before it had seven, then before the list became editable.
 *
 * Read-migration only, and deliberately not a rename in the file: an `open` written by an older
 * build must keep meaning what it meant, and `delivered` IS `done` — the metric that closes on it
 * may not shift because the vocabulary grew.
 *
 * It no longer validates against a closed set — the status vocabulary is a dynamic list now
 * (`TaskBook.statuses`), and deciding "is this a real status" needs that whole list in scope, which
 * a per-record disk-read sanitizer (`task-store.ts`'s `sanitizeTask` / `sanitizeSubtask`) does not
 * have; that check moved to the point of decision, at WRITE time (`markTask` / `patchSubtask`). This
 * function's job shrank to "repair the two legacy WORDS, and refuse anything that is not a usable
 * string" — an id it lets through and that turns out not to name a real status is a fact the record
 * carries (a task pointing at a status since deleted), not something this function can fix.
 */
export function migrateStatus(raw: unknown): TaskStatus | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  if (raw === 'open') return 'todo'
  if (raw === 'delivered') return 'done'
  return raw
}

/** The statuses that mean the work is finished, either way. */
export function isClosed(s: TaskStatus): boolean {
  return s === 'done' || s === 'abandoned'
}

/**
 * The status a task should move to the moment a session is actually filed under it, or `null` when
 * this session changes nothing about where the work stands.
 *
 * A session `working`/`waiting` on a delivery still sitting in `backlog`/`todo` is exactly the
 * confusion this exists to fix — reported as "não faz sentido ter sessão working ou waiting e
 * status estarem em todo". It moves FORWARD ONLY, out of the two statuses that mean "nothing
 * started" and into `in_progress`: `blocked`, `in_review`, `done` and `abandoned` all name
 * something more specific than "somebody attached a session", and a session filing must never
 * overwrite one of them — the same one-directional rule `isClosed` already protects elsewhere on
 * this board (an overdue date is never red on a closed task; a claim is not a session).
 */
export function statusAfterAttach(current: TaskStatus): TaskStatus | null {
  return current === 'backlog' || current === 'todo' ? 'in_progress' : null
}

/**
 * Does a SUBTASK's (or group member's) new status count as "real work has begun on this piece",
 * for the purpose of nudging the parent task forward?
 *
 * `in_progress` is the obvious one. `done` is included too, and deliberately: `patchSubtask`'s
 * `done_needs_session` gate already requires a session to be filed before an ORDINARY subtask can
 * reach `done` (a group member is the one exemption, and it still requires the member to have been
 * worked on to get there in practice), so a subtask that skips straight from `backlog`/`todo` to
 * `done` in one patch is at least as strong evidence of progress as merely starting it — refusing
 * to advance the parent in that case would mean LESS progress (a bare start) moves the task forward
 * while MORE progress (a piece actually finished) does not, which nobody would defend.
 *
 * `blocked` / `in_review` / `abandoned` do NOT count. Reported feedback and this rule's own spec
 * only ever asked for the `in_progress` case (plus its `done` extension reasoned above); those three
 * are each ambiguous evidence that "somebody started" — a subtask can be triaged straight into
 * `blocked` before anybody has touched it — and are left for a person, or a future explicit rule, to
 * decide about.
 */
export function subtaskSignalsProgress(status: TaskStatus): boolean {
  return status === 'in_progress' || status === 'done'
}

/**
 * Does THIS transition mark the FIRST real work on a task or subtask — the moment `startedAt`
 * should be stamped?
 *
 * Reuses `subtaskSignalsProgress`'s exact reading of "real progress" (an ordinary move into
 * `in_progress`, or a one-hop jump straight to `done`) rather than restating it: a record that
 * skips `in_progress` entirely still plainly started at some point, and a record that can reach
 * `done` cannot have done so without starting — see `subtaskSignalsProgress`'s own note for why
 * `done` counts. The `before` side is deliberately narrow (`backlog`/`todo` only, the same two
 * words `statusAfterAttach` moves out of): a record already sitting in `blocked`/`in_review` and
 * then moved to `in_progress` has ALREADY started (something happened before the block), so this
 * only fires on the very first departure from "nothing started yet".
 *
 * One-directional like every other rule on this board: a record moving AWAY from `in_progress`/
 * `done` back toward `backlog`/`todo` never un-stamps a start that already happened.
 */
export function marksStart(before: TaskStatus, after: TaskStatus): boolean {
  return (before === 'backlog' || before === 'todo') && subtaskSignalsProgress(after)
}

/**
 * The status a task should move to because one of ITS SUBTASKS (or a group member — §F.1, the two
 * share the same `status` column) just started real work, or `null` when this subtask's status
 * change should leave the parent task's own status untouched.
 *
 * Deliberately reuses `statusAfterAttach`'s exact forward-only decision (`backlog`/`todo` →
 * `in_progress`, everything else untouched) rather than restating it: a subtask starting is the
 * same KIND of evidence a session being filed under the task directly already is — "something
 * concrete began" — so the question of which task statuses may be nudged forward, and to where, is
 * answered in exactly one place. See `statusAfterAttach`'s own note for why `blocked`, `in_review`,
 * `done` and `abandoned` are never overwritten, and why this is one-directional: a subtask later
 * moving AWAY from `in_progress`/`done` must never revert the task automatically — only a person, or
 * another explicit rule, moves work backward.
 */
export function statusAfterSubtaskProgress(
  taskStatus: TaskStatus,
  subtaskStatus: TaskStatus,
): TaskStatus | null {
  if (!subtaskSignalsProgress(subtaskStatus)) return null
  return statusAfterAttach(taskStatus)
}

/**
 * The status a task should move to because EVERY one of its TOP-LEVEL subtasks just reached
 * `done`, or `null` when nothing here should change the task.
 *
 * "Top-level" is deliberate: a GROUP counts as ONE item through its own `status` (which needs a
 * session filed on the group itself to reach `done` — see `patchSubtask`'s own note), never
 * through `groupProgress` over its members. A member's own completion is internal to its group and
 * is not a separate piece of the delivery — counting it here as well as the group would make a
 * task with one three-member group need four `done` rows instead of one. The caller is therefore
 * expected to have already filtered `topLevel` to loose subtasks and groups, excluding every
 * `isGroupMember` row (`task-web.ts`'s `patchSubtask` does this over the SAME post-patch view it
 * uses for the `done_needs_session` gate, so the two never disagree about what just changed).
 *
 * A task with NO subtasks at all returns `null` — "nobody broke this up" is answered by the
 * ORDINARY manual `done` move (`markTask`), not by this rule; a task cannot have "all zero of its
 * parts done" mean anything.
 *
 * Fires from ANY status that is not already closed — including `blocked`/`in_review`, unlike
 * `statusAfterAttach`'s narrower `backlog`/`todo` gate. The two rules answer different STRENGTHS of
 * evidence: "somebody started a piece" is ambiguous (a task can be triaged into `blocked` before
 * anyone has touched it, so `statusAfterAttach` only ever nudges out of "nothing started yet"), but
 * "literally every piece of this delivery is done" is not — a task cannot still be waiting on
 * something (`blocked`) or still under review (`in_review`) once nothing is left to review or wait
 * on. `isClosed` guards the only case that would be wrong: a task already `done` or `abandoned`
 * must never be reopened by a stray later write.
 *
 * `done_needs_session` is never a separate concern here: every top-level item that reached `done`
 * already needed a session filed on IT (a loose subtask directly, a group on itself), so by the
 * time this returns `'done'` the task's own `rowsOfTask` (which counts a session anywhere under the
 * task) is guaranteed non-empty — the SAME gate `markTask` applies to a manual move into `done`
 * therefore always passes for this automatic one too, with no second, looser path.
 */
export function statusAfterAllSubtasksDone(
  taskStatus: TaskStatus,
  topLevel: readonly Pick<Subtask, 'status'>[],
): TaskStatus | null {
  if (isClosed(taskStatus)) return null
  if (topLevel.length === 0) return null
  if (topLevel.some(s => s.status !== 'done')) return null
  return 'done'
}

/**
 * `abandoned` is first-class on purpose. An attempt that was given up on is the most informative
 * row in a comparison; treating it as merely "still open" quietly inflates every average.
 */
export type AttemptStatus = 'running' | 'delivered' | 'abandoned'

/**
 * How a session's conversation link was established — carried into every rollup.
 *
 * `assigned` the CLI was handed the id (`SpawnSpec.assignId`; claude and copilot only).
 * `observed`  claimed once at first sighting (`task-attribution.ts`).
 * `none`      no link: the session contributes rounds and time, and no cost or tokens.
 */
export type LinkProvenance = 'assigned' | 'observed' | 'none'

export interface AttemptConfig {
  harness: HarnessId
  model?: string
  effort?: string
  /** Free text: "sdd", "prompt only", "opus spec then sonnet". The method is not a closed set. */
  method?: string
}

/**
 * How urgent, in the four words every board of this kind uses plus the honest fifth.
 *
 * `none` is not a synonym for "low" — it is "nobody has said", and it is what an absent field reads
 * as. Defaulting an unset priority to `medium` would fill a board with a judgement nobody made, and
 * "what has not been triaged" is a question a coordinator actually asks.
 */
export type TaskPriority = TaskPriorityId

/**
 * Most urgent first — re-exported from `@agentistics/core`, where the browser can read it too.
 * Two lists would be two orders, and the one on screen would be whichever surface drew last.
 */
export { PRIORITY_ORDER }

export function migratePriority(raw: unknown): TaskPriority {
  return typeof raw === 'string' && (PRIORITY_ORDER as readonly string[]).includes(raw)
    ? raw as TaskPriority
    : 'none'
}

/**
 * A LEASE on a task, not a lock.
 *
 * Two agents pulling the same task off a board and doing it twice is the failure this exists to
 * prevent, and the naive fix — a boolean "taken" — has a worse one behind it: an agent that dies
 * holding it takes the task out of circulation forever, with nothing on the board saying why.
 *
 * So a claim EXPIRES. `expiresAt` is set at claim time and is refreshed by whoever holds it; once
 * it passes, the task is available again and says it was. Nothing here deletes anything on its
 * own — expiry is read at the moment the question is asked, so a clock that jumps cannot silently
 * hand one task to two agents between polls.
 */
export interface TaskClaim {
  /** Free text — a session handle, an agent's label, a person. Same rule as `TaskComment.author`. */
  by: string
  at: string
  expiresAt: string
  /** The managed session holding it, when there is one — an exact link where the name is a guess. */
  sessionId?: string
  note?: string
}

/**
 * One thing that HAPPENED to a task, in the order it happened.
 *
 * A board driven by several agents is a board where "who moved this to blocked, and when" is not
 * rhetorical. The kinds are open (free text) for the same reason `TaskComment.author` is: an
 * assistant must be able to record something nobody anticipated without a schema change.
 */
export interface TaskEvent {
  id: string
  taskId: string
  at: string
  /** Who did it. Free text. */
  actor: string
  /** `status` | `claim` | `release` | `assign` | `priority` | `session` | `comment` | … */
  kind: string
  /** What it became, in one short phrase. Rendered verbatim; never a sentence built downstream. */
  detail?: string
  from?: string
  to?: string
}

export interface Task {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  /**
   * When real work actually began, ISO — system-stamped, NEVER user-editable (no route/MCP
   * parameter sets it directly). Stamped once, by `marksStart`, the first time the task's own
   * status or any of its subtasks' status leaves `backlog`/`todo` for real progress; never
   * overwritten afterward, so it is the EARLIEST such moment across the task and all its subtasks.
   * Superseded the old user-editable `startDate` — see that field's own note.
   */
  startedAt?: string
  /** Absent reads as `none` — see `TaskPriority`. */
  priority?: TaskPriority
  /**
   * SUPERSEDED by `startedAt`/`deliveredAt` — a product owner asked for the plan-your-own dates to
   * be replaced by system-observed facts ("quando o trabalho realmente começou/terminou") rather
   * than a date someone typed. Kept, and still round-tripped by `task-store.ts`, only so old
   * records are not silently truncated; no UI in the ALM offers a way to set either any more, and
   * no new code should read or write them. `yyyy-MM-dd`, like `Subtask`'s own pair — a date, not a
   * timestamp, which is exactly why they could never express "the moment it happened" the way
   * `startedAt`/`deliveredAt` do.
   */
  dueDate?: string
  startDate?: string
  /** Free-text labels. Filtering and grouping only; they carry no rule. */
  labels?: string[]
  /**
   * Where the card sits when the board is ordered BY HAND (`task-rank.ts`).
   *
   * A string and not a number, so inserting between two neighbours is one write instead of
   * renumbering everything below — the LexoRank/fractional-indexing trick. Absent means "never
   * dragged": those sort after the ranked ones, by creation, so a board nobody has arranged still
   * reads in a sensible order.
   */
  rank?: string
  /** Who is on it RIGHT NOW, and until when. See `TaskClaim`. */
  claim?: TaskClaim
  /**
   * WHY this task is blocked, in the words of whoever blocked it.
   *
   * `blocked` is the one status that names a problem somebody has to go and solve, and a board full
   * of blocked cards that do not say what they are waiting on is a board nobody can unblock — the
   * fact has to be re-discovered by asking the person, who by then has moved on. So the status
   * cannot be SET without either this sentence or a blocking task (`blockedBy`); see `markTask`.
   *
   * Cleared when the task leaves `blocked`: a reason that outlived its block is a stale sentence
   * that reads as current, which is worse than none.
   */
  blockedReason?: string
  /** `normalizeGitRemote` key, when the work belongs to one repository. */
  repo?: string
  /**
   * Tasks that must finish before this one can proceed — Jira's "is blocked by".
   *
   * Ids, never titles: a title is renameable and a dependency that silently detaches on a rename is
   * worse than no dependency. A task never blocks ITSELF (refused on write), and a blocker that is
   * already `done` or `abandoned` stops counting rather than being removed — the record of what
   * held the work up is part of the delivery's story.
   */
  blockedBy?: string[]
  /**
   * Links out — a pull request, an issue, a doc.
   *
   * `kind` is free text with two conventional values (`pr`, `issue`) the UI renders an icon for;
   * anything else is a plain link. Not an enum, for the same reason `TaskComment.author` is not one:
   * an assistant must be able to attach a kind of link nobody anticipated without a schema change.
   */
  links?: TaskLink[]
  /**
   * Does this delivery travel to the centrals this machine is connected to?
   *
   * ABSENT READS AS NOT SHARED, and that is deliberately NOT the `shareMode` migration rule (where
   * absence reads as denylist, i.e. share). There, treating absence as anything else would
   * silently invert live sharing rules; here, a board carries a description, comments and file
   * names somebody wrote for themselves, and defaulting those to travel would publish text nobody
   * offered. It is the `chat-gate.ts` reading: the cost of the strict one is a switch to flip, the
   * cost of the lenient one is text on somebody else's server.
   *
   * It says nothing about the task's SESSIONS: those are decided by the connection's own sharing
   * rules, unchanged. A shared task in a withheld repository ships its record and none of its
   * sessions, and says so.
   */
  shared?: boolean
}

export interface TaskLink {
  id: string
  url: string
  label?: string
  kind?: string
}

export interface Attempt {
  id: string
  taskId: string
  label: string
  config: AttemptConfig
  status: AttemptStatus
  startedAt: string
  updatedAt: string
  deliveredAt?: string
}

/**
 * A comment on a task — the channel a person and an assistant share.
 *
 * `author` is free text on purpose: it is a person's name, or a session handle, or an agent's
 * label. A closed enum here would mean an assistant could not say who it was without a schema
 * change, and the whole point is that anything working on the task can leave a trace.
 */
export interface TaskComment {
  id: string
  taskId: string
  author: string
  body: string
  createdAt: string
}

/**
 * A subtask is a ROW, not a checkbox.
 *
 * It carries the same columns its parent does — status, dates, a linked session — because
 * the thing people actually break a task into is smaller pieces of the SAME kind of work, and a
 * checkbox cannot say "this half is blocked and that half shipped on Tuesday".
 *
 * It carries no columns of its own for cost, rounds or tokens — those still live only on
 * `ManagedSession`/`SessionMeta`, never duplicated here — but it DOES have a rollup: `task-report.ts`'s
 * `subtaskViews()` sums the sessions filed under this subtask's id, the same way `attemptViews()`
 * already sums an attempt's. That is a READ over the existing rows, never a second source of truth —
 * the task's own total (`TaskDetail.rollup`) is computed once, over every row `rowsOfTask` returns,
 * and a subtask's rollup is only ever a partition of that same set, filtered by `subtaskId`. Nothing
 * here double-counts a session or invents a split the data does not support: a subtask with no
 * sessions filed yet gets an honest empty rollup (`sessionsUsed: 0`, every other metric `null`)
 * rather than being left out or shown as a zero. `done` survives beside `status` because a tick is
 * still the fastest way to close one, and it stays in step with it: `done` is true exactly when
 * `status` is `done`. See docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.2.
 */
export interface Subtask {
  id: string
  taskId: string
  title: string
  done: boolean
  status: TaskStatus
  createdAt: string
  updatedAt: string
  /**
   * SUPERSEDED by `startedAt`/`deliveredAt` — see `Task.dueDate`'s own note; the same
   * user-editable-plan-date-to-system-observed-fact change applies at this level too. Kept,
   * round-tripped by `task-store.ts`, and no longer offered by any UI.
   */
  dueDate?: string
  startDate?: string
  /**
   * When real work actually began on THIS piece, ISO — system-stamped, never user-editable. Stamped
   * once by `marksStart`, the first time this subtask's own status leaves `backlog`/`todo` for real
   * progress; never overwritten afterward. Independent of the task's own `startedAt` (the task's is
   * the EARLIEST across itself and every subtask; this one is about this piece alone).
   */
  startedAt?: string
  /**
   * When this piece reached `done`, ISO — system-stamped, never user-editable, mirroring
   * `Task.deliveredAt` at the subtask level. Stamped once, the moment `status` becomes `done`
   * (`subtaskDone`), whether by a direct move or a rule such as a group member reaching `done` with
   * no session of its own.
   */
  deliveredAt?: string
  /** One session filed under this specific piece. The task's own sessions stay on the task. */
  sessionId?: string
  notes?: string
  /**
   * Subtask ids, of the SAME task, that must be `done` before a session can be filed under this
   * one. See `task-attach.ts`'s `planAttach`, which is the only place this is actually enforced —
   * this field is the fact, not the rule.
   *
   * An id naming a subtask outside this task, or naming itself, is never written here — the
   * sanitize step lives beside the write (`patchSubtask`), the same place `Task.blockedBy`'s
   * cross-task version lives.
   */
  blockedBy?: string[]
  /**
   * SUPERSEDED by `isGroup`/`parentGroupId` — see docs/superpowers/specs/
   * 2026-09-11-alm-session-linking-ux.md §F, which replaces §B's "shared bucket" model with a real
   * hierarchy level. `subtaskViews` (`task-report.ts`) no longer reads this field for bucketing.
   *
   * Kept, and still WRITABLE through `patchSubtask`, only so the already-shipped §B-era UI
   * (`SubtaskTable.tsx`/`TaskTable.tsx`/`subtaskRollup.ts`) keeps compiling until it is updated to
   * the §F model in a follow-on change — production data carries zero subtasks with this field set
   * (checked directly against a live `tasks.json` before this revision), so there is nothing to
   * migrate away from, only a UI surface to stop reading it once it is rewritten. New code should
   * use `isGroup`/`parentGroupId` instead; this field should be removed once the UI no longer names
   * it.
   *
   * **Never coexists, on one record, with `isGroup: true` or a set `parentGroupId`** — two
   * independent, unreconciled "which group" answers on one subtask. `task-web.ts`'s `patchSubtask`
   * refuses a write that would create that state (`group_field_conflict`, 422), checked only when
   * the patch actually touches one of the two fields.
   */
  groupId?: string
  /**
   * A GROUP is a real hierarchy level (§F.1), not a label two subtasks share: it is a peer of a
   * loose subtask in the listing, and it is the ONLY thing a session may be filed on inside this
   * branch of the tree — never one of its own members (`task-attach.ts`'s `planAttach` refuses that,
   * `subtask_in_group`). A group can never itself be a MEMBER — `parentGroupId` and `isGroup: true`
   * never coexist on one record, enforced in `task-attach.ts`'s `checkParentGroup`.
   *
   * Absent reads as "not a group" — the same convention every optional column here follows. Decided
   * at creation (`addSubtask`'s `isGroup` option) and not changed afterwards by this round of work;
   * nothing here refuses a future patch, but nothing offers one either.
   */
  isGroup?: boolean
  /**
   * The GROUP this subtask is a MEMBER of — the group's own subtask id, from the SAME task
   * (`task-attach.ts`'s `checkParentGroup`, mirroring `sanitizeSubtaskBlockedBy`'s same-parent
   * rule). A member NEVER receives a session of its own (refused at filing time,
   * `subtask_in_group`) and therefore gets no rollup bucket of its own either — `subtaskViews`
   * (`task-report.ts`) excludes it entirely rather than publishing an always-empty one. It still has
   * its own `status`, dates, comments and files: those exist independently of whether it
   * ever accounted for a session, and its `status` is what the group's own progress percentage
   * (`groupProgress`, `@agentistics/core`) is computed from.
   *
   * `null` CLEARS it (leaves the group) — the same "an identity is removed, not blanked to an empty
   * string" convention `groupId` already established. Absent reads as "not a member."
   */
  parentGroupId?: string
  /**
   * A DORMANT session draft composed ahead of time on this specific subtask or group — board task
   * t-918cc82233. See `@agentistics/core`'s `stagedSession.ts` for the shape and why it is stored
   * this way rather than as a second, task-agnostic shelf (that is what `SessionPreset` already is).
   *
   * Absent means no draft, the same convention every optional column here follows. Firing it starts
   * a real session via `/api/fleet/new` and immediately files the result under THIS subtask/group
   * through the ordinary `attachSession` — no manual filing step afterward.
   *
   * **Never coexists with `isGroupMember(this)` being true** — a group MEMBER can never receive a
   * session of its own (`task-attach.ts`'s `subtask_in_group` refusal), so a draft composed on one
   * could never be fired there either. `task-web.ts`'s `patchSubtask` refuses a write that would set
   * one on a member, reusing `isGroupMember` rather than reimplementing the rule; a GROUP itself
   * (`isGroup: true`) is exactly like a loose subtask here — it is the one thing in its branch of the
   * tree that MAY hold a session, so it may hold a draft too.
   */
  stagedSession?: StagedSessionDraft
}

/**
 * Does this task travel? The ONE reading of `Task.shared`, so the uploader, the CLI, the MCP and
 * the browser cannot disagree about what absent means. See the field's own note.
 */
export function taskShared(task: Pick<Task, 'shared'>): boolean {
  return task.shared === true
}

/** `done` and `status` are one fact written twice; this keeps them from disagreeing. */
export function subtaskDone(status: TaskStatus): boolean {
  return status === 'done'
}

/** Is this subtask a GROUP (§F.1)? The one reading of `Subtask.isGroup`, so nothing else has to
 *  write `=== true` inline and risk reading `false`/`undefined` differently in two places. */
export function isGroupSubtask(s: Pick<Subtask, 'isGroup'>): boolean {
  return s.isGroup === true
}

/** Is this subtask a MEMBER of a group (§F.1)? The one reading of `Subtask.parentGroupId`. */
export function isGroupMember(s: Pick<Subtask, 'parentGroupId'>): boolean {
  return Boolean(s.parentGroupId)
}

/**
 * Every member of a group, in the order they were created — the set a group's own progress
 * (`groupProgress`, `@agentistics/core`) is computed over, and the set `task-report.ts`'s
 * `groupVisibility` reveals to a session filed on the group.
 */
export function groupMembers(groupId: string, subtasks: readonly Subtask[]): Subtask[] {
  return subtasks.filter(s => s.parentGroupId === groupId)
}

/**
 * A file belonging to the task — a spec, a plan, a screenshot an assistant produced.
 *
 * The BYTES live on disk under the data dir; this record is the index. Kept apart so the book
 * stays a small JSON that is cheap to read on every poll, and so a file that fails to write leaves
 * no phantom row claiming it exists.
 */
export interface TaskFile {
  id: string
  taskId: string
  name: string
  /** Bytes on disk. Recorded so a listing need not stat every file. */
  size: number
  /** Free text: "spec", "plan", "screenshot", "log". Not an enum — see `TaskComment.author`. */
  kind?: string
  author?: string
  createdAt: string
}

/**
 * A HISTORICAL conversation filed on a task or subtask — a conversation the consolidate store still
 * holds (tokens, cost, first prompt) whose fleet-registry row is GONE.
 *
 * WHY IT LIVES ON THE BOARD AND NOT IN THE REGISTRY. A coordinator kills its subtask sessions before
 * closing the subtasks and agentop then purges the rows; the filing (`taskId`/`subtaskId`) dies with
 * the row, so a `done` subtask reads as having no session and its cost is missing from every rollup,
 * while the conversation itself is perfectly measurable in `~/.agentistics/sessions/`. Putting a
 * STUB row back into `managed-sessions.json` would make the fleet believe in a session that is not
 * there: a finished, reopenable row with no cwd, probed and heartbeated, listed by `agentop session
 * ls`, filed under `GONE_PROJECT_KEY`. The board is the one place that already answers "what belongs
 * to this delivery", so the link is stored there and turned into a READ-ONLY synthetic row only when
 * a rollup is built (`task-historical.ts`) — no fleet, registry or reconcile path ever sees it.
 *
 * ONE LINK PER CONVERSATION: `id` is derived from `conversationId`, so filing is a MOVE exactly like
 * filing a registry row (`planAttach`), never an addition.
 */
export interface HistoricalSession {
  /** `hist:<conversationId>` — derived (`historicalLinkId`), never chosen by a caller. */
  id: string
  conversationId: string
  harness: HarnessId
  taskId: string
  /** The subtask it is filed under, when it is filed under one rather than the delivery itself. */
  subtaskId?: string
  /**
   * When the filing was MADE, ISO. A historical link is a filing STATEMENT, and `conversationOwners`
   * decides ownership by the newest statement, so this is the stamp that puts it in the contest.
   */
  linkedAt: string
  note?: string
}

export interface TaskBook {
  tasks: Task[]
  attempts: Attempt[]
  comments: TaskComment[]
  subtasks: Subtask[]
  files: TaskFile[]
  /**
   * Conversations filed on a task with no registry row behind them — see `HistoricalSession`.
   * Always an array on a read (a book written before this existed carries none).
   */
  historicalSessions: HistoricalSession[]
  /**
   * The status VOCABULARY — see `@agentistics/core`'s `taskStatus.ts`. Absent or empty means "never
   * seeded yet"; `task-source.ts`'s `ensureStatusesSeeded` fills it in, once, the first time the
   * book is opened (`planStatusMigration`). Never read this as "every status a task might carry" —
   * a record can outlive the deletion of its own status (deletion is refused while any record still
   * uses it, so in practice this cannot happen through the product's own routes, but a hand-edited
   * file is not bound by that).
   */
  statuses: TaskStatusDef[]
  /**
   * The activity log, newest LAST, for every task at once.
   *
   * One list rather than an array per task, because the question a coordinator asks is "what has
   * been happening", across the board — and because a per-task array makes the cap per task, so a
   * hundred tasks could hold a hundred caps' worth of history in a file read on every poll.
   */
  events: TaskEvent[]
  /**
   * Task ids the user DELETED, so the legacy migration does not mint them again.
   *
   * Without this a deleted task comes straight back: `ensureLegacyTasks` runs on every read and
   * re-creates a task for every name in `preferences.finishedTasks` and every `ManagedSession.task`
   * string. The delete worked, the next read undid it, and the button read as broken. Reported.
   *
   * It is a tombstone and not a permanent ban: creating a task with that title again clears it.
   */
  tombstones: string[]
}

/** The id of the ONE historical link a conversation can hold. */
export function historicalLinkId(conversationId: string): string {
  return `hist:${conversationId}`
}

function shortHex(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 10)
}

function mint(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function newTaskId(): string {
  return mint('t')
}

export function newAttemptId(): string {
  return mint('a')
}

export function newCommentId(): string {
  return mint('c')
}

export function newSubtaskId(): string {
  return mint('s')
}

export function newGroupId(): string {
  return mint('g')
}

export function newFileId(): string {
  return mint('f')
}

export function newLinkId(): string {
  return mint('l')
}

export function newEventId(): string {
  return mint('e')
}

/**
 * The id a legacy free-text task name resolves to.
 *
 * DERIVED from the name rather than minted, which is what makes the migration idempotent: every
 * existing `ManagedSession.task` string already points at its Task without the row being rewritten,
 * and running the migration twice cannot produce two Tasks for one name.
 *
 * The name is hashed VERBATIM. Folding case or trimming would merge two names the user deliberately
 * typed apart, and a board that silently merges two pieces of work is worse than one carrying a
 * near-duplicate.
 */
export function legacyTaskId(name: string): string {
  return `legacy-${shortHex(name)}`
}

/**
 * Every legacy task name, as Tasks.
 *
 * `finished` names are carried even when no session still references them:
 * `preferences.finishedTasks` outlives the sessions it was about, and a delivery that happened is
 * not erased by its rows being cleaned up.
 */
export function migrateLegacyTasks(o: {
  names: readonly string[]
  finished: readonly string[]
  now: string
}): Task[] {
  const finished = new Set(o.finished)
  const seen = new Set<string>()
  const out: Task[] = []
  for (const title of [...o.names, ...o.finished]) {
    if (!title || seen.has(title)) continue
    seen.add(title)
    const delivered = finished.has(title)
    out.push({
      id: legacyTaskId(title),
      title,
      status: delivered ? 'done' : 'todo',
      createdAt: o.now,
      updatedAt: o.now,
      ...(delivered ? { deliveredAt: o.now } : {}),
    })
  }
  return out
}
