/**
 * task-worker-filing.ts — PURE. A WORKER that reports on a subtask is filed on that subtask.
 *
 * FILIACAO.TOAST (owner, 2026-11-15): "não quero que esses erros da sessão filiada fiquem aparecendo
 * sem parar por bug de filiação que não foi integrado direito". Measured on the real board
 * (read-only copy, 2026-11-15): of the top-level subtasks the `done_needs_session` gate refuses, the
 * biggest group WITH work behind them are pieces whose worker was filed on the TASK alone (spawned
 * with `--task` and no `--subtask`, before the 2.198 `leader_only` rule, or by a path that still does
 * it) and then posted its comments and handbacks ON THE SUBTASK. The verified comment (`role:
 * 'session'`, `sessionId`) proves which piece the session worked on; the registry row only said
 * "this task". So the piece read as "nothing filed" and a legitimate `done` was refused.
 *
 * Two doors use the rule here and nothing else:
 *  - `addComment` (forward): a verified worker filed on the task with no subtask that posts on a
 *    subtask of that SAME task is filed there, once (a row already on a subtask is never moved).
 *  - `planWorkerFilingBackfill` (the one-shot repair of existing stores, idempotent).
 *
 * Every rule errs toward NOT filing: a leader (or an unknown role) is never moved — a leader comments
 * on every piece it coordinates, and filing is a MOVE that would take it off the task; a session that
 * reported on two different pieces is AMBIGUOUS and left for a person; another task is never touched.
 */

import { distinctConversations } from './task-conversations'
import type { BoardRow } from './types'

/** The subtask fields the rule reads. */
export interface FilingSubtask { id: string; taskId: string; parentGroupId?: string | undefined }

/**
 * Where a comment on `subtaskId` files its session: the subtask itself, or — for a group MEMBER,
 * which can never hold a session (`subtask_in_group`) — the group that accounts for it. `null` when
 * the subtask is not a piece of `taskId`.
 */
export function filingTargetOf(taskId: string, subtaskId: string, subtasks: readonly FilingSubtask[]): string | null {
  const s = subtasks.find(x => x.id === subtaskId)
  if (!s || s.taskId !== taskId) return null
  if (!s.parentGroupId) return s.id
  const g = subtasks.find(x => x.id === s.parentGroupId)
  return g && g.taskId === taskId ? g.id : null
}

/**
 * FORWARD: the subtask a verified session's comment files it on, or `null` to leave it alone.
 * `row` is the session's own registry row (the one the comment's identity names).
 */
export function workerFilingTarget(o: {
  row: Pick<BoardRow, 'taskId' | 'subtaskId'> | undefined
  role: 'leader' | 'worker' | undefined
  commentTaskId: string
  commentSubtaskId: string | undefined
  subtasks: readonly FilingSubtask[]
}): string | null {
  if (o.role !== 'worker' || !o.row || !o.commentSubtaskId) return null
  if (o.row.taskId !== o.commentTaskId || o.row.subtaskId) return null
  return filingTargetOf(o.commentTaskId, o.commentSubtaskId, o.subtasks)
}

/**
 * THE DONE GATE'S SECOND KIND OF EVIDENCE: a VERIFIED session (`role: 'session'`, its identity proven
 * by `session-identity.ts`) that BELONGS TO THIS TASK (its conversation's owner, `conversationOwners`)
 * reported on this piece — or on a member of this group.
 *
 * Why this exists rather than "file it": a conversation is filed in ONE place. A leader that closed a
 * piece itself (a duplicate owner request "covered by s-…", an artifact, a piece another piece shipped)
 * is filed on the TASK and coordinates many pieces; filing it on one would take it off the task and off
 * every other piece. Measured 2026-11-15 on the real board: of the open pieces the gate refused, 18 of
 * 31 in review, 5 of 6 in progress and 3 of 3 in CI had such a report and nothing else. Nothing is
 * double-counted: the session's cost stays in the task's direct bucket, exactly where the rollup puts it.
 *
 * An unverified comment (free-text author), a plain note (only `handback`/`decision` count), a session of
 * another task and an unfiled session never count.
 */
