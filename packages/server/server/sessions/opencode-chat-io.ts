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
import { parseOpencodeChat, type OpencodeMessageRow, type OpencodePartRow } from './opencode-chat'

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

/** The chat path of a session the store HOLDS, or `null` — never a path for an id it does not know. */
export async function resolveOpencodeChat(dbPath: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null
  const hit = withDb(dbPath, db => db.query<{ id: string }, [string]>('SELECT id FROM session WHERE id = ?').get(sessionId))
  return hit ? opencodeChatPath(dbPath, sessionId) : null
}

/** The session's whole conversation, oldest first; `null` when it could not be read. */
export async function readOpencodeChat(path: string): Promise<ChatTurn[] | null> {
  const ref = splitOpencodeChatPath(path)
  if (!ref) return null
  return withDb(ref.dbPath, db => db.transaction(() => {
    const messages = db.query<OpencodeMessageRow, [string]>('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(ref.sessionId)
    const parts = db.query<OpencodePartRow, [string]>('SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(ref.sessionId)
    return parseOpencodeChat(messages, parts)
  })())
}
