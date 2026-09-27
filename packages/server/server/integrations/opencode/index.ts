/**
 * integrations/opencode/index.ts — the IO half of the opencode replay: which sessions exist in
 * `~/.local/share/opencode/opencode.db`, and reading one by its own rows.
 *
 * ## No cursor, unlike Claude/Codex/Kimi
 *
 * opencode's store is SQLite, not an append-only transcript, so there is no byte offset to resume
 * from. `replay()` instead FINGERPRINTS the session's row counts (`message`/`part`) each call —
 * antigravity's own stated shape ("this integration does not implement a resume yet, and says so")
 * — and re-reads and re-folds the WHOLE session from `emptyOpencodeReplay` whenever the fingerprint
 * changes or the previous read was not yet `final`. This is safe, not merely tolerated: every event
 * id is DERIVED from its record's position in the session's own stable order
 * (`opencodeContext`/`recordRef`), so a re-fold re-derives the identical ids and the journal dedupes
 * the repeat rather than doubling it. It is NOT cheap for a very large session polled every few
 * seconds — a real optimisation (reading only rows newer than the last-seen `time_created`/`id`)
 * is future work, named here rather than attempted against the 2-session, 39-message store this was
 * built and measured against.
 *
 * ## Read-only, always
 *
 * Opened via `bun:sqlite`'s `{ readonly: true }` (the task's own first-listed option), which never
 * creates or touches a `-wal`/`-shm` file and coexists with a live opencode process holding the
 * database open in WAL mode — verified by opening the real store while checking `pgrep -a opencode`
 * found nothing, and by every read here going through `db.query(...).all()` with no `db.run` ever
 * called. `openReadOnly` returns `null` on a missing/locked/corrupt file, never throws — the same
 * contract `antigravity/index.ts`'s own opener carries.
 */
import { existsSync } from 'node:fs'
import { OPENCODE_DB_PATH } from '../../config'
import type { AgentisticsEvent } from '@agentistics/core'
import type { HarnessReplay, ReplayBatch, ReplayCursor, ReplaySource } from '../types'
import { OPENCODE_SOURCE_ID, opencodeContext, type OpencodeReplayContext } from './replay-core'
import {
  emptyOpencodeReplay, finishOpencodeReplay, foldOpencodeReplay,
  type OpencodeRecord,
} from './replay'

const DEFAULT_SETTLED_MS = 60_000

export interface OpencodeReplayOptions {
  /** Default `OPENCODE_DB_PATH` (`~/.local/share/opencode/opencode.db`, or `OPENCODE_DB_PATH` env). */
  dbPath?: string
  now?: () => number
  settledMs?: number
}

async function openReadOnly(file: string): Promise<any | null> {
  if (!existsSync(file)) return null
  try {
    const { Database } = await import('bun:sqlite')
    return new Database(file, { readonly: true })
  } catch {
    return null
  }
}

interface SessionRow {
  id: string
  directory: string | null
  version: string | null
  time_created: number
}

interface MessageRow {
  id: string
  time_created: number
  data: string
}

interface PartRow {
  id: string
  message_id: string
  time_created: number
  time_updated: number
  data: string
}

/** Every `session` row. Missing/locked/corrupt DB -> `[]`, never a throw. */
async function readSessions(db: any): Promise<SessionRow[]> {
  try {
    return db.query('SELECT id, directory, version, time_created FROM session ORDER BY id').all() as SessionRow[]
  } catch {
    return []
  }
}

async function readMessages(db: any, sessionId: string): Promise<MessageRow[]> {
  try {
    return db.query('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(sessionId) as MessageRow[]
  } catch {
    return []
  }
}

async function readParts(db: any, sessionId: string): Promise<PartRow[]> {
  try {
    return db.query('SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id')
      .all(sessionId) as PartRow[]
  } catch {
    return []
  }
}

interface ParsedMessage {
  role?: string
  time?: { created?: number; completed?: number }
  modelID?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  finish?: string
  error?: { name?: string }
}

interface ParsedTool {
  type?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: { command?: string; filePath?: string }
    time?: { start?: number; end?: number }
  }
}

/**
 * `message`/`part` rows -> the pure fold's `OpencodeRecord[]`, in ONE stable order: by
 * `time_created`, messages before a part of the SAME instant (a message is always created at or
 * before its own parts), ties broken by id. This is the order `sourceRef`'s ordinal counts over —
 * see `replay-core.ts`'s header.
 */
