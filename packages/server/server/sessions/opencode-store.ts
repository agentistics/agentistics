/**
 * opencode-store.ts — read-only SQL over `opencode.db` for the two legacy surfaces that need the TEXT of
 * an OpenCode conversation: the history search and the transcript panel.
 *
 * OpenCode keeps every session in ONE SQLite store (no per-session file to `grep`), so both surfaces ask
 * the store. Rules, shared with `adapters/opencode.ts`: opened `readonly` (never immutable, journal_mode,
 * checkpoint or a write transaction — the writer is a live process and the WAL must stay its own), one
 * short deferred snapshot per call, closed in `finally`, and any failure (missing, busy, corrupt, an
 * incompatible schema) answers "nothing" rather than throwing into the fleet poll.
 *
 * The row→turn mapping mirrors the engine's `integrations/chat/opencode-chat.ts` (`opencodeChatTurns`);
 * the engine reader is not reachable through the public seam (it needs the engine slot and a ChatHub),
 * so the pure mapping is kept here, held to the same rules: `synthetic`/`ignored` parts are OpenCode's own
 * plumbing and never a turn, `reasoning` parts are `thinking`, `tool` parts are tools, and a message with
 * none of those yields no turn.
 */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { ChatTurn } from '@agentistics/core'
import { OPENCODE_DB_PATH } from '../config'
import { canonicalTool } from '../harness-activity'

/** A conversation is addressed as `<db path>#<ses_…>` — the same address the engine's chat uses. */
export function opencodeTranscriptRef(dbPath: string, sessionId: string): string {
  return `${dbPath}#${sessionId}`
}
export function splitOpencodeRef(ref: string): { dbPath: string; sessionId: string } | null {
  const i = ref.lastIndexOf('#')
  return i > 0 && i < ref.length - 1 ? { dbPath: ref.slice(0, i), sessionId: ref.slice(i + 1) } : null
}

interface MsgRow { id: string; time_created: number; data: string }
interface PartRow { id: string; message_id: string; data: string }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const parse = (s: unknown): Record<string, unknown> => { try { return obj(JSON.parse(String(s))) } catch { return {} } }
const iso = (ms: unknown): string | undefined => typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined

/** PURE. The turns of one session from its rows (messages and parts in stable order). */
export function opencodeTurns(messages: readonly MsgRow[], parts: readonly PartRow[]): ChatTurn[] {
  const byMsg = new Map<string, PartRow[]>()
  for (const p of parts) { const l = byMsg.get(p.message_id) ?? []; l.push(p); byMsg.set(p.message_id, l) }
  const turns: ChatTurn[] = []
  for (const m of messages) {
    const role = parse(m.data).role
    if (role !== 'user' && role !== 'assistant') continue
    const text: string[] = [], thinking: string[] = []
    const tools: NonNullable<ChatTurn['tools']> = []
    for (const p of byMsg.get(m.id) ?? []) {
      const d = parse(p.data)
      if (d.synthetic === true || d.ignored === true) continue
      if (d.type === 'text' && typeof d.text === 'string' && d.text !== '') text.push(d.text)
      else if (d.type === 'reasoning' && typeof d.text === 'string' && d.text !== '') thinking.push(d.text)
      else if (d.type === 'tool' && typeof d.tool === 'string') {
        const st = obj(d.state), input = obj(st.input)
        const file = [input.filePath, input.filepath].find((v): v is string => typeof v === 'string' && v !== '')
        const canonical = canonicalTool('opencode', d.tool)
        tools.push({
          name: d.tool, ...(canonical !== d.tool ? { canonical } : {}), ...(st.status === 'error' ? { failed: true } : {}),
          ...(file ? { detail: file, writes: ['write', 'edit'].includes(d.tool) ? [file] : [] } : {}), ref: p.id,
        })
      }
    }
    if (!text.length && !thinking.length && !tools.length) continue
    const at = iso(m.time_created)
    turns.push({
      role, text: text.join('\n'), ...(at ? { at } : {}),
      ...(tools.length ? { tools } : {}), ...(thinking.length ? { thinking: thinking.join('\n') } : {}),
    })
  }
  return turns
}

function withDb<T>(path: string, fallback: T, fn: (db: Database) => T): T {
  if (!existsSync(path)) return fallback
  let db: Database | undefined
  try { db = new Database(path, { readonly: true }); return db.transaction(() => fn(db!))() } catch { return fallback } finally { db?.close() }
}

/** Does this session exist in the store? */
export function opencodeSessionExists(path: string, sessionId: string): boolean {
  return withDb(path, false, db => db.query('SELECT 1 FROM session WHERE id = ?').get(sessionId) !== null)
}

/**
 * PURE. What an opencode session is doing, from its NEWEST message row as opencode wrote it: a person's message
 * not yet answered, or an assistant message with no `time.completed` and no `error`, is `working`; anything else
 * is `waiting`. The store says it — no screen, no guess — so an EXTERNAL opencode (a TUI opened by hand) can
 * state its activity like a managed row (OPENCODE.RESTO gap 5). null: no message, or unreadable.
 */
export function opencodeActivityOf(newest: { data: string } | null | undefined): 'working' | 'waiting' | null {
  if (!newest) return null
  let d: { role?: string; time?: { completed?: number }; error?: unknown }
  try { d = JSON.parse(newest.data) } catch { return null }
  if (d.role === 'user') return 'working'
  if (d.role !== 'assistant') return null
  return d.time?.completed === undefined && !d.error ? 'working' : 'waiting'
}

/** IO. `opencodeActivityOf` for one session of the store at `path`. */
export function readOpencodeActivity(path: string, sessionId: string): 'working' | 'waiting' | null {
  return withDb(path, null as 'working' | 'waiting' | null, db => opencodeActivityOf(
    db.query<{ data: string }, [string]>('SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1').get(sessionId),
  ))
}

/** The whole conversation of one session, oldest first. `[]` when unreadable. */
export function readOpencodeTurns(path: string, sessionId: string): ChatTurn[] {
  return withDb(path, [] as ChatTurn[], db => opencodeTurns(
    db.query<MsgRow, [string]>('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId),
    db.query<PartRow, [string]>('SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(sessionId),
  ))
}

/**
 * Sessions whose conversation text contains `query` (case-insensitive substring), newest first.
 *
 * `instr(lower(…), lower(?))` and not `LIKE`: the query is DATA, so `%` and `_` in it are literal
 * characters to look for. Only `text` and `reasoning` parts the person or model actually wrote count —
 * `synthetic`/`ignored` parts are plumbing, and tool output is not "what was said". `lower()` folds ASCII
 * only (SQLite built-in), which is the documented limit for accented capitals.
 */
export function searchOpencodeDb(path: string, query: string): string[] {
  if (query.trim() === '') return []
  return withDb(path, [] as string[], db => db.query<{ session_id: string }, [string]>(
    `SELECT part.session_id AS session_id FROM part
       WHERE json_valid(part.data)
         AND json_extract(part.data, '$.type') IN ('text', 'reasoning')
         AND coalesce(json_extract(part.data, '$.synthetic'), 0) = 0
         AND coalesce(json_extract(part.data, '$.ignored'), 0) = 0
         AND instr(lower(json_extract(part.data, '$.text')), lower(?1)) > 0
       GROUP BY part.session_id ORDER BY max(part.time_created) DESC`,
  ).all(query).map(r => r.session_id))
}

export const opencodeDbPath = (): string => OPENCODE_DB_PATH