export function reportedByTaskSession(
  taskId: string,
  subtaskId: string,
  comments: readonly BackfillComment[],
  rows: readonly BoardRow[],
  owners: ReadonlyMap<string, string>,
  subtasks: readonly FilingSubtask[],
): boolean {
  for (const c of comments) {
    if (c.taskId !== taskId || c.role !== 'session' || !c.sessionId || !c.subtaskId) continue
    // Only a REPORT counts (a handback, or a leader's recorded decision such as "covered by s-…"): a plain
    // note like "vou ver" is not evidence that the piece was worked on.
    if (c.kind !== 'handback' && c.kind !== 'decision') continue
    if (filingTargetOf(taskId, c.subtaskId, subtasks) !== subtaskId) continue
    const row = rows.find(r => r.id === c.sessionId)
    if (!row) continue
    const owner = row.conversationId ? owners.get(row.conversationId) : (row.taskId || undefined)
    if (owner === taskId) return true
  }
  return false
}

export interface BackfillComment { taskId: string; subtaskId?: string | undefined; role?: string | undefined; sessionId?: string | undefined; kind?: string | undefined }

export interface WorkerFilingPlan {
  /** File `sessionId` (the conversation's NEWEST row, so the filing is its newest statement) on `subtaskId`. */
  file: { sessionId: string; taskId: string; subtaskId: string }[]
  /** Reported on more than one piece: a person decides. */
  ambiguous: { sessionId: string; taskId: string; subtaskIds: string[] }[]
}

/**
 * BACKFILL: every worker conversation whose CURRENT filing is the task with no subtask (its newest
 * row carrying a `taskId` statement says so) and whose verified comments name exactly ONE piece of
 * that task. Idempotent: a second run finds the conversation already on its subtask and plans nothing.
 */
export function planWorkerFilingBackfill(o: {
  rows: readonly BoardRow[]
  comments: readonly BackfillComment[]
  subtasks: readonly FilingSubtask[]
  roleOf: (row: BoardRow) => 'leader' | 'worker' | undefined
}): WorkerFilingPlan {
  const plan: WorkerFilingPlan = { file: [], ambiguous: [] }
  // One key per conversation (a row with no link is its own conversation).
  const groups = new Map<string, BoardRow[]>()
  for (const r of o.rows) {
    if ((r as { historical?: boolean }).historical) continue
    const k = r.conversationId ? `c:${r.conversationId}` : `r:${r.id}`
    const l = groups.get(k); if (l) l.push(r); else groups.set(k, [r])
  }
  const bySession = new Map<string, BackfillComment[]>()
  for (const c of o.comments) {
    if (c.role !== 'session' || !c.sessionId || !c.subtaskId) continue
    const l = bySession.get(c.sessionId); if (l) l.push(c); else bySession.set(c.sessionId, [c])
  }
  for (const rows of groups.values()) {
    const statement = distinctConversations(rows.filter(r => r.taskId !== undefined))[0]
    if (!statement || !statement.taskId || statement.subtaskId) continue
    if (o.roleOf(statement) !== 'worker') continue
    const taskId = statement.taskId
    const targets = new Set<string>()
    for (const r of rows) for (const c of bySession.get(r.id) ?? []) {
      if (c.taskId !== taskId) continue
      const t = filingTargetOf(taskId, c.subtaskId!, o.subtasks)
      if (t) targets.add(t)
    }
    if (targets.size === 0) continue
    const newest = distinctConversations(rows)[0]!
    if (targets.size > 1) { plan.ambiguous.push({ sessionId: newest.id, taskId, subtaskIds: [...targets].sort() }); continue }
    plan.file.push({ sessionId: newest.id, taskId, subtaskId: [...targets][0]! })
  }
  return plan
}
