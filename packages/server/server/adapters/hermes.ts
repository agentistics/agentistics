/**
 * adapters/hermes.ts — reads Hermes' `state.db` (`$HERMES_HOME`, default `~/.hermes`) READ-ONLY.
 *
 * The schema is DERIVED FROM SOURCE (hermes-agent @1e0c7730, SCHEMA_VERSION 31); no real file has been
 * read yet. A file outside the schema range or missing a column is refused in words (health), never
 * read partially — the same two gates as the engine's reader. Only the columns below are selected:
 * no auth, config or `.env` file is ever opened.
 *
 * This module holds NO host capability and imports no module that does (the delivery guard's
 * `helperInventory` / `moduleCeiling`, shrink-only): the existence probe, the paths, the env switch and
 * the file memo are HANDED IN by the registry (`adapters/types.ts`, `loadHermesAdapter`). Even a type
 * import counts as an edge there, so the adapter shape below is structural.
 */
import { constants, Database } from 'bun:sqlite'
import type { SessionMeta } from '@agentistics/core'
import { setHermesReadIssue } from './hermes-status'
import { parseHermesSession, type HermesMessageDbRow, type HermesSessionDbRow } from './hermes-parse'

/** Kept equal to the engine reader's range. */
export const HERMES_SCHEMA_RANGE = { min: 22, max: 31 } as const

const SESSION_COLUMNS = [
  'id', 'source', 'model', 'parent_session_id', 'model_config', 'cwd', 'title', 'started_at', 'ended_at', 'last_activity_at',
  'api_call_count', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'estimated_cost_usd', 'actual_cost_usd', 'cost_status',
]
/** Read when present, `NULL` otherwise: without them a local-looking model is simply unpriced. */
const BILLING_COLUMNS = ['billing_provider']
const MESSAGE_COLUMNS =['session_id', 'role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'timestamp', 'message_uid', '_compressed_summary']

function refusal(db: Database): string | null {
  const v = db.query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM schema_version').get()?.v
  if (typeof v !== 'number') return "Hermes' state.db states no schema version; it is not read."
  if (v < HERMES_SCHEMA_RANGE.min || v > HERMES_SCHEMA_RANGE.max) {
    return `Hermes' state.db is schema ${v}; agentistics reads ${HERMES_SCHEMA_RANGE.min}–${HERMES_SCHEMA_RANGE.max} (update agentistics).`
  }
  const missing: string[] = []
  for (const [table, cols] of [['sessions', SESSION_COLUMNS], ['messages', MESSAGE_COLUMNS]] as const) {
    const have = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(r => r.name))
    for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`)
  }
  return missing.length ? `Hermes' state.db (schema ${v}) lacks ${missing.join(', ')}; it is not read.` : null
}

/**
 * Never writes into `~/.hermes`. `{ readonly: true }` alone creates `-shm`/`-wal` beside a WAL database
 * that has none (see antigravity.ts), so with no `-wal` — nothing to miss — the file is opened
 * `immutable=1`; with one, a plain read-only open reads it.
 */
/** A path as a SQLite URI path — the same rule as `antigravity.ts`'s `toSqliteUriPath`, kept here so no capable module is imported. */
function sqliteUriPath(file: string): string {
  const normalized = String(file ?? '').replace(/\\/g, '/')
  const withRoot = normalized.startsWith('/') ? normalized : `/${normalized}`
  return withRoot.replace(/\?/g, '%3f').replace(/#/g, '%23')
}

/** Synchronous "does this path exist" — `existsSync`, handed in by the caller. */
export type PathExists = (path: string) => boolean

function openReadOnly(path: string, exists: PathExists): Database {
  if (exists(`${path}-wal`)) return new Database(path, { readonly: true })
  return new Database(`file:${sqliteUriPath(path)}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
}

/** Read-only and WAL-aware. A refused or unreadable store yields no sessions plus a sentence. */
export function readHermesDb(path: string, exists: PathExists): { sessions: SessionMeta[]; error?: string } {
  if (!exists(path)) return { sessions: [] }
  let db: Database | undefined
  try {
    db = openReadOnly(path, exists)
    const reason = refusal(db)
    if (reason) return { sessions: [], error: reason }
    const have = new Set(db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all().map(r => r.name))
    const columns = [...SESSION_COLUMNS, ...BILLING_COLUMNS.map(c => (have.has(c) ? c : `NULL AS ${c}`))]
    const rows = db.transaction(() => ({
      sessions: db!.query<HermesSessionDbRow, []>(`SELECT ${columns.join(', ')} FROM sessions`).all(),
      // Message text is only needed for a person's own rows; a tool result can be megabytes.
      messages: db!.query<HermesMessageDbRow, []>(
        `SELECT ${MESSAGE_COLUMNS.map(c => (c === 'content' ? "CASE WHEN role = 'user' THEN substr(content, 1, 2000) END AS content" : c)).join(', ')} FROM messages ORDER BY id`,
      ).all(),
    }))()
    const bySession = new Map<string, HermesMessageDbRow[]>()
    for (const m of rows.messages) {
      const list = bySession.get(m.session_id)
      if (list) list.push(m)
      else bySession.set(m.session_id, [m])
    }
    const sessions = rows.sessions.flatMap(s => {
      const parent = s.parent_session_id && s.parent_session_id !== s.id ? bySession.get(s.parent_session_id) : undefined
      return parseHermesSession(s, bySession.get(s.id) ?? [], parent ?? []) ?? []
    })
    return { sessions }
  } catch (err) {
    return { sessions: [], error: `Hermes' state.db could not be read: ${(err as Error).message}` }
  } finally {
    db?.close()
  }
}

/** What the registry hands in. Structural on purpose: see the header. */
export interface HermesAdapterDeps {
  dir: string
  dbPath: string
  enabled: () => boolean
  exists: PathExists
  versionOf: (paths: readonly string[]) => Promise<string>
  memo: { get(key: string, version: string, parse: () => Promise<SessionMeta[]>): Promise<SessionMeta[]> }
}

export function createHermesAdapter(deps: HermesAdapterDeps) {
  const { dir, dbPath, enabled, exists, versionOf, memo } = deps
  return {
    id: 'hermes' as const,
    dataRoot: dir,
    isAvailable: () => enabled() && exists(dbPath),
    async loadSessions(): Promise<SessionMeta[]> {
      const version = await versionOf([dbPath, `${dbPath}-wal`])
      const sessions = await memo.get(dbPath, version, async () => {
        const r = readHermesDb(dbPath, exists)
        setHermesReadIssue(r.error ?? null)
        return r.sessions
      })
      return sessions.map(s => ({ ...s }))
    },
  }
}
