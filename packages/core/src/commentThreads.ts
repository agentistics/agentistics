/**
 * commentThreads.ts — which thread a task comment belongs to, and what each thread SHOWS. Pure.
 *
 * Every comment belongs to exactly ONE target: the task itself, a subtask GROUP, or a subtask
 * (loose or a member of a group). The target is stored as an optional `subtaskId` on the comment —
 * ADDITIVE, so a comment written before threads existed carries none and reads as the task's own.
 *
 * ## The aggregation rule — a thread looks DOWNWARD, never up or sideways (UX decision, 2026-10-02)
 *
 * - a SUBTASK's thread (loose or a group member) is its own comments, nothing else;
 * - a GROUP's thread is its own comments PLUS every member's, each member's labelled with the
 *   member it was left on — a group is where its members' work is read together, and a comment on
 *   "the login form" is plainly part of the conversation about the group that holds it;
 * - the TASK's thread is every comment of the task, each non-task one labelled with its target —
 *   the delivery's Comments tab always showed everything, and narrowing it would hide what people
 *   already wrote there.
 *
 * Writing from any thread lands on that thread's OWN target: replying from a group's thread to a
 * member's comment is a comment on the group (the label on the member's comment says where it
 * lives, so the reader is never misled about which thread they are in). It is the same downward-only
 * visibility `groupVisibility` (task-report.ts) applies to sessions, so a group never shows a
 * sibling's comments and a subtask never shows its group's.
 *
 * A thread's COUNT is the size of what that thread shows, so the number on a row is the number of
 * comments that open when it is pressed — a count measured by one rule and a list filtered by
 * another is a row that lies.
 *
 * A comment whose `subtaskId` names nothing any more (the subtask was deleted with an older build
 * that did not re-home its comments, or a hand-edited book) reads as the TASK's — the same fallback
 * the additive migration uses. It never disappears.
 */

/** The fields this module reads off a comment — a structural subset of both sides' `TaskComment`. */
export interface ThreadComment {
  id: string
  createdAt: string
  /** The subtask (or group) it was left on; absent = the task itself. */
  subtaskId?: string
}

/** The fields this module reads off a subtask. */
export interface ThreadSubtask {
  id: string
  title: string
  isGroup?: boolean
  parentGroupId?: string
}

export type CommentTargetKind = 'task' | 'group' | 'subtask'

export interface CommentTarget {
  kind: CommentTargetKind
  /** The subtask/group id; `null` for the task. */
  id: string | null
  /** The subtask's or group's title; absent for the task. */
  title?: string
}

/** One comment as a thread shows it: `via` is set when it was left on a DIFFERENT target. */
export interface ThreadEntry<C extends ThreadComment> {
  comment: C
  via: CommentTarget | null
}

function targetOfSubtask(s: ThreadSubtask): CommentTarget {
  return { kind: s.isGroup === true ? 'group' : 'subtask', id: s.id, title: s.title }
}

/** Where a comment lives. A dangling `subtaskId` reads as the task's — see the header. */
export function commentTarget(c: ThreadComment, subtasks: readonly ThreadSubtask[]): CommentTarget {
  if (!c.subtaskId) return { kind: 'task', id: null }
  const s = subtasks.find(x => x.id === c.subtaskId)
  return s ? targetOfSubtask(s) : { kind: 'task', id: null }
}

/**
 * Is a comment living on `ownId` visible from the thread of `threadId`? `threadId === null` is the
 * task. Downward only: the thread itself, and — for a group — its members.
 */
function visibleFrom(ownId: string | null, threadId: string | null, subtasks: readonly ThreadSubtask[]): boolean {
  if (threadId === null) return true
  if (ownId === threadId) return true
  if (ownId === null) return false
  const thread = subtasks.find(s => s.id === threadId)
  if (!thread || thread.isGroup !== true) return false
  const own = subtasks.find(s => s.id === ownId)
  return own?.parentGroupId === threadId
}

/**
 * What the thread of `threadId` shows (`null` = the task), oldest first, each entry carrying `via`
 * when the comment lives on a different target than the thread.
 */
export function commentThread<C extends ThreadComment>(
  comments: readonly C[],
  subtasks: readonly ThreadSubtask[],
  threadId: string | null,
): ThreadEntry<C>[] {
  return comments
    .map(c => ({ c, t: commentTarget(c, subtasks) }))
    .filter(({ t }) => visibleFrom(t.id, threadId, subtasks))
    .sort((a, b) => a.c.createdAt.localeCompare(b.c.createdAt))
    .map(({ c, t }) => ({ comment: c, via: t.id === threadId ? null : t }))
}

/**
 * Thread sizes: `task` is every comment, `bySubtask[id]` is what that subtask's (or group's) thread
 * shows. A subtask with no comments is absent rather than `0`; read it with `?? 0`.
 */
export function commentCounts(
  comments: readonly ThreadComment[],
  subtasks: readonly ThreadSubtask[],
): { task: number; bySubtask: Record<string, number> } {
  const bySubtask: Record<string, number> = {}
  for (const c of comments) {
    const t = commentTarget(c, subtasks)
    if (t.id === null) continue
    bySubtask[t.id] = (bySubtask[t.id] ?? 0) + 1
    const own = subtasks.find(s => s.id === t.id)
    const group = own?.parentGroupId ? subtasks.find(s => s.id === own.parentGroupId && s.isGroup === true) : undefined
    if (group) bySubtask[group.id] = (bySubtask[group.id] ?? 0) + 1
  }
  return { task: comments.length, bySubtask }
}

/**
 * Every comment filed under its OWN target — no aggregation — in a stable order: the task first,
 * then the subtasks in the order given. A target with no comments is omitted. This is the shape the
 * API hands an assistant ("comments grouped by target"); the aggregated view is `commentThread`.
 */
export function commentsByTarget<C extends ThreadComment>(
  comments: readonly C[],
  subtasks: readonly ThreadSubtask[],
): { target: CommentTarget; comments: C[] }[] {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const out: { target: CommentTarget; comments: C[] }[] = []
  const own = sorted.filter(c => commentTarget(c, subtasks).id === null)
  if (own.length > 0) out.push({ target: { kind: 'task', id: null }, comments: own })
  for (const s of subtasks) {
    const mine = sorted.filter(c => c.subtaskId === s.id)
    if (mine.length > 0) out.push({ target: targetOfSubtask(s), comments: mine })
  }
  return out
}
