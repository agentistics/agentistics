/**
 * task-attach.ts — PURE. What a session is filed under, and the fact that it is exactly one thing.
 *
 * **A subtask may also be BLOCKED BY sibling subtasks of the same delivery**, and a session cannot
 * be filed under one while any of its blockers is not `done` — "while the subtask that blocked it
 * is not done, the blocked one cannot be started." `planAttach` is where that is decided, for the
 * same reason it is where the task/subtask exclusivity is decided: one rule in one place, so a
 * second surface cannot file a session under blocked work by going around it. A dangling blocker id
 * (the blocking subtask was deleted) is not a live block — the same reconciliation `filedUnder`
 * already applies to a missing subtask.
 *
 * **A session may be filed on the delivery directly, or on one of its subtasks, or both — see the
 * 2026-09-10 spec for why holding both is safe** (`docs/superpowers/specs/
 * 2026-09-10-task-session-hierarchy-design.md`). A delivery is the unit of DELIVERY; a subtask is
 * the unit of WORK. The two are not mutually exclusive: a simple task can hold its sessions
 * directly (no subtasks at all), a task broken into steps can file each session under the subtask
 * it belongs to, and a task can do both at once — direct sessions for the part that was never
 * broken out, plus subtasks for the part that was.
 *
 * This used to be refused outright ("a delivery does not take sessions, the caller must name a
 * subtask"), on the reasoning that allowing both left "did this cost include the subtasks or not"
 * without an answer. That reasoning stopped holding once `rowsOfTask` (`task-report.ts`) turned out
 * to already sum every row by `taskId` regardless of `subtaskId` — the task-level total was never
 * actually ambiguous. What had no answer was one level down: how much a given SUBTASK cost, because
 * a subtask carried no rollup of its own. `task-report.ts`'s per-subtask views close that gap and
 * give the un-broken-out, directly-filed part of a task its own answerable bucket
 * (`subtaskId: null`) instead of a silent, unaccounted-for gap — which is what makes reopening
 * direct filing safe rather than a regression back to the original ambiguity.
 *
 * That is still the whole point of this module: the exclusivity that matters is at the STORAGE
 * level — a session's `subtaskId`/`taskId` pair names exactly one owner, decided in exactly one
 * place — so a second surface cannot invent a session that appears in two lists at once, where a
 * reader would count it twice and neither list would be the truth.
 *
 * The parent id is still STORED beside the subtask id, and that is not a contradiction — it is the
 * derived half of the same fact. A subtask belongs to a task, so a session filed under the subtask
 * is a session of that task, and the delivery's cost has to keep including it (that is what makes
 * the total close: direct sessions + every subtask's = the delivery). The invariant is therefore
 * one-directional and absolute:
 *
 *   `subtaskId` set  ⟹  `taskId` is that subtask's OWN task.
 *
 * Nothing else may write the pair. `planAttach` is the only thing that decides it, so the two ids
 * cannot drift into naming different deliveries — which would put a session's cost on one task and
 * its row on another.
 *
 * MOVING is the operation, never adding: filing under a subtask CLEARS nothing but replaces where
 * the row belongs, and filing under a task clears the subtask outright. Re-filing into a DIFFERENT
 * task clears it too, because a subtask of one delivery cannot own a session of another.
 */

export interface AttachSubtask {
  id: string
  taskId: string
  /** Whether THIS subtask is done — read when it appears as someone else's blocker. */
  done: boolean
  /** Sibling subtask ids that must be done before a session may file under this one. */
  blockedBy?: readonly string[]
  /**
   * The GROUP this subtask is a MEMBER of, when it is one (§F.1 of docs/superpowers/specs/
   * 2026-09-11-alm-session-linking-ux.md). A member can NEVER be filed with a session directly —
   * see `planAttach`'s `subtask_in_group` refusal below — a group is the only thing in its branch of
   * the tree that may hold one.
   */
  parentGroupId?: string
}

/** Where the caller asked the session to go. */
export type AttachTarget =
  | { kind: 'task'; id: string }
  | { kind: 'subtask'; id: string }
  /** Unfile it entirely. */
  | { kind: 'none' }

