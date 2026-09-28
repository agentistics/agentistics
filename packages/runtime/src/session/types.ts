/**
 * session/types.ts — the records B4.1 persists and the `SessionStore` interface every backing store
 * (today `sqlite-store.ts`; a test's in-memory double) implements (spec §2, §24.5).
 *
 * ## Acceptance §24.5, restated as a contract
 *
 * - **No whole-history load, ever.** `listMessages` is a WINDOW (`before`/`limit`, clamped) and
 *   returns `nextBefore`; there is no method that returns every message of a session. `listSessions`
 *   is paged the same way.
 * - **A message BODY and an attachment's BYTES never sit inside a session record.** `MessageRecord`
 *   carries a `ContentRef` (`{sha256, bytes}`) into the content store, never the text; `AttachmentRef`
 *   is the same shape for a file's bytes. A store that inlined the body would defeat the whole point
 *   of a window read — the window would still have to hold every byte to answer `before`.
 *
 * ## Message `seq`
 *
 * 1-based, dense, per session. Dense means "no missing numbers", which only holds if the number is
 * assigned INSIDE the same transaction that inserts the row — two concurrent appends racing to read
 * `lastSeq` and both computing `n+1` would either collide (a duplicate seq) or skip one (a gap the
 * window read would then silently paper over as "nothing happened between these two turns").
 * `sqlite-store.ts`'s `appendMessage` is where that transaction lives; this file only states the
 * invariant the transaction exists to keep.
 *
 * ## The lease
 *
 * `decideLeaseAcquire` is the ONE place "is this session free to drive" is decided, and it is pure:
 * given the CURRENT lease (or none), a candidate holder, the clock and an injected `isAlive(pid)`, it
 * says yes or names the current holder. `sqlite-store.ts` calls it inside a transaction that reads the
 * row, decides, and writes the result — the decision itself needs no I/O, which is what makes it
 * testable without a database and without a real process to kill.
 */

import type { ProviderId, RunStatus } from '@agentistics/core'
import type { CredentialRef } from '../provider/credential.ts'
import type { ContentRef } from '../tools/contract.ts'
import type { ToolLoopStatus } from '../loop/loop.ts'

// ── Session ─────────────────────────────────────────────────────────────────────────────────────

export type SessionStatus = 'open' | 'ended' | 'failed'

export interface SessionRecord {
  sessionId: string
  createdAt: string
  updatedAt: string
  status: SessionStatus
  title?: string
  workspaceRoot: string
  cwd: string
  provider: ProviderId
  model: string
  /** An id, never a key (D-T… same rule as everywhere else a credential is named). */
  credential: CredentialRef
  messageCount: number
  lastSeq: number
  runCount: number
  lastRunId?: string
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────

export interface RunRecord {
  runId: string
  sessionId: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  /** The loop's own stop reason — absent while `status === 'running'`. */
  stop?: ToolLoopStatus
  sentence?: string
  turns: number
  toolCalls: number
}

// ── Message (refs only) ────────────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant'

export interface MessageRecord {
  sessionId: string
  /** 1-based, dense, per session — see module doc. */
  seq: number
  runId: string
  role: MessageRole
  /** The body lives in the content store; this is a reference to it. */
  content: ContentRef
  createdAt: string
}

export interface AppendMessageInput {
  sessionId: string
  runId: string
  role: MessageRole
  content: ContentRef
  createdAt: string
}

// ── Attachment (bytes live in the content store) ────────────────────────────────────────────────

export interface AttachmentRef {
  storageId: string
  mime: string
  size: number
  sha256: string
  name?: string
}

export interface AttachmentRecord extends AttachmentRef {
  sessionId: string
  createdAt: string
}

// ── Tool calls (started/settled) ────────────────────────────────────────────────────────────────

export type ToolCallState = 'started' | 'settled'

export interface ToolCallRecord {
  runId: string
  toolExecutionId: string
  toolUseId: string
  name: string
  state: ToolCallState
  /** The modelText the model read, in the content store — present once the call has settled. */
  result?: ContentRef
  isError?: boolean
}

export interface RecordToolCallInput {
  runId: string
  toolExecutionId: string
  toolUseId: string
  name: string
  state: ToolCallState
  result?: ContentRef
  isError?: boolean
}

// ── Lease ───────────────────────────────────────────────────────────────────────────────────────

export interface LeaseHolder {
  /** The driving process's pid. */
  pid: number
  /** A random token, so a pid REUSED by an unrelated process after a crash cannot claim the lease. */
  token: string
}

export interface Lease {
  sessionId: string
  holder: LeaseHolder
  expiresAt: string
}

export type LeaseAcquireResult =
  | { ok: true; lease: Lease }
  | {
      ok: false
      reason: 'held'
      holder: LeaseHolder
      expiresAt: string
      /** For a person or a log — never parsed back. */
      sentence: string
    }

/**
 * PURE: may `holder` drive `sessionId` right now? A lease is free to take when there is none yet,
 * when the stored one has EXPIRED, when it is already held by this exact `(pid, token)` (a refresh),
 * or when the holder's pid is no longer alive (`isAlive`, injected — never a real process check
 * here). Otherwise the current holder is named in a refusal, never silently overwritten.
 */
export function decideLeaseAcquire(
  sessionId: string,
  current: Lease | null,
  holder: LeaseHolder,
  nowMs: number,
  ttlMs: number,
  isAlive: (pid: number) => boolean,
): LeaseAcquireResult {
  if (current) {
    const expired = Date.parse(current.expiresAt) <= nowMs
    const sameHolder = current.holder.pid === holder.pid && current.holder.token === holder.token
    if (!expired && !sameHolder && isAlive(current.holder.pid)) {
      return {
        ok: false,
        reason: 'held',
        holder: current.holder,
        expiresAt: current.expiresAt,
        sentence: `This session is already being driven by pid ${current.holder.pid} until ${current.expiresAt}.`,
      }
    }
  }
  return { ok: true, lease: { sessionId, holder, expiresAt: new Date(nowMs + ttlMs).toISOString() } }
}

// ── Windowed reads — the clamp (§2: "limit is clamped, max 200") ───────────────────────────────

export const MAX_MESSAGES_WINDOW = 200
export const DEFAULT_MESSAGES_WINDOW = 50
export const MAX_SESSIONS_PAGE = 200
export const DEFAULT_SESSIONS_PAGE = 50

/** A non-finite, non-positive or absent limit reads as the default — never zero, never unbounded. */
export function clampMessagesLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_MESSAGES_WINDOW
  return Math.min(Math.floor(limit), MAX_MESSAGES_WINDOW)
}

