import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SessionMeta } from '@agentistics/core'
import { OPENCODE_DB_PATH, OPENCODE_DIR } from '../config'
import { harnessEnabled, type HarnessAdapter } from './types'
import { createFileMemo, registerMemo, versionOf } from './file-memo'
import { parseOpencodeSession, type OpencodeSessionRow, type OpencodeMessageRow, type OpencodePartRow, type OpencodeModels } from './opencode-parse'

/** Read-only, WAL-aware: never immutable, journal_mode, checkpoint, or an immediate transaction.
 * A short deferred snapshot sees all committed WAL writes without blocking OpenCode's writer.
 * No auth/config/account tables are read. Exported path allows isolated fixture tests.
 */
export function loadOpencodeDb(path: string, models: OpencodeModels = {}): SessionMeta[] {
  if (!existsSync(path)) return []
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    const rows = db.transaction(() => ({
      sessions: db!.query<OpencodeSessionRow, []>('SELECT id, directory, title, time_created, time_updated FROM session').all(),
      messages: db!.query<OpencodeMessageRow, []>('SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY time_created, id').all(),
      parts: db!.query<OpencodePartRow, []>("SELECT id, message_id, session_id, time_created, data FROM part WHERE json_valid(data) AND json_extract(data, '$.type') = 'text' ORDER BY time_created, id").all(),
    }))()
    const messages = new Map<string, OpencodeMessageRow[]>(), parts = new Map<string, OpencodePartRow[]>()
    for (const m of rows.messages) { const list = messages.get(m.session_id) ?? []; list.push(m); messages.set(m.session_id, list) }
    for (const p of rows.parts) { const list = parts.get(p.session_id) ?? []; list.push(p); parts.set(p.session_id, list) }
    return rows.sessions.map(s => parseOpencodeSession(s, messages.get(s.id) ?? [], parts.get(s.id) ?? [], models))
      .filter((s): s is SessionMeta => s !== null)
  } catch { return [] } // Missing, incompatible, busy or corrupt store never takes /api/data down.
  finally { db?.close() }
}

const memo = registerMemo(createFileMemo<SessionMeta[]>(4))

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode', dataRoot: OPENCODE_DIR,
  isAvailable: () => harnessEnabled('opencode') && existsSync(OPENCODE_DB_PATH),
  async loadSessions() {
    // OpenCode's models.dev cache, when exposed, supplies per-route windows. No network or fake cap.
    // Source: opencode v1.17.9 packages/core/src/models-dev.ts (Global.Path.cache/models.json).
    const path = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'opencode', 'models.json')
    const version = await versionOf([OPENCODE_DB_PATH, `${OPENCODE_DB_PATH}-wal`, path])
    const sessions = await memo.get(OPENCODE_DB_PATH, version, async () => {
      let models: OpencodeModels = {}
      try { const d = JSON.parse(await readFile(path, 'utf8')); if (d && typeof d === 'object' && !Array.isArray(d)) models = d } catch { /* optional */ }
      return loadOpencodeDb(OPENCODE_DB_PATH, models)
    })
    return sessions.map(s => ({ ...s }))
  },
}
