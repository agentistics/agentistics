/**
 * taskThreads.ts — Agentask THREADS: topics on a task, and the owner's 1:N reply. Pure.
 *
 * A thread is a TOPIC opened on a task, a subtask group or a subtask — by the person, or by a session
 * (only for a `handback` or a `block`). Comments are posted INTO it (`TaskComment.threadId`); a
 * comment with no `threadId` is a "loose" comment, which is how every comment written before threads
 * existed reads — the migration is additive, a missing field and nothing else.
 *
 * ## The owner's rules (2026-10-04), and what each one means here
 *
 * 1. A session that needs an answer asks in ITS OWN chat, as it always did. The thread only MIRRORS
 *    that: `threadMirrors` names the participants that posted here and are now waiting in their own
 *    chat, so the page can show the question beside the thread. Answering in either place answers
 *    both — the answer is ONE fleet prompt, delivered once, and recorded once in the thread.
 * 2. A thread never blocks a session. Nothing here gates anything; a reply is extra context.
 * 3. There is NO bell for threads. `threadAttention` is a VISUAL state the page draws, never a
 *    notification — the only attention signal stays the session's own.
 * 4. The 1:N reply is the convenience: ONE message to N sessions (`planThreadFanout`).
 *
 * ## Delivery is honest
 *
 * A reply's `deliveries` say, per participant, what actually happened: `delivered` (the fleet prompt
 * confirmed it), `queued` (the session is not running, or is sitting on a dialog — it is delivered when
 * it next can take a prompt, e.g. after a reopen; nothing is reopened FOR it), `undeliverable` (an
 * external assistant agentop cannot type into, or a participant nobody can resolve), `muted` (the
 * owner muted that session in this thread), or `failed` (the send was refused — the reason is kept).
 * There is no "read" receipt: nothing here can observe a session reading, and a claim it cannot back
 * is the confident zero this product refuses everywhere.
 *
 * Participants are keyed by SESSION id and carry the CONVERSATION id, because reopening a session
 * mints a new row id for the same conversation — matching by conversation is what makes "delivered
 * on reopen" find the continuation rather than the retired row.
 */

export type ThreadKind = 'topic' | 'handback' | 'block'

/** The kinds a SESSION may open a thread with. A person may open any. */
export const SESSION_THREAD_KINDS: readonly ThreadKind[] = ['handback', 'block']

export function canSessionOpenThread(kind: ThreadKind): boolean {
  return SESSION_THREAD_KINDS.includes(kind)
}

export interface ThreadParticipant {
  /** The managed session id (verified — see `session-identity.ts` on the server). */
  sessionId: string
  /** The conversation it hosts, when known — what a reopened row is matched by. */
  conversationId?: string
  /** A display name at the time it joined (the session's title). */
  label?: string
  harness?: string
  joinedAt: string
}

export interface TaskThreadRecord {
  id: string
  taskId: string
  /** The subtask or group it was opened on; absent = the task itself. */
  subtaskId?: string
  title: string
  kind: ThreadKind
  /** Free text: the person's name, or the session's label. */
  openedBy: string
  /** Set when a session opened it. */
  openedBySession?: string
  createdAt: string
  /** Set while resolved; a new comment clears it. */
  resolvedAt?: string
  participants: ThreadParticipant[]
  /** Session ids the owner muted in this thread: the 1:N reply skips them. */
  mutedSessions?: string[]
}

export type DeliveryState = 'delivered' | 'queued' | 'undeliverable' | 'muted' | 'failed'

export interface ThreadDelivery {
  sessionId: string
  conversationId?: string
  state: DeliveryState
  /** Why it is not `delivered` — a code the page localizes. */
  reason?: DeliveryReason
  /** The fleet's own sentence when a send was refused. */
  detail?: string
  at: string
}

export type DeliveryReason =
  | 'not-running'
  | 'dialog-open'
  | 'external'
  | 'unknown-session'
  | 'muted'
  | 'refused'

/** The fields this module reads off a comment. */
export interface ThreadCommentLike {
  id: string
  createdAt: string
  threadId?: string
  /** Set when a VERIFIED session posted it. */
  sessionId?: string
  /** `owner` = the person wrote it; `session` = a verified session did. Absent = unknown (legacy). */
  role?: 'owner' | 'session'
  /** For an owner comment written to ONE session (a mirror answer) — the session it went to. */
  answerTo?: string
  deliveries?: ThreadDelivery[]
  body: string
  author: string
}

/** The fields this module reads off a fleet row. A structural subset of `ControlSession`. */
export interface FleetRowLike {
  id: string
  conversationId?: string
  state: string
  /** False for an external assistant agentop does not host. */
  actionable: boolean
}