export function clampSessionsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_SESSIONS_PAGE
  return Math.min(Math.floor(limit), MAX_SESSIONS_PAGE)
}

export interface ListMessagesOptions {
  /** Newest messages with `seq < before`. Absent = the newest ones. */
  before?: number
  limit?: number
}

export interface ListMessagesResult {
  /** Ascending by `seq`. */
  messages: MessageRecord[]
  /** Absent when there is nothing older — never a sentinel number. */
  nextBefore?: number
}

export interface ListSessionsOptions {
  limit?: number
  /** Sessions created before this cursor (a `createdAt` ISO string paired with the session id it
   *  belongs to, `"<createdAt>|<sessionId>"`) — see `sqlite-store.ts` for the exact encoding. */
  before?: string
}

export interface ListSessionsResult {
  /** Newest first. */
  sessions: SessionRecord[]
  nextBefore?: string
}

// ── The store ───────────────────────────────────────────────────────────────────────────────────

export interface SessionStore {
  createSession(session: SessionRecord): Promise<void>
  getSession(sessionId: string): Promise<SessionRecord | null>
  updateSession(sessionId: string, patch: Partial<Omit<SessionRecord, 'sessionId'>>): Promise<void>
  listSessions(opts: ListSessionsOptions): Promise<ListSessionsResult>

  createRun(run: RunRecord): Promise<void>
  getRun(runId: string): Promise<RunRecord | null>
  updateRun(runId: string, patch: Partial<Omit<RunRecord, 'runId' | 'sessionId'>>): Promise<void>
  /** The most recently started run of a session, or `null` when it has none yet. */
  latestRun(sessionId: string): Promise<RunRecord | null>

  /** Assigns the next dense `seq` inside one transaction and returns the stored record. */
  appendMessage(input: AppendMessageInput): Promise<MessageRecord>
  listMessages(sessionId: string, opts: ListMessagesOptions): Promise<ListMessagesResult>

  addAttachment(rec: AttachmentRecord): Promise<void>
  listAttachments(sessionId: string): Promise<AttachmentRecord[]>

  /** Upserts by `(runId, toolExecutionId)` — a `settled` row replaces its `started` one. */
  recordToolCall(input: RecordToolCallInput): Promise<void>
  listToolCalls(runId: string): Promise<ToolCallRecord[]>

  acquireLease(sessionId: string, holder: LeaseHolder, ttlMs: number): Promise<LeaseAcquireResult>
  refreshLease(sessionId: string, holder: LeaseHolder, ttlMs: number): Promise<LeaseAcquireResult>
  /** A no-op when `holder` does not hold the current lease — releasing is never a way to steal it. */
  releaseLease(sessionId: string, holder: LeaseHolder): Promise<void>
  getLease(sessionId: string): Promise<Lease | null>

  close(): void
}
