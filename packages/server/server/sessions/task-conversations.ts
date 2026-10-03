/**
 * task-conversations.ts — PURE. The ONE rule for "which row stands for a conversation" when a
 * surface walks a task's registry rows. `task-report.ts`, `task-stats.ts` and `task-overview.ts` all
 * read it, and it lives here rather than in `task-report.ts` only because `task-report.ts` imports
 * `task-stats.ts` — a rule two of them share cannot sit in the one that imports the other.
 *
 * Every attach, reopen and restart mints a NEW managed id for the SAME conversation and retires the
 * old row without removing it (see `collapseSupersededSessions` for the fleet's own list), so a
 * conversation worked on across a fortnight is several registry rows. They are one conversation and
 * must be counted once — but they are NOT interchangeable: each row carries its own filing
 * (`taskId` / `subtaskId` / `attemptId`), its own `endedAt` and its own liveness, and the filing is
 * a MOVE (`planAttach`), so only the newest row holds where the person put the conversation LAST.
 */

import { legacyTaskId } from './task-model'
import type { BoardRow } from './types'

/**
 * Is `a` at least as new as `b`? By `createdAt` when both parse and differ; otherwise REGISTRY
 * ORDER decides, and a later row is the newer one (the registry only ever appends). A missing or
 * unparseable stamp must not be a reason to keep the older row: an unreadable date is not evidence
 * that a row is old.
 */
function atLeastAsNew(a: BoardRow, b: BoardRow): boolean {
  const ta = Date.parse(a.createdAt)
  const tb = Date.parse(b.createdAt)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb
  return true
}

/**
 * One row per CONVERSATION — and that row is the NEWEST of the candidates it is given, because the
 * newest row carries the CURRENT filing and the CURRENT liveness. Output order is the FIRST-SEEN
 * order of the conversations, with the newest row substituted into its conversation's slot, so a
 * list does not reshuffle when a conversation is reopened.
 *
 * The rule is stated once here for every surface that accumulates over a task's rows. Keeping the
 * FIRST row instead (as this once did) counted each conversation correctly and then described it by
 * its OLDEST row: a session filed on a subtask yesterday and running now was absent from a task's
 * `sessions`, and its cost stayed attributed to whichever filing it was born with.
 *
 * The candidates are whatever the caller passes, so the caller decides the scope: hand it a task's
 * rows (`rowsOfTask`) and the newest row OF THAT TASK stands for the conversation.
 *
 * A row with NO conversation link is always kept: it cannot be shown to be a duplicate of anything.
 */
export function distinctConversations<R extends BoardRow>(rows: readonly R[]): R[] {
  const slotOf = new Map<string, number>()
  const out: R[] = []
  for (const r of rows) {
    if (!r.conversationId) {
      out.push(r)
      continue
    }
    const slot = slotOf.get(r.conversationId)
    if (slot === undefined) {
      slotOf.set(r.conversationId, out.length)
      out.push(r)
    } else if (atLeastAsNew(r, out[slot]!)) {
      out[slot] = r
    }
  }
  return out
}

/**
 * WHICH TASK A CONVERSATION BELONGS TO — exactly one, or none. `distinctConversations` answers
 * "which row stands for the conversation INSIDE one task"; this answers the question that comes
 * first, and that a per-task walk cannot answer from its own rows: whether the conversation is that
 * task's at all.
 *
 * Filing is a MOVE (`planAttach`), but it is a move written on ONE ROW. Every attach, reopen and
 * restart mints a new managed id for the same conversation and leaves the older rows exactly as they
 * were, so a conversation moved from task A to task B holds an older row still saying A and a newer
 * one saying B. `rowsOfTask` walked each task's own rows and found the conversation in both, and
 * `buildBoardOverview` summed the two — the board's headline counted one conversation twice.
 *
 * THE RULE: the newest FILING STATEMENT decides, and a row only makes one when it says something
 * about the task id:
 *
 *  - `taskId` non-empty      -> filed on that task;
 *  - `taskId === ''`         -> explicitly UNFILED. That is exactly what `detachSession` writes
 *                               (`taskId: ''`), and it is the only writer of an empty string, so it
 *                               is the one mark that tells a person's "take it off" from a reopen
 *                               that simply did not carry the filing;
 *  - `taskId` absent         -> says nothing about the id, and is IGNORED. A reopen mints a row that
 *                               does not inherit `taskId`; measured on a real board, the Pelvie
 *                               coordinator conversation has 13 rows and only 3 carry the task, so if
 *                               "newest row" decided ownership every reopen would orphan the
 *                               conversation from its task.
 *
 * The free-text NAME (`task`, resolved through `legacyTaskId`) is the WEAKER tier and is consulted
 * only when NO row of the conversation says anything about the id, neither a filing nor an unfile.
 * The name outlives what it names: it survives a rename (a task renamed from "Terminal utilitario"
 * still has rows wearing the old title, which resolve to a second, phantom task minted from that
 * old name) and it is copied into every reopen while the id is not. Letting a newer name-only row
 * outrank an id filing would hand the conversation to the phantom — measured, and it is what this
 * rule exists to prevent. Within a tier the newest statement wins, by `createdAt` and then registry
 * order (`atLeastAsNew`, the convention `distinctConversations` uses).
 *
 * The result maps a conversation id to the task KEY it belongs to (a real task id, or a
 * `legacyTaskId`). A conversation with no statement at all, or whose newest statement is an unfile,
 * is ABSENT: it belongs to no task, which is a different fact from belonging to a missing one.
 * A row with NO `conversationId` is not in the map and is never grouped — it cannot be shown to be
 * a duplicate of anything, so it keeps belonging to whatever task it names.
 *
 * KNOWN LIMIT: the key is not checked against the book. A conversation whose newest filing names a
 * task that was since DELETED (a tombstoned id) belongs to that ghost and is counted by no task,
 * rather than falling back to an older filing the person had already moved it away from. The
 * writer of a deleted task's rows does not unfile them, and this module holds no task list to
 * notice — the alternative (fall back) would resurrect a filing on deletion.
 *
 * The caller must hand it the WHOLE registry. Ownership is a fact about every row of a
 * conversation, so a pre-filtered subset (one task's rows) would compute it from the rows that
 * happen to agree with the task being asked about.
 */
export function conversationOwners(rows: readonly BoardRow[]): Map<string, string> {
  type Statement = { row: BoardRow; key: string | null }
  const byId = new Map<string, Statement>()
  const byName = new Map<string, Statement>()
  // A name is hashed on every call otherwise, and a registry has a handful of distinct ones.
  const nameKeys = new Map<string, string>()
  const nameKey = (name: string): string => {
    let k = nameKeys.get(name)
    if (k === undefined) { k = legacyTaskId(name); nameKeys.set(name, k) }
    return k
  }

  for (const r of rows) {
    const conv = r.conversationId
    if (!conv) continue
    if (r.taskId !== undefined) {
      const cur = byId.get(conv)
      if (!cur || atLeastAsNew(r, cur.row)) byId.set(conv, { row: r, key: r.taskId === '' ? null : r.taskId })
    } else if (r.task) {
      const cur = byName.get(conv)
      if (!cur || atLeastAsNew(r, cur.row)) byName.set(conv, { row: r, key: nameKey(r.task) })
    }
  }

  const out = new Map<string, string>()
  const settled = new Set<string>()
  for (const [conv, st] of byId) {
    settled.add(conv)
    if (st.key !== null) out.set(conv, st.key)
  }
  for (const [conv, st] of byName) {
    if (!settled.has(conv) && st.key !== null) out.set(conv, st.key)
  }
  return out
}
