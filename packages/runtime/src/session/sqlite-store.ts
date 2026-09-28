/**
 * session/sqlite-store.ts — `openSqliteSessionStore(path)`: the `SessionStore` on `bun:sqlite`. The
 * host passes the path (D23: the runtime holds no path of its own — `runtime-host.ts`'s job, not this
 * module's). WAL + a `busy_timeout` are set once at open, mirroring the A1 journal's own reasoning
 * (`journal/journal.ts`): a deferred `BEGIN` upgrades on the first write and two connections doing
 * that at once can dead-end in a `SQLITE_BUSY` a bare retry cannot resolve on its own, so every
 * multi-statement change here goes through `db.transaction()`, which Bun executes synchronously —
 * there is no `await` between the read and the write it decides from, so a "concurrent" caller
 * (several `appendMessage`/`acquireLease` calls fired without awaiting each other) can never
 * interleave inside one transaction's body.
 *
 * ## Dense `seq`
 *
 * `appendMessage` reads the session's `last_seq`, computes `seq = last_seq + 1`, inserts the message
 * row and bumps `last_seq` — all inside ONE transaction, which is what makes "dense" hold under
 * concurrent callers rather than merely under a single caller's good behaviour.
 *
 * ## The lease
 *
 * `acquireLease`/`refreshLease` both read the current row, ask the PURE `decideLeaseAcquire`
 * (`types.ts`) — with the store's own `isAlive` closure — and write the answer back, inside one
 * transaction. `refreshLease` is the identical operation: the pure decision already treats "the same
 * holder asking again" as a free lease (a renewal), so a second store method would only be a second
 * name for the same rule.
 */

import { Database } from 'bun:sqlite'
import type { ContentRef } from '../tools/contract.ts'
import {
  clampMessagesLimit,
  clampSessionsLimit,
  decideLeaseAcquire,
  type AppendMessageInput,
  type AttachmentRecord,
  type Lease,
  type LeaseAcquireResult,
  type LeaseHolder,
  type ListMessagesOptions,
  type ListMessagesResult,
  type ListSessionsOptions,
  type ListSessionsResult,
  type MessageRecord,
  type RecordToolCallInput,
  type RunRecord,
  type SessionRecord,
  type SessionStore,
  type ToolCallRecord,
} from './types.ts'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  status         TEXT NOT NULL,
  title          TEXT,
  workspace_root TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  credential_json TEXT NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 0,
  last_seq       INTEGER NOT NULL DEFAULT 0,
  run_count      INTEGER NOT NULL DEFAULT 0,
  last_run_id    TEXT
);
CREATE INDEX IF NOT EXISTS sessions_created_idx ON sessions(created_at, session_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id     TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL,
  stop       TEXT,
  sentence   TEXT,
  turns      INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id, started_at);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  run_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS attachments (
  session_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, storage_id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  run_id            TEXT NOT NULL,
  tool_execution_id TEXT NOT NULL,
  tool_use_id       TEXT NOT NULL,
  name              TEXT NOT NULL,
  state             TEXT NOT NULL,
  result_sha256     TEXT,
  result_bytes      INTEGER,
  is_error          INTEGER,
  PRIMARY KEY (run_id, tool_execution_id)
);

