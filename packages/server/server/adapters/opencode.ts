import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SessionMeta } from '@agentistics/core'
import { OPENCODE_DB_PATH, OPENCODE_DIR } from '../config'
import { harnessEnabled, type HarnessAdapter } from './types'
import { createFileMemo, registerMemo, versionOf } from './file-memo'
import { setOpencodeReadIssue } from './opencode-status'
import { configModels, mergeModels, parseJsonc } from './opencode-models'
import { generationOfTables, loadOpencodeV2, opencodeStateDirFor, opencodeTables, readServiceRecord } from './opencode-v2'
import { parseOpencodeSession, type OpencodeSessionRow, type OpencodeMessageRow, type OpencodePartRow, type OpencodeModels } from './opencode-parse'

/** Read-only, WAL-aware: never immutable, journal_mode, checkpoint, or an immediate transaction.
 * A short deferred snapshot sees all committed WAL writes without blocking OpenCode's writer.
 * No auth/config/account tables are read. Exported path allows isolated fixture tests.
 * 1.x only (`session`/`message`/`part`); 2.x is read through the service API (opencode-v2.ts).
 */
export function loadOpencodeDb(path: string, models: OpencodeModels = {}): SessionMeta[] {
  return readOpencodeDb(path, models).sessions
}

/** Same read, but a query failure comes back as `error` instead of vanishing. */
export function readOpencodeDb(path: string, models: OpencodeModels = {}): { sessions: SessionMeta[]; error?: string } {
  if (!existsSync(path)) return { sessions: [] }
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    const rows = db.transaction(() => ({
      sessions: db!.query<OpencodeSessionRow, []>('SELECT id, directory, title, time_created, time_updated FROM session').all(),
      messages: db!.query<OpencodeMessageRow, []>('SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY time_created, id').all(),
      // Text parts as stored; a tool part is cut down to its name and status (its input/output can be megabytes
      // and the parser only counts the request and whether it failed).
      parts: db!.query<OpencodePartRow, []>(
        "SELECT id, message_id, session_id, time_created, CASE WHEN json_extract(data, '$.type') = 'tool' " +
        "THEN json_object('type', 'tool', 'tool', json_extract(data, '$.tool'), 'state', json_object('status', json_extract(data, '$.state.status'))) " +
        "ELSE data END AS data FROM part WHERE json_valid(data) AND json_extract(data, '$.type') IN ('text', 'tool') ORDER BY time_created, id",
      ).all(),
    }))()
    const messages = new Map<string, OpencodeMessageRow[]>(), parts = new Map<string, OpencodePartRow[]>()
    for (const m of rows.messages) { const list = messages.get(m.session_id) ?? []; list.push(m); messages.set(m.session_id, list) }
    for (const p of rows.parts) { const list = parts.get(p.session_id) ?? []; list.push(p); parts.set(p.session_id, list) }
    return { sessions: rows.sessions.map(s => parseOpencodeSession(s, messages.get(s.id) ?? [], parts.get(s.id) ?? [], models))
      .filter((s): s is SessionMeta => s !== null) }
  } catch (err) { // Missing, incompatible, busy or corrupt store never takes /api/data down, but it is NOT silent.
    return { sessions: [], error: (err as Error).message }
  } finally { db?.close() }
}

export const OPENCODE_KNOWN_VERSIONS = '1.17.9–1.19.5, 2.2.5'