export function orderedRecords(messages: readonly MessageRow[], parts: readonly PartRow[]): OpencodeRecord[] {
  type Item = { at: number; priority: 0 | 1; id: string; rec: OpencodeRecord }
  const items: Item[] = []

  for (const m of messages) {
    let d: ParsedMessage
    try { d = JSON.parse(m.data) } catch { continue }
    if (d.role === 'user') {
      items.push({ at: m.time_created, priority: 0, id: m.id, rec: { kind: 'user_message', id: m.id, createdAt: m.time_created } })
    } else if (d.role === 'assistant') {
      items.push({
        at: m.time_created, priority: 0, id: m.id,
        rec: {
          kind: 'assistant_message', id: m.id, createdAt: m.time_created,
          completedAt: d.time?.completed,
          modelId: d.modelID,
          cost: d.cost,
          tokens: d.tokens
            ? { input: d.tokens.input, output: d.tokens.output, reasoning: d.tokens.reasoning, cacheRead: d.tokens.cache?.read, cacheWrite: d.tokens.cache?.write }
            : undefined,
          finish: d.finish,
          errorName: d.error?.name,
        },
      })
    }
  }

  for (const p of parts) {
    let d: ParsedTool
    try { d = JSON.parse(p.data) } catch { continue }
    if (d.type !== 'tool' || !d.tool) continue
    items.push({
      at: p.time_created, priority: 1, id: p.id,
      rec: {
        kind: 'tool_part', id: p.id, createdAt: p.time_created, updatedAt: p.time_updated,
        tool: d.tool, status: d.state?.status,
        startedAt: d.state?.time?.start, endedAt: d.state?.time?.end,
        command: d.state?.input?.command, filePath: d.state?.input?.filePath,
      },
    })
  }

  items.sort((a, b) => a.at - b.at || a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return items.map(i => i.rec)
}

function fingerprintOf(session: SessionRow, messages: readonly MessageRow[], parts: readonly PartRow[]): string {
  const lastMsg = messages.length ? messages[messages.length - 1]!.id : ''
  const lastPart = parts.length ? parts[parts.length - 1]!.id : ''
  return JSON.stringify({ v: 1, m: messages.length, p: parts.length, lastMsg, lastPart })
}

async function readAndFold(
  db: any, session: SessionRow, ctx: OpencodeReplayContext, recordedAtMs: number, settledMs: number,
  emit: (e: AgentisticsEvent) => void,
): Promise<{ fingerprint: string; final: boolean }> {
  const messages = await readMessages(db, session.id)
  const parts = await readParts(db, session.id)
  const records = orderedRecords(messages, parts)

  const state = emptyOpencodeReplay(ctx)
  foldOpencodeReplay(state, records, emit)

  const lastActivityMs = Math.max(
    session.time_created,
    ...messages.map(m => m.time_created),
    ...parts.map(p => p.time_updated),
  )
  const final = recordedAtMs - lastActivityMs >= settledMs

  finishOpencodeReplay(state, {
    projectPath: session.directory ?? '',
    version: session.version ?? undefined,
    startedAtMs: session.time_created,
  }, { final }, emit)

  return { fingerprint: fingerprintOf(session, messages, parts), final }
}

export function createOpencodeReplay(opts: OpencodeReplayOptions = {}): HarnessReplay {
  const dbPath = opts.dbPath ?? OPENCODE_DB_PATH
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? DEFAULT_SETTLED_MS

  let sessionsCache: SessionRow[] | null = null

  async function withDb<T>(fn: (db: any) => Promise<T>, fallback: T): Promise<T> {
    const db = await openReadOnly(dbPath)
    if (!db) return fallback
    try {
      return await fn(db)
    } finally {
      try { db.close() } catch { /* ignore */ }
    }
  }

  async function discover(): Promise<ReplaySource[]> {
    const sessions = await withDb(readSessions, [] as SessionRow[])
    sessionsCache = sessions
    return sessions.map(s => ({ sessionId: s.id, sourceRef: `${OPENCODE_SOURCE_ID}:${s.id}` }))
  }

  async function replay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    return withDb(async db => {
      let session = sessionsCache?.find(s => s.id === source.sessionId)
      if (!session) {
        const sessions = await readSessions(db)
        sessionsCache = sessions
        session = sessions.find(s => s.id === source.sessionId)
      }
      if (!session) return { events: [], cursor }

      const nowMs = now()
      const ctx = opencodeContext(session.id, new Date(nowMs).toISOString())
      const events: AgentisticsEvent[] = []
      const { fingerprint, final } = await readAndFold(db, session, ctx, nowMs, settledMs, e => events.push(e))

      const prev = parseCursor(cursor)
      if (prev && prev.fingerprint === fingerprint && prev.final && final) return { events: [], cursor }

      return { events, cursor: JSON.stringify({ v: 1, fingerprint, final }) }
    }, { events: [], cursor })
  }

  return { discover, replay }
}

function parseCursor(cursor: ReplayCursor): { fingerprint: string; final: boolean } | null {
  if (cursor === null) return null
  try {
    const raw = JSON.parse(cursor)
    if (raw && typeof raw === 'object' && typeof raw.fingerprint === 'string' && typeof raw.final === 'boolean') return raw
  } catch { /* ignore */ }
  return null
}

/** The default instance, reading `OPENCODE_DB_PATH` on the real clock — for `INTEGRATIONS.opencode`. */
export const opencodeReplay: HarnessReplay = createOpencodeReplay()
