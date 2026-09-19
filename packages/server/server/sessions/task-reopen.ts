/**
 * task-reopen.ts — PURE: what reopening a whole task actually does, row by row.
 *
 * Reopening a task is implemented twice — once behind `agentop session open` and once behind the
 * cockpit's verb — and the two had drifted: only one of them retired the row it was replacing, so
 * the same gesture left a different registry depending on where you pressed it. The DECISION lives
 * here and both callers perform it.
 *
 * The rules it encodes, each of which was a real defect:
 *
 *  - A row that is still RUNNING is left alone. After a reboot one session sometimes survives, and
 *    reopening the task must not spawn a second copy of it. It is reported as `already`, never as a
 *    failure — calling it a skip announces a problem where there is none.
 *  - A row already marked FINISHED is not resurrected. Ending a session is a decision, and "open
 *    the task" must not quietly undo every one of them.
 *  - A row whose conversation cannot be resolved is skipped AND counted. A partial reopen reported
 *    as a success leaves someone believing they have their whole task back.
 *  - Everything reopened RETIRES its old row. Without it a laptop closed and opened twice leaves the
 *    task holding two dead twins and one live session, all wearing the same name.
 *  - **A conversation ANOTHER live session is already driving is not opened a second time.** The
 *    rules above are all about ROWS, and rows are not the thing that gets corrupted: two rows are a
 *    tidy-up, two assistants typing into one transcript and one working tree is lost work. Measured
 *    on 2026-08-14 — five conversations were each open under two to four not-ended rows, the harness
 *    itself was printing "another Claude Code on this machine already has Remote Control for this
 *    conversation", and one of the twins stopped itself because it could see files changing under
 *    it. `liveIds` cannot see this: it is keyed by ROW, so a row that is `lost` while a DIFFERENT
 *    row drives its conversation passes every check here.
 *  - **A conversation this SAME plan already claimed is not claimed twice.** `inUse` only ever
 *    answers about a session that is ALREADY live, so it says nothing about two ROWS resolving to
 *    the identical conversation within one call — a retired predecessor whose `conversationId` was
 *    never cleared, or two fallen rows that both happen to name the same recorded id. Measured on
 *    the isolated preview reproducing "reopen what fell": two concurrent calls each read the
 *    registry before either had retired anything, each resolved the SAME row to the SAME
 *    `conversationId`, and the fleet ended up with two live rows driving one transcript. The fix for
 *    the concurrency itself lives at the call site (see `resume-lock.ts`); THIS is the backstop for
 *    the case where one single planning pass is handed the same conversation more than once — the
 *    second row is skipped rather than spawning a twin of the first.
 *  - **An empty (or otherwise falsy) resolved id never claims anything.** `claimed` is keyed on
 *    `conv.sessionId`, so without this rule TWO rows a broken `conversationFor` handed the
 *    degenerate id `''` would collide on that empty string exactly as if they shared a real
 *    conversation, and the second would be silently skipped as a "duplicate" of the first. Neither
 *    real caller produces `''` today (a resolver that cannot resolve returns `null`, not an empty
 *    id) — but that was true "by luck", not by anything this function enforced, and this rule's own
 *    job is to be the enforcement. So a falsy id is never added to `claimed` and never blocks
 *    another row via it: both rows are planned, each on its own (equally degenerate) terms, rather
 *    than one silently vanishing into the other's shadow.
 */

import { conversationHeldBy, type ConversationHolder } from './conversation-claim'
import type { ManagedSession } from './types'

export interface TaskReopenRow {
  entry: ManagedSession
  /** The harness's own conversation id to resume. */
  resumeId: string
  /** What the new row should be called: the user's label wins over the transcript's title. */
  label: string
}

/** A row left alone because its conversation is open somewhere else. */
export interface TaskReopenHeld {
  /** The row that was not reopened. */
  id: string
  /** The live session already driving that row's conversation. */
  holder: ConversationHolder
}