/** Reads whichever generation the store is, recording a sentence for health when it cannot. */
export async function loadOpencodeAny(dbPath: string, stateDir: string, models: OpencodeModels = {}, modelsVersion = ''): Promise<SessionMeta[]> {
  const tables = existsSync(dbPath) ? opencodeTables(dbPath) : null
  const gen = tables ? generationOfTables(tables) : existsSync(dbPath) ? 'unknown' : readServiceRecord(stateDir) ? 'v2' : 'unknown'
  if (gen === 'v1') {
    const r = readOpencodeDb(dbPath, models)
    setOpencodeReadIssue(r.error ? `opencode.db no longer answers the 1.x queries (${r.error})` : null)
    return r.sessions
  }
  if (gen === 'v2') {
    const service = readServiceRecord(stateDir)
    if (!service) {
      setOpencodeReadIssue('OpenCode 2.x: background service not found or not answering — open OpenCode once, or run `opencode service start`')
      return lastV2
    }
    try {
      lastV2 = await loadOpencodeV2(service, models, modelsVersion)
      setOpencodeReadIssue(null)
      return lastV2
    } catch (err) {
      setOpencodeReadIssue(`OpenCode 2.x: background service not found or not answering (${(err as Error).message}) — open OpenCode once, or run \`opencode service start\``)
      return lastV2
    }
  }
  setOpencodeReadIssue(tables === null
    ? 'opencode.db could not be opened as a SQLite database'
    : `opencode.db has neither the 1.x nor the 2.x tables — a version agentistics has not verified (known ${OPENCODE_KNOWN_VERSIONS})`)
  return []
}

/** The last 2.x answer, so a service that is briefly down does not blank the dashboard. */
let lastV2: SessionMeta[] = []

const memo = registerMemo(createFileMemo<SessionMeta[]>(4))

/** Every file a window may be read from, in precedence order (first cache hit wins; configs merge, later wins). */
export function opencodeModelSources(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()) {
  const cacheHome = env.XDG_CACHE_HOME || join(home, '.cache')
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  // macOS: OpenCode follows xdg-basedir (`~/.cache`), but a Homebrew/app build may use the platform dir.
  const cache = [join(cacheHome, 'opencode', 'models.json'), join(home, 'Library', 'Caches', 'opencode', 'models.json')]
  const config = [
    join(configHome, 'opencode', 'opencode.json'), join(configHome, 'opencode', 'opencode.jsonc'),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
  ]
  return { cache, config, all: [...cache, ...config] }
}

const stateDir = () => opencodeStateDirFor(OPENCODE_DB_PATH, process.env)

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode', dataRoot: OPENCODE_DIR,
  isAvailable: () => harnessEnabled('opencode') && (existsSync(OPENCODE_DB_PATH) || readServiceRecord(stateDir()) !== null),
  async loadSessions() {
    // A route's window comes from OpenCode's models.dev cache AND the user's own opencode.json (which
    // alone can state one for a custom/local route). No network and no invented cap.
    // Source: opencode v1.17.9 packages/core/src/models-dev.ts (Global.Path.cache/models.json).
    const paths = opencodeModelSources()
    const modelsVersion = await versionOf(paths.all)
    const readModels = async (): Promise<OpencodeModels> => {
      let catalog: OpencodeModels = {}
      for (const path of paths.cache) {
        try { const d = JSON.parse(await readFile(path, 'utf8')); if (d && typeof d === 'object' && !Array.isArray(d)) { catalog = d; break } } catch { /* optional */ }
      }
      let config: OpencodeModels = {}
      for (const path of paths.config) {
        try { config = mergeModels(config, configModels(parseJsonc(await readFile(path, 'utf8')))) } catch { /* optional */ }
      }
      return mergeModels(catalog, config)
    }
    const tables = existsSync(OPENCODE_DB_PATH) ? opencodeTables(OPENCODE_DB_PATH) : null
    if (tables && generationOfTables(tables) === 'v1') {
      const version = await versionOf([OPENCODE_DB_PATH, `${OPENCODE_DB_PATH}-wal`, ...paths.all])
      const sessions = await memo.get(OPENCODE_DB_PATH, version, async () => loadOpencodeAny(OPENCODE_DB_PATH, stateDir(), await readModels(), modelsVersion))
      return sessions.map(s => ({ ...s }))
    }
    // 2.x (or unknown): the per-session memo lives in opencode-v2.ts, keyed by each session's time.updated.
    const sessions = await loadOpencodeAny(OPENCODE_DB_PATH, stateDir(), await readModels(), modelsVersion)
    return sessions.map(s => ({ ...s }))
  },
}
