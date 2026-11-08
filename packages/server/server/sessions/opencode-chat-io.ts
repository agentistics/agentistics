/**
 * opencode-chat-io.ts — the IO behind `opencode-chat.ts`: one session's rows out of `opencode.db`, READ-ONLY.
 *
 * The "path" a reader is handed is `<db>#<ses_…>`: the store is one file for every session, and the session
 * is part of what was resolved. Opened `readonly` (never immutable, never a write, no checkpoint), so it sees
 * every committed WAL write without blocking opencode's own writer — the rule the metrics adapter keeps for
 * the same file. Only `session` / `message` / `part` are read; the store also holds credential tables, which
 * nothing here names. Every failure is `null`, never a throw.
 */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { ChatTurn } from '@agentistics/core'
import { chatRowsOfV2Messages, parseOpencodeChat, type OpencodeMessageRow, type OpencodePartRow } from './opencode-chat'
import { createOpencodeV2Client, opencodeStateDirFor, readServiceRecord } from '../adapters/opencode-v2'

const SESSION_ID = /^ses_[A-Za-z0-9]{20,40}$/

export function opencodeChatPath(dbPath: string, sessionId: string): string {
  return `${dbPath}#${sessionId}`
}

/** `<db>#<ses_…>` → its halves, or `null` for anything not shaped exactly like one. */
export function splitOpencodeChatPath(path: string): { dbPath: string; sessionId: string } | null {
  const at = path.lastIndexOf('#')
  if (at <= 0) return null
  const sessionId = path.slice(at + 1)
  return SESSION_ID.test(sessionId) ? { dbPath: path.slice(0, at), sessionId } : null
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T | null {
  if (!existsSync(dbPath)) return null
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    return fn(db)
  } catch { return null } finally { try { db?.close() } catch { /* ignore */ } }
}

/**
 * How a 2.x session's messages are fetched: through the background service's API (the house rule since
 * OPENCODE.V2: the 2.x tables are internals, the API is what opencode's own TUI reads). Injectable for tests.
 */
export interface OpencodeV2ChatSource { messages(id: string): Promise<unknown[]> }

function defaultV2Source(dbPath: string): OpencodeV2ChatSource | null {
  const service = readServiceRecord(opencodeStateDirFor(dbPath, process.env))
  return service ? createOpencodeV2Client(service, { timeoutMs: 4_000 }) : null
}

/** Does the store at `dbPath` hold this id as a 2.x session? `null` when it cannot tell (no such table). */
function inV2Table(dbPath: string, sessionId: string): boolean | null {
  return withDb(dbPath, db => {
    try { return db.query<{ id: string }, [string]>('SELECT id FROM session_v2 WHERE id = ?').get(sessionId) !== null } catch { return null }
  })
}

/** The chat path of a session the store HOLDS, or `null` — never a path for an id it does not know.
 *  1.x: the frozen `session` table. 2.x: `session_v2`, or — when that cannot be read — the service itself. */
export async function resolveOpencodeChat(dbPath: string, sessionId: string, v2: () => OpencodeV2ChatSource | null = () => defaultV2Source(dbPath)): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null
  const hit = withDb(dbPath, db => {
    try { return db.query<{ id: string }, [string]>('SELECT id FROM session WHERE id = ?').get(sessionId) } catch { return null }
  })
  if (hit) return opencodeChatPath(dbPath, sessionId)
  const v2Hit = inV2Table(dbPath, sessionId)
  if (v2Hit) return opencodeChatPath(dbPath, sessionId)
  if (v2Hit === false) return null
  const source = v2()
  if (!source) return null
  try { await source.messages(sessionId); return opencodeChatPath(dbPath, sessionId) } catch { return null }
}

/** The session's whole conversation, oldest first; `null` when it could not be read. A 1.x session is read from
 *  its frozen tables; one that has no 1.x rows (created after the 2.x migration) through the service. */
export async function readOpencodeChat(path: string, v2?: () => OpencodeV2ChatSource | null): Promise<ChatTurn[] | null> {
  const ref = splitOpencodeChatPath(path)
  if (!ref) return null
  const v1 = withDb(ref.dbPath, db => {
    try {
      return db.transaction(() => {
        const messages = db.query<OpencodeMessageRow, [string]>('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(ref.sessionId)
        const parts = db.query<OpencodePartRow, [string]>('SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(ref.sessionId)
        return messages.length > 0 ? parseOpencodeChat(messages, parts) : null
      })()
    } catch { return null }
  })
  if (v1) return v1
  const source = (v2 ?? (() => defaultV2Source(ref.dbPath)))()
  if (!source) return existsSync(ref.dbPath) ? [] : null
  try {
    const { messages, parts } = chatRowsOfV2Messages(await source.messages(ref.sessionId))
    return parseOpencodeChat(messages, parts)
  } catch { return null }
}