CREATE TABLE IF NOT EXISTS leases (
  session_id   TEXT PRIMARY KEY,
  holder_pid   INTEGER NOT NULL,
  holder_token TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
`

interface SessionRow {
  session_id: string
  created_at: string
  updated_at: string
  status: string
  title: string | null
  workspace_root: string
  cwd: string
  provider: string
  model: string
  credential_json: string
  message_count: number
  last_seq: number
  run_count: number
  last_run_id: string | null
}

function rowToSession(r: SessionRow): SessionRecord {
  const rec: SessionRecord = {
    sessionId: r.session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status as SessionRecord['status'],
    workspaceRoot: r.workspace_root,
    cwd: r.cwd,
    provider: r.provider as SessionRecord['provider'],
    model: r.model,
    credential: JSON.parse(r.credential_json) as SessionRecord['credential'],
    messageCount: r.message_count,
    lastSeq: r.last_seq,
    runCount: r.run_count,
  }
  if (r.title !== null) rec.title = r.title
  if (r.last_run_id !== null) rec.lastRunId = r.last_run_id
  return rec
}

interface RunRow {
  run_id: string
  session_id: string
  started_at: string
  ended_at: string | null
  status: string
  stop: string | null
  sentence: string | null
  turns: number
  tool_calls: number
}

function rowToRun(r: RunRow): RunRecord {
  const rec: RunRecord = {
    runId: r.run_id,
    sessionId: r.session_id,
    startedAt: r.started_at,
    status: r.status as RunRecord['status'],
    turns: r.turns,
    toolCalls: r.tool_calls,
  }
  if (r.ended_at !== null) rec.endedAt = r.ended_at
  if (r.stop !== null) rec.stop = r.stop as RunRecord['stop']
  if (r.sentence !== null) rec.sentence = r.sentence
  return rec
}

interface MessageRow {
  session_id: string
  seq: number
  run_id: string
  role: string
  sha256: string
  bytes: number
  created_at: string
}

function rowToMessage(r: MessageRow): MessageRecord {
  return {
    sessionId: r.session_id,
    seq: r.seq,
    runId: r.run_id,
    role: r.role as MessageRecord['role'],
    content: { sha256: r.sha256, bytes: r.bytes },
    createdAt: r.created_at,
  }
}

interface AttachmentRow {
  session_id: string
  storage_id: string
  mime: string
  size: number
  sha256: string
  name: string | null
  created_at: string
}

function rowToAttachment(r: AttachmentRow): AttachmentRecord {
  const rec: AttachmentRecord = {
    sessionId: r.session_id,
    storageId: r.storage_id,
    mime: r.mime,
    size: r.size,
    sha256: r.sha256,
    createdAt: r.created_at,
  }
  if (r.name !== null) rec.name = r.name
  return rec
}

interface ToolCallRow {
  run_id: string
  tool_execution_id: string
  tool_use_id: string
  name: string
  state: string
  result_sha256: string | null
  result_bytes: number | null
  is_error: number | null
}

function rowToToolCall(r: ToolCallRow): ToolCallRecord {
  const rec: ToolCallRecord = {
    runId: r.run_id,
    toolExecutionId: r.tool_execution_id,
    toolUseId: r.tool_use_id,
    name: r.name,
    state: r.state as ToolCallRecord['state'],
  }
  if (r.result_sha256 !== null && r.result_bytes !== null) {
    rec.result = { sha256: r.result_sha256, bytes: r.result_bytes }
  }
  if (r.is_error !== null) rec.isError = r.is_error !== 0
  return rec
}

interface LeaseRow {
  session_id: string
  holder_pid: number
  holder_token: string
  expires_at: string
}

function rowToLease(r: LeaseRow): Lease {
  return { sessionId: r.session_id, holder: { pid: r.holder_pid, token: r.holder_token }, expiresAt: r.expires_at }
}

/** `"<createdAt>|<sessionId>"` — `createdAt` is an ISO string (no `|`), so the first `|` is exact. */
function encodeSessionsCursor(createdAt: string, sessionId: string): string {
  return `${createdAt}|${sessionId}`
}
function decodeSessionsCursor(cursor: string): { createdAt: string; sessionId: string } {
  const i = cursor.indexOf('|')
  return i < 0 ? { createdAt: cursor, sessionId: '' } : { createdAt: cursor.slice(0, i), sessionId: cursor.slice(i + 1) }
}

const SESSION_PATCH_COLUMNS: Record<string, string> = {
  updatedAt: 'updated_at',
  status: 'status',
  title: 'title',
  workspaceRoot: 'workspace_root',
  cwd: 'cwd',
  provider: 'provider',
  model: 'model',
  credential: 'credential_json',
  messageCount: 'message_count',
  lastSeq: 'last_seq',
  runCount: 'run_count',
  lastRunId: 'last_run_id',
}

const RUN_PATCH_COLUMNS: Record<string, string> = {
  startedAt: 'started_at',
  endedAt: 'ended_at',
  status: 'status',
  stop: 'stop',
  sentence: 'sentence',
  turns: 'turns',
  toolCalls: 'tool_calls',
}

function encodedValue(key: string, value: unknown): unknown {
  if (key === 'credential') return JSON.stringify(value)
  if (value === undefined) return null
  return value
}

export interface SqliteSessionStoreOptions {
  /** Whether a pid is still alive — injected so a test never has to kill a real process. Default:
   *  always alive (a lease is freed only by expiry or by its own holder, never by a guess). */
  isAlive?: (pid: number) => boolean
  now?: () => Date
}

export function openSqliteSessionStore(path: string, opts: SqliteSessionStoreOptions = {}): SessionStore {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA_SQL)

  const isAlive = opts.isAlive ?? (() => true)
  const now = opts.now ?? (() => new Date())

  const insertSessionStmt = db.prepare(
    `INSERT INTO sessions
      (session_id, created_at, updated_at, status, title, workspace_root, cwd, provider, model,
       credential_json, message_count, last_seq, run_count, last_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE session_id = ?')
  const insertRunStmt = db.prepare(
    `INSERT INTO runs (run_id, session_id, started_at, ended_at, status, stop, sentence, turns, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const bumpRunCountStmt = db.prepare(
    'UPDATE sessions SET run_count = run_count + 1, last_run_id = ?, updated_at = ? WHERE session_id = ?',
  )
  const getRunStmt = db.prepare('SELECT * FROM runs WHERE run_id = ?')
  const latestRunStmt = db.prepare(
    'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
  )

  const insertMessageStmt = db.prepare(
    'INSERT INTO messages (session_id, seq, run_id, role, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const bumpMessageStmt = db.prepare(
    'UPDATE sessions SET last_seq = ?, message_count = message_count + 1, updated_at = ? WHERE session_id = ?',
  )
  const olderMessageExistsStmt = db.prepare(
    'SELECT 1 FROM messages WHERE session_id = ? AND seq < ? LIMIT 1',
  )

  const insertAttachmentStmt = db.prepare(
    'INSERT INTO attachments (session_id, storage_id, mime, size, sha256, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const listAttachmentsStmt = db.prepare('SELECT * FROM attachments WHERE session_id = ? ORDER BY rowid ASC')

  const upsertToolCallStmt = db.prepare(
    `INSERT INTO tool_calls
       (run_id, tool_execution_id, tool_use_id, name, state, result_sha256, result_bytes, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, tool_execution_id) DO UPDATE SET
       tool_use_id = excluded.tool_use_id,
       name = excluded.name,
       state = excluded.state,
       result_sha256 = excluded.result_sha256,
       result_bytes = excluded.result_bytes,
       is_error = excluded.is_error`,
  )
  const listToolCallsStmt = db.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY rowid ASC')

  const getLeaseStmt = db.prepare('SELECT * FROM leases WHERE session_id = ?')
  const upsertLeaseStmt = db.prepare(
    `INSERT INTO leases (session_id, holder_pid, holder_token, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       holder_pid = excluded.holder_pid, holder_token = excluded.holder_token, expires_at = excluded.expires_at`,
  )
  const deleteLeaseStmt = db.prepare('DELETE FROM leases WHERE session_id = ?')

  const appendMessageTx = db.transaction((input: AppendMessageInput): number => {
    const row = getSessionStmt.get(input.sessionId) as SessionRow | null
    if (!row) throw new Error(`session/sqlite-store: no such session ${input.sessionId}`)
    const seq = row.last_seq + 1
    insertMessageStmt.run(input.sessionId, seq, input.runId, input.role, input.content.sha256, input.content.bytes, input.createdAt)
    bumpMessageStmt.run(seq, input.createdAt, input.sessionId)
    return seq
  })

  const createRunTx = db.transaction((run: RunRecord): void => {
    insertRunStmt.run(
      run.runId, run.sessionId, run.startedAt, run.endedAt ?? null, run.status,
      run.stop ?? null, run.sentence ?? null, run.turns, run.toolCalls,
    )
    bumpRunCountStmt.run(run.runId, run.startedAt, run.sessionId)
  })

  const leaseTx = db.transaction((sessionId: string, holder: LeaseHolder, ttlMs: number, nowMs: number): LeaseAcquireResult => {
    const row = getLeaseStmt.get(sessionId) as LeaseRow | null
    const current = row ? rowToLease(row) : null
    const decision = decideLeaseAcquire(sessionId, current, holder, nowMs, ttlMs, isAlive)
    if (decision.ok) {
      upsertLeaseStmt.run(sessionId, decision.lease.holder.pid, decision.lease.holder.token, decision.lease.expiresAt)
    }
    return decision
  })

  const releaseLeaseTx = db.transaction((sessionId: string, holder: LeaseHolder): void => {
    const row = getLeaseStmt.get(sessionId) as LeaseRow | null
    if (row && row.holder_pid === holder.pid && row.holder_token === holder.token) deleteLeaseStmt.run(sessionId)
  })

  return {
    async createSession(session: SessionRecord): Promise<void> {
      insertSessionStmt.run(
        session.sessionId, session.createdAt, session.updatedAt, session.status, session.title ?? null,
        session.workspaceRoot, session.cwd, session.provider, session.model,
        JSON.stringify(session.credential), session.messageCount, session.lastSeq, session.runCount,
        session.lastRunId ?? null,
      )
    },

    async getSession(sessionId: string): Promise<SessionRecord | null> {
      const row = getSessionStmt.get(sessionId) as SessionRow | null
      return row ? rowToSession(row) : null
    },

    async updateSession(sessionId: string, patch: Partial<Omit<SessionRecord, 'sessionId'>>): Promise<void> {
      const sets: string[] = []
      const params: unknown[] = []
      for (const [key, value] of Object.entries(patch)) {
        const column = SESSION_PATCH_COLUMNS[key]
        if (!column) continue
        sets.push(`${column} = ?`)
        params.push(encodedValue(key, value))
      }
      if (!('updatedAt' in patch)) { sets.push('updated_at = ?'); params.push(now().toISOString()) }
      if (sets.length === 0) return
      params.push(sessionId)
      db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id = ?`).run(...(params as never[]))
    },

    async listSessions(opts): Promise<ListSessionsResult> {
      const limit = clampSessionsLimit(opts.limit)
      let rows: SessionRow[]
      if (opts.before !== undefined) {
        const c = decodeSessionsCursor(opts.before)
        rows = db.prepare(
          `SELECT * FROM sessions
           WHERE (created_at < ?) OR (created_at = ? AND session_id < ?)
           ORDER BY created_at DESC, session_id DESC LIMIT ?`,
        ).all(c.createdAt, c.createdAt, c.sessionId, limit) as SessionRow[]
      } else {
        rows = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC, session_id DESC LIMIT ?').all(limit) as SessionRow[]
      }
      const sessions = rows.map(rowToSession)
      let nextBefore: string | undefined
      if (sessions.length > 0) {
        const last = sessions[sessions.length - 1]!
        const older = db.prepare(
          `SELECT 1 FROM sessions WHERE (created_at < ?) OR (created_at = ? AND session_id < ?) LIMIT 1`,
        ).get(last.createdAt, last.createdAt, last.sessionId)
        if (older) nextBefore = encodeSessionsCursor(last.createdAt, last.sessionId)
      }
      return nextBefore === undefined ? { sessions } : { sessions, nextBefore }
    },

    async createRun(run: RunRecord): Promise<void> {
      createRunTx(run)
    },

    async getRun(runId: string): Promise<RunRecord | null> {
      const row = getRunStmt.get(runId) as RunRow | null
      return row ? rowToRun(row) : null
    },

    async updateRun(runId: string, patch: Partial<Omit<RunRecord, 'runId' | 'sessionId'>>): Promise<void> {
      const sets: string[] = []
      const params: unknown[] = []
      for (const [key, value] of Object.entries(patch)) {
        const column = RUN_PATCH_COLUMNS[key]
        if (!column) continue
        sets.push(`${column} = ?`)
        params.push(encodedValue(key, value))
      }
      if (sets.length === 0) return
      params.push(runId)
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...(params as never[]))
    },

    async latestRun(sessionId: string): Promise<RunRecord | null> {
      const row = latestRunStmt.get(sessionId) as RunRow | null
      return row ? rowToRun(row) : null
    },

    async appendMessage(input: AppendMessageInput): Promise<MessageRecord> {
      const seq = appendMessageTx(input)
      return { sessionId: input.sessionId, seq, runId: input.runId, role: input.role, content: input.content, createdAt: input.createdAt }
    },

    async listMessages(sessionId: string, opts: ListMessagesOptions): Promise<ListMessagesResult> {
      const limit = clampMessagesLimit(opts.limit)
      const before = opts.before ?? Number.MAX_SAFE_INTEGER
      const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      ).all(sessionId, before, limit) as MessageRow[]
      rows.reverse()
      const messages = rows.map(rowToMessage)
      let nextBefore: number | undefined
      if (messages.length > 0) {
        const oldestSeq = messages[0]!.seq
        const older = olderMessageExistsStmt.get(sessionId, oldestSeq)
        if (older) nextBefore = oldestSeq
      }
      return nextBefore === undefined ? { messages } : { messages, nextBefore }
    },

    async addAttachment(rec: AttachmentRecord): Promise<void> {
      insertAttachmentStmt.run(rec.sessionId, rec.storageId, rec.mime, rec.size, rec.sha256, rec.name ?? null, rec.createdAt)
    },

    async listAttachments(sessionId: string): Promise<AttachmentRecord[]> {
      return (listAttachmentsStmt.all(sessionId) as AttachmentRow[]).map(rowToAttachment)
    },

    async recordToolCall(input: RecordToolCallInput): Promise<void> {
      upsertToolCallStmt.run(
        input.runId, input.toolExecutionId, input.toolUseId, input.name, input.state,
        input.result?.sha256 ?? null, input.result?.bytes ?? null,
        input.isError === undefined ? null : (input.isError ? 1 : 0),
      )
    },

    async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
      return (listToolCallsStmt.all(runId) as ToolCallRow[]).map(rowToToolCall)
    },

    async acquireLease(sessionId: string, holder: LeaseHolder, ttlMs: number): Promise<LeaseAcquireResult> {
      return leaseTx(sessionId, holder, ttlMs, now().getTime())
    },

    async refreshLease(sessionId: string, holder: LeaseHolder, ttlMs: number): Promise<LeaseAcquireResult> {
      return leaseTx(sessionId, holder, ttlMs, now().getTime())
    },

    async releaseLease(sessionId: string, holder: LeaseHolder): Promise<void> {
      releaseLeaseTx(sessionId, holder)
    },

    async getLease(sessionId: string): Promise<Lease | null> {
      const row = getLeaseStmt.get(sessionId) as LeaseRow | null
      return row ? rowToLease(row) : null
    },

    close(): void {
      db.close()
    },
  }
}