const LIVE = new Set(['working', 'waiting', 'waiting-approval'])

/** Is the row a session that is running right now? */
export function rowRunning(row: Pick<FleetRowLike, 'state'>): boolean {
  return LIVE.has(row.state)
}

/**
 * The fleet row standing for a participant now: its own id first, then the newest row hosting the
 * same conversation (a reopen). A running row wins over a dead one when both match.
 */
export function rowForParticipant<R extends FleetRowLike>(
  p: Pick<ThreadParticipant, 'sessionId' | 'conversationId'>,
  rows: readonly R[],
): R | undefined {
  const matches = rows.filter(r => r.id === p.sessionId || (!!p.conversationId && r.conversationId === p.conversationId))
  return matches.find(rowRunning) ?? matches.find(r => r.id === p.sessionId) ?? matches[0]
}

export interface FanoutStep {
  sessionId: string
  conversationId?: string
  /** The row to type into — present only for `send`. */
  rowId?: string
  action: 'send' | 'queue' | 'skip'
  /** For `queue` / `skip`: the delivery state recorded and why. */
  state?: DeliveryState
  reason?: DeliveryReason
}

/**
 * What the 1:N reply does for each participant. `exclude` is a session that must not receive its own
 * message (none today — only the owner fans out — but the guard costs nothing).
 *
 * - muted → skip (`muted`);
 * - a running HOSTED row that is not on a dialog → send;
 * - a running row on a permission dialog → queue (`dialog-open`): typing into a dialog takes whatever
 *   option is highlighted, so it waits until the dialog is gone — in the session, answered there;
 * - a running EXTERNAL row → skip (`external`): agentop cannot type into it;
 * - a hosted row that is not running, or a conversation with no row → queue (`not-running`): it is
 *   delivered when the conversation is reopened, never by reopening it;
 * - nothing to match at all → skip (`unknown-session`).
 */
export function planThreadFanout(
  participants: readonly ThreadParticipant[],
  rows: readonly FleetRowLike[],
  muted: readonly string[] = [],
  exclude?: string,
): FanoutStep[] {
  const out: FanoutStep[] = []
  const seen = new Set<string>()
  for (const p of participants) {
    if (p.sessionId === exclude || seen.has(p.sessionId)) continue
    seen.add(p.sessionId)
    const base = { sessionId: p.sessionId, ...(p.conversationId ? { conversationId: p.conversationId } : {}) }
    if (muted.includes(p.sessionId)) {
      out.push({ ...base, action: 'skip', state: 'muted', reason: 'muted' })
      continue
    }
    const row = rowForParticipant(p, rows)
    if (!row) {
      out.push(p.conversationId
        ? { ...base, action: 'queue', state: 'queued', reason: 'not-running' }
        : { ...base, action: 'skip', state: 'undeliverable', reason: 'unknown-session' })
      continue
    }
    if (rowRunning(row)) {
      if (!row.actionable) out.push({ ...base, action: 'skip', state: 'undeliverable', reason: 'external' })
      else if (row.state === 'waiting-approval') out.push({ ...base, action: 'queue', state: 'queued', reason: 'dialog-open' })
      else out.push({ ...base, rowId: row.id, action: 'send' })
      continue
    }
    out.push(row.actionable
      ? { ...base, action: 'queue', state: 'queued', reason: 'not-running' }
      : { ...base, action: 'skip', state: 'undeliverable', reason: 'external' })
  }
  return out
}

/**
 * Which QUEUED deliveries can go now: the participant's row is running, hosted, and not on a dialog.
 * Returns the row each one is typed into.
 */
export function planQueuedFlush(
  queued: readonly Pick<ThreadDelivery, 'sessionId' | 'conversationId'>[],
  rows: readonly FleetRowLike[],
): { sessionId: string; rowId: string }[] {
  const out: { sessionId: string; rowId: string }[] = []
  for (const q of queued) {
    const row = rowForParticipant(q, rows)
    if (!row || !rowRunning(row) || !row.actionable || row.state === 'waiting-approval') continue
    out.push({ sessionId: q.sessionId, rowId: row.id })
  }
  return out
}

/** The text a participant receives: one header line naming where it came from, then the reply. */
export function threadDeliveryText(o: { taskTitle: string; threadTitle: string; body: string }): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  return `[Agentask · ${clip(o.taskTitle, 60)} · thread "${clip(o.threadTitle, 60)}" · reply from the owner]\n${o.body}`
}

/** Counts per delivery state — the "entregue a N sessões" line. */
export function deliverySummary(ds: readonly ThreadDelivery[] | undefined): Record<DeliveryState, number> & { total: number } {
  const r = { delivered: 0, queued: 0, undeliverable: 0, muted: 0, failed: 0, total: 0 }
  for (const d of ds ?? []) { r[d.state]++; r.total++ }
  return r
}