export type AttachPlan =
  | { ok: true; taskId: string | null; subtaskId: string | null }
  | {
    ok: false
    /**
     * `blocked`: the target subtask is still waiting on work named in its own `blockedBy`.
     * `subtask_in_group`: the target is a MEMBER of a group (§F.1) — only the group itself may hold
     * a session; see `checkParentGroup` for the write-side rule that keeps a member from ever
     * naming one.
     */
    reason: 'no_such_task' | 'no_such_subtask' | 'blocked' | 'subtask_in_group'
    /** Set only for `blocked` — the still-open blocker ids, so the caller can name them. */
    blockedBy?: readonly string[]
  }

export function planAttach(o: {
  target: AttachTarget
  /** The task ids that exist. A target naming none of them is refused, never guessed. */
  taskIds: readonly string[]
  subtasks: readonly AttachSubtask[]
}): AttachPlan {
  if (o.target.kind === 'none') return { ok: true, taskId: null, subtaskId: null }

  if (o.target.kind === 'task') {
    if (!o.taskIds.includes(o.target.id)) return { ok: false, reason: 'no_such_task' }
    // A session may be filed straight on the delivery — see §2.2/§4.2 of
    // docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md for why this is safe: the
    // task's own rollup already sums every row by taskId regardless of subtaskId, and the
    // subtask-rollup work (task-report.ts's per-subtask views) gives the "not broken out" part of a
    // task its own answerable bucket instead of an unaccounted-for gap.
    return { ok: true, taskId: o.target.id, subtaskId: null }
  }

  const wanted = o.target.id
  const sub = o.subtasks.find(s => s.id === wanted)
  if (!sub) return { ok: false, reason: 'no_such_subtask' }

  // A GROUP MEMBER can never hold a session of its own — §F.1. Checked before `blockedBy`: whether
  // a member's own blockers are done is moot when it cannot receive a session either way, and
  // refusing here first means the caller always learns the more fundamental reason.
  if (sub.parentGroupId) return { ok: false, reason: 'subtask_in_group' }

  // A blocker naming nothing this book still holds is not a live block — the same rule
  // `reconcileAttachment` applies to a session's own dangling `subtaskId`. Everything else that is
  // not yet `done` stands, in the ORDER it was recorded, so the caller can lead with the first one.
  const unmet = (sub.blockedBy ?? [])
    .filter(id => o.subtasks.some(s => s.id === id && !s.done))
  if (unmet.length > 0) return { ok: false, reason: 'blocked', blockedBy: unmet }

  // The parent comes from the SUBTASK, never from the caller: that is what makes the two ids
  // incapable of naming different deliveries.
  return { ok: true, taskId: sub.taskId, subtaskId: sub.id }
}

/**
 * Sanitize a subtask's own `blockedBy` list before it is written.
 *
 * Mirrors `Task.blockedBy`'s own sanitize in `setBlockedBy` — dedupe, drop self-reference, drop a
 * blocker outside this subtask's OWN task (a subtask may only be blocked by a sibling; a cross-
 * delivery blocker could never resolve through the same `TaskDetail` fetch the picker uses to show
 * it). The check is by TASK, not by "exists in `subtasks`", because the caller already scoped
 * `subtasks` to one delivery in every measured use, and repeating that filter here costs nothing
 * and protects a future caller that passes the whole book by mistake.
 */
export function sanitizeSubtaskBlockedBy(o: {
  subtaskId: string
  taskId: string
  ids: readonly string[]
  /** The subtasks of the SAME task — a blocker outside it is dropped, not merely unusable later. */
  siblings: readonly { id: string; taskId: string }[]
}): string[] {
  const known = new Set(
    o.siblings.filter(s => s.taskId === o.taskId).map(s => s.id),
  )
  return [...new Set(o.ids)].filter(id => id !== o.subtaskId && known.has(id))
}

