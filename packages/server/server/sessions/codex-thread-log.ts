/**
 * codex-thread-log.ts — IO half of `codex-thread-link.ts`: reads Codex's own `threads` table, READ-ONLY.
 * Total: any failure (no file, locked, schema drift) is an empty answer, i.e. an unlinked row as before.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linkCodexProcesses, type CodexProcessRef, type CodexThread } from './codex-thread-link'

/** The highest-numbered `state_<n>.sqlite` under the codex home (`CODEX_DIR` overrides `~/.codex`). */
export function codexStatePath(dir: string = process.env.CODEX_DIR ?? join(homedir(), '.codex')): string | null {
  try {
    const nums = readdirSync(dir).map(n => /^state_(\d+)\.sqlite$/.exec(n)?.[1]).filter((n): n is string => !!n).map(Number)
    if (nums.length === 0) return null
    const p = join(dir, `state_${Math.max(...nums)}.sqlite`)
    return existsSync(p) ? p : null
  } catch { return null }
}

/** Threads created within `sinceMs` of now, newest first. */
export function readCodexThreads(path: string, sinceMs: number): CodexThread[] {
  const db = new Database(path, { readonly: true })
  try {
    const rows = db.query('SELECT id, cwd, created_at_ms, archived FROM threads WHERE created_at_ms >= ? ORDER BY created_at_ms DESC LIMIT 500')
      .all(sinceMs) as Array<{ id: string; cwd: string; created_at_ms: number | null; archived: number }>
    return rows.filter(r => typeof r.created_at_ms === 'number')
      .map(r => ({ id: r.id, cwd: r.cwd, createdMs: r.created_at_ms!, archived: !!r.archived }))
  } finally { db.close() }
}

export async function readCodexProcessSessions(
  procs: readonly CodexProcessRef[],
  statePath: string | null = codexStatePath(),
  taken: ReadonlySet<string> = new Set(),
): Promise<Map<number, string>> {
  if (procs.length === 0 || !statePath) return new Map()
  try {
    const earliest = Math.min(...procs.map(p => p.startedMs ?? Infinity))
    if (!Number.isFinite(earliest)) return new Map()
    return linkCodexProcesses(procs, readCodexThreads(statePath, earliest - 120_000), undefined, taken)
  } catch { return new Map() }
}