export interface TaskReopenPlan {
  /** In registry order, so a task comes back in the order it was built. */
  reopen: TaskReopenRow[]
  /** Ids left alone because they are still running. */
  already: string[]
  /** Ids that could not be reopened at all, and are reported as such. */
  skipped: string[]
  /**
   * Rows whose conversation another LIVE session is already driving, each NAMING that session.
   *
   * Its own bucket rather than another `skipped`, because the two ask for different things from the
   * person reading them: a skip is "this could not be done", and this is "this is already done, over
   * there" — and it is only useful if it says WHERE. It is also not `already`, which means the row
   * itself is up; here the row is down and its conversation is up under another name, which is
   * precisely the case no counter could previously express.
   */
  heldElsewhere: TaskReopenHeld[]
}

export function planTaskReopen(o: {
  entries: readonly ManagedSession[]
  /** Ids the backend reports as alive right now. */
  liveIds: ReadonlySet<string>
  /** The conversation to resume for a row, or `null` when none can be resolved. */
  conversationFor: (entry: ManagedSession) => { sessionId: string; title: string } | null
  /**
   * Conversation id → the live session driving it, from `conversationsInUse`.
   *
   * Optional so a caller with no way to establish it degrades to the old behaviour rather than
   * locking every conversation it cannot see. Absent is "we do not know", never "nothing is live".
   */
  inUse?: ReadonlyMap<string, ConversationHolder>
}): TaskReopenPlan {
  const plan: TaskReopenPlan = { reopen: [], already: [], skipped: [], heldElsewhere: [] }
  const inUse = o.inUse ?? new Map<string, ConversationHolder>()
  // One conversation, at most one row in `plan.reopen` — see the header. Only conversations this
  // plan actually decided to REOPEN go in here; one that was refused into `heldElsewhere` claims
  // nothing, so a later row resolving to a genuinely different conversation is still free.
  const claimed = new Set<string>()
  for (const entry of o.entries) {
    // Ending a session is a decision; "open the task" must not quietly undo every one of them.
    if (entry.endedAt) continue
    if (o.liveIds.has(entry.id)) { plan.already.push(entry.id); continue }
    const conv = o.conversationFor(entry)
    if (!conv) { plan.skipped.push(entry.id); continue }
    // A falsy id (`''`) is never claimed and never checked against a claim — see the header. Only a
    // genuine id can collide with another genuine id.
    if (conv.sessionId && claimed.has(conv.sessionId)) { plan.skipped.push(entry.id); continue }
    // Checked AFTER the conversation is resolved, and against THAT conversation rather than the
    // row's recorded one: the resolver is what decides which conversation this reopen would
    // actually open, so it is the only id whose being taken means anything.
    const holder = conversationHeldBy(inUse, conv.sessionId, entry.id)
    if (holder) { plan.heldElsewhere.push({ id: entry.id, holder }); continue }
    if (conv.sessionId) claimed.add(conv.sessionId)
    plan.reopen.push({ entry, resumeId: conv.sessionId, label: entry.label ?? conv.title })
  }
  return plan
}

/**
 * Whether the whole thing worked out: something came back, or something was already up.
 *
 * A conversation already open elsewhere counts as up. Nothing is missing after such a reopen — the
 * work is on screen, under another row — and reporting the gesture as a FAILURE would send someone
 * looking for a problem that the refusal just prevented.
 */
export function taskReopenSucceeded(plan: TaskReopenPlan, started: number): boolean {
  return started > 0 || plan.already.length > 0 || plan.heldElsewhere.length > 0
}

/**
 * The check made a SECOND time, right before actually spawning — PURE.
 *
 * `plan.reopen` is built from a snapshot: the registry and the backend as they were at the START of
 * the call. A concurrent reopen for the SAME conversation (a double click, two tabs, two crash-group
 * calls racing each other) can read that same snapshot before either has spawned or retired
 * anything, and both would then plan to open it. The caller re-reads the registry and the alive ids
 * FRESH, under a per-conversation lock (`resume-lock.ts`), and asks this question with that fresher
 * answer: has somebody else's attempt — for this same conversation, by any route — already landed?
 *
 * `excludeId` is the row being replaced. It is never held by its own reopen: a row about to be
 * retired is not yet ended at the moment this runs, and refusing the very gesture it exists to
 * perform is a lock nobody keeps.
 */
export function conversationAlreadyOpen(
  freshEntries: readonly ManagedSession[],
  aliveIds: ReadonlySet<string>,
  resumeId: string,
  excludeId: string,
): boolean {
  return freshEntries.some(e =>
    e.id !== excludeId && !e.endedAt && e.conversationId === resumeId && aliveIds.has(e.id))
}