/** A thread's comments, oldest first. */
export function threadComments<C extends ThreadCommentLike>(comments: readonly C[], threadId: string): C[] {
  return comments.filter(c => c.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Comments that belong to no thread — the "loose" bucket. */
export function looseComments<C extends ThreadCommentLike>(comments: readonly C[]): C[] {
  return comments.filter(c => !c.threadId)
}

/**
 * The participants that posted in this thread and are now WAITING in their own chat, with nothing
 * from the owner since their last post here — the questions the thread mirrors. The page shows each
 * one's own question (read from its chat) and lets it be answered once, in either place.
 */
export function threadMirrors(
  thread: Pick<TaskThreadRecord, 'participants' | 'resolvedAt'>,
  comments: readonly ThreadCommentLike[],
  rows: readonly FleetRowLike[],
): { sessionId: string; rowId: string; approval: boolean }[] {
  if (thread.resolvedAt) return []
  const out: { sessionId: string; rowId: string; approval: boolean }[] = []
  for (const p of thread.participants) {
    const row = rowForParticipant(p, rows)
    if (!row || (row.state !== 'waiting' && row.state !== 'waiting-approval')) continue
    if (!sessionAwaitsOwner(p.sessionId, comments)) continue
    out.push({ sessionId: p.sessionId, rowId: row.id, approval: row.state === 'waiting-approval' })
  }
  return out
}

/** Has `sessionId` posted here more recently than the owner wrote to it (a reply to all, or to it)? */
export function sessionAwaitsOwner(sessionId: string, comments: readonly ThreadCommentLike[]): boolean {
  let lastSession = ''
  let lastOwner = ''
  for (const c of comments) {
    if (c.role === 'session' && c.sessionId === sessionId && c.createdAt > lastSession) lastSession = c.createdAt
    if (c.role === 'owner' && (!c.answerTo || c.answerTo === sessionId) && c.createdAt > lastOwner) lastOwner = c.createdAt
  }
  return lastSession !== '' && lastSession > lastOwner
}

export type ThreadAttention = 'awaiting' | 'open' | 'resolved'

/**
 * The thread's VISUAL state — never a notification. `awaiting`: some participant posted after the
 * owner's last word to it. A muted participant does not make a thread await anything.
 */
export function threadAttention(
  thread: Pick<TaskThreadRecord, 'participants' | 'resolvedAt' | 'mutedSessions'>,
  comments: readonly ThreadCommentLike[],
): ThreadAttention {
  if (thread.resolvedAt) return 'resolved'
  const muted = new Set(thread.mutedSessions ?? [])
  const posters = new Set(comments.filter(c => c.role === 'session' && c.sessionId).map(c => c.sessionId!))
  for (const s of posters) if (!muted.has(s) && sessionAwaitsOwner(s, comments)) return 'awaiting'
  return 'open'
}

export interface ThreadSummary<C extends ThreadCommentLike> {
  thread: TaskThreadRecord
  attention: ThreadAttention
  count: number
  last?: C
}

/** The inbox: every thread with its state, newest activity first inside each state. */
export function threadInbox<C extends ThreadCommentLike>(
  threads: readonly TaskThreadRecord[],
  comments: readonly C[],
): { awaiting: ThreadSummary<C>[]; open: ThreadSummary<C>[]; resolved: ThreadSummary<C>[] } {
  const rows = threads.map(t => {
    const cs = threadComments(comments, t.id)
    return { thread: t, attention: threadAttention(t, cs), count: cs.length, ...(cs.length ? { last: cs[cs.length - 1] } : {}) }
  })
  const at = (s: ThreadSummary<C>) => s.last?.createdAt ?? s.thread.createdAt
  const by = (a: ThreadSummary<C>, b: ThreadSummary<C>) => at(b).localeCompare(at(a)) || a.thread.id.localeCompare(b.thread.id)
  return {
    awaiting: rows.filter(r => r.attention === 'awaiting').sort(by),
    open: rows.filter(r => r.attention === 'open').sort(by),
    resolved: rows.filter(r => r.attention === 'resolved').sort(by),
  }
}

/** Add a participant once (by session id), refreshing its conversation link when it gained one. */
export function withParticipant(list: readonly ThreadParticipant[], p: ThreadParticipant): ThreadParticipant[] {
  const i = list.findIndex(x => x.sessionId === p.sessionId)
  if (i === -1) return [...list, p]
  const cur = list[i]!
  if (!cur.conversationId && p.conversationId) {
    const next = [...list]
    next[i] = { ...cur, conversationId: p.conversationId }
    return next
  }
  return [...list]
}
