/**
 * opencode-paths.ts — PURE. Where opencode keeps its data, as OPENCODE ITSELF resolves it.
 *
 * Measured on opencode 1.17.9 (`opencode db path`, 2026-10-30): `OPENCODE_DB` (the exact file) and
 * `XDG_DATA_HOME` (`$XDG_DATA_HOME/opencode/opencode.db`) move the database; `OPENCODE_DB_PATH` — the name
 * this server used to read — has NO effect on opencode, so a reader that honoured it could look at a file
 * opencode never writes. `OPENCODE_DIR` stays agentistics's own override of the data directory.
 *
 * The engine carries the same rule (`integrations/opencode/db-path.ts`) for the child it starts: both sides
 * must agree, because the host hands the engine THIS path (`paths.opencodeDbPath`).
 */
import { dirname, join } from 'node:path'

export interface OpencodePaths {
  /** opencode's data directory (`…/opencode`): the database, `auth.json`, `log/`. */
  dir: string
  dbPath: string
}

const set = (v: string | undefined): string | undefined => (v !== undefined && v !== '' ? v : undefined)

export function opencodePaths(env: Readonly<Record<string, string | undefined>>, home: string): OpencodePaths {
  const exact = set(env.OPENCODE_DB)
  if (exact) return { dir: set(env.OPENCODE_DIR) ?? dirname(exact), dbPath: exact }
  const xdg = set(env.XDG_DATA_HOME)
  const dir = set(env.OPENCODE_DIR) ?? join(xdg ?? join(home, '.local', 'share'), 'opencode')
  return { dir, dbPath: join(dir, 'opencode.db') }
}