/**
 * Where a MEMBER subtask may point its `parentGroupId` — §F.1's same-parent rule for groups,
 * mirroring `sanitizeSubtaskBlockedBy`'s same-parent rule for blockers. Unlike that one, this is
 * ONE reference rather than a list, and a bad one is a deliberate ACT (joining a group) rather than
 * a stale entry in an otherwise-fine list — so it is REFUSED with a named reason (`invalid_group`)
 * instead of silently dropped, the same shape `done_needs_session`/`blocked_needs_reason` already
 * use for "this request cannot do that."
 *
 * Refused when:
 *  - the subtask BEING PATCHED is itself a group (`isGroup: true`) — a group can never be a member
 *    of another group (§F.1);
 *  - the named group does not exist, is not actually a group, is the subtask itself, or belongs to
 *    a different task (a group cannot span two parent tasks — §F.1's last rule);
 *  - the subtask being joined ALREADY has at least one session filed on it (`subtask_has_sessions`)
 *    — a MEMBER gets no rollup bucket of its own at all (`task-report.ts`'s `subtaskViews` excludes
 *    it outright, since it can never receive a session either), so a session already sitting on it
 *    would silently drop out of every visible per-subtask/per-group breakdown the instant it joins,
 *    while the task's own total (computed independently, over every row) still counts it — the two
 *    would then disagree with nothing on screen explaining the gap. Refusing here is the same shape
 *    as `done_needs_session`/`blocked_needs_reason`: a piece of work this request cannot do, not a
 *    resource that is missing.
 */
export interface GroupSibling {
  id: string
  taskId: string
  isGroup?: boolean
}

export function checkParentGroup(o: {
  subtaskId: string
  taskId: string
  /** Whether the subtask BEING PATCHED is itself a group. */
  isGroup: boolean
  parentGroupId: string
  /** The task's subtasks, to resolve the named group against — same-task scoping happens here. */
  siblings: readonly GroupSibling[]
  /**
   * Whether the subtask BEING PATCHED already has at least one session filed on it. The caller
   * resolves this against the live row set (the same set `done_needs_session` already reads),
   * because this module is pure and holds no session data of its own. Optional and defaulting to
   * `false` so a caller that has not resolved the row set — or a test exercising only the reference
   * rule — is unaffected.
   */
  hasSession?: boolean
}): { ok: true } | { ok: false; reason: 'invalid_group' | 'subtask_has_sessions' } {
  if (o.isGroup) return { ok: false, reason: 'invalid_group' }
  const group = o.siblings.find(s => s.id === o.parentGroupId)
  if (!group || group.id === o.subtaskId || group.isGroup !== true || group.taskId !== o.taskId) {
    return { ok: false, reason: 'invalid_group' }
  }
  // Checked LAST, after the reference itself is confirmed real: a bogus/self/cross-task reference
  // names nothing to join in the first place, and that is the more fundamental reason — reporting
  // `subtask_has_sessions` over a reference that could never have succeeded either way would send
  // the caller to detach a session for a join that was always going to be refused.
  if (o.hasSession) return { ok: false, reason: 'subtask_has_sessions' }
  return { ok: true }
}

/**
 * What a row is filed under, read back — the single answer every surface renders.
 *
 * A `subtaskId` wins over the `taskId` beside it, because the pair means "this session belongs to
 * this subtask, which belongs to this task". Reading both as two attachments is exactly the
 * double-counting this module exists to make impossible.
 */
export function filedUnder(row: { taskId?: string; subtaskId?: string }): AttachTarget {
  if (row.subtaskId) return { kind: 'subtask', id: row.subtaskId }
  if (row.taskId) return { kind: 'task', id: row.taskId }
  return { kind: 'none' }
}

/**
 * Is this row's pair internally consistent?
 *
 * Used to REPAIR on read rather than to trust: a subtask deleted while a session pointed at it, or
 * a record written by an older build, leaves a `subtaskId` naming nothing. Such a row falls back to
 * its task — the delivery is still true — rather than disappearing from both lists.
 */
export function reconcileAttachment(
  row: { taskId?: string; subtaskId?: string },
  subtasks: readonly AttachSubtask[],
): { taskId: string | null; subtaskId: string | null } {
  if (!row.subtaskId) return { taskId: row.taskId ?? null, subtaskId: null }
  const sub = subtasks.find(s => s.id === row.subtaskId)
  if (!sub) return { taskId: row.taskId ?? null, subtaskId: null }
  return { taskId: sub.taskId, subtaskId: sub.id }
}
