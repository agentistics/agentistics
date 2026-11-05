/**
 * codex-thread-log.ts — IO half of `codex-thread-link.ts`: reads Codex's own `threads` table, READ-ONLY.
 * Total: any failure (no file, locked, schema drift) is an empty answer, i.e. an unlinked row as before.
 *
 * WHICH database: the native binary keeps its `state_<n>.sqlite` open, so the fd names the file — that covers
 * `CODEX_HOME` and the account roots under `~/.agentistics/accounts/codex/…` without guessing. Only a process
 * with no such fd falls back to `~/.codex` (`CODEX_DIR` overrides).
 */
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linkCodexProcesses, START_SKEW_MS, type CodexProcessRef, type CodexThread } from './codex-thread-link'

/** The highest-numbered `state_<n>.sqlite` under the codex home (`CODEX_DIR` overrides `~/.codex`). */
export function codexStatePath(dir: string = process.env.CODEX_DIR ?? join(homedir(), '.codex')): string | null {
  try {
    const nums = readdirSync(dir).map(n => /^state_(\d+)\.sqlite$/.exec(n)?.[1]).filter((n): n is string => !!n).map(Number)
    if (nums.length === 0) return null
    const p = join(dir, `state_${Math.max(...nums)}.sqlite`)
    return existsSync(p) ? p : null
  } catch { return null }
}

/** The highest-numbered `state_<n>.sqlite` among a process's open fd targets (pure). */
export function codexStatePathOfFds(targets: readonly string[]): string | null {
  let best: { n: number; p: string } | null = null
  for (const t of targets) {
    const m = /\/state_(\d+)\.sqlite$/.exec(t)
    if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), p: t }
  }
  return best?.p ?? null
}

/** The state database this process holds open, or null (no fd, unreadable, gone). */
export function codexStatePathOfPid(pid: number, procRoot = '/proc'): string | null {
  try {
    const targets: string[] = []
    for (const fd of readdirSync(`${procRoot}/${pid}/fd`)) {
      try { targets.push(readlinkSync(`${procRoot}/${pid}/fd/${fd}`)) } catch { /* closed meanwhile */ }
    }
    return codexStatePathOfFds(targets)
  } catch { return null }
}

/** Interactive threads created in [fromMs, toMs] — not `codex exec`, not subagents. No row cap. */
export function readCodexThreads(path: string, fromMs: number, toMs: number): CodexThread[] {
  const db = new Database(path, { readonly: true })
  try {
    const rows = db.query(
      "SELECT id, cwd, created_at_ms, archived FROM threads WHERE created_at_ms BETWEEN ? AND ? AND source <> 'exec' AND agent_role IS NULL",
    ).all(fromMs, toMs) as Array<{ id: string; cwd: string; created_at_ms: number | null; archived: number }>
    return rows.filter(r => typeof r.created_at_ms === 'number')
      .map(r => ({ id: r.id, cwd: r.cwd, createdMs: r.created_at_ms!, archived: !!r.archived }))
  } finally { db.close() }
}

export interface CodexScanProc extends CodexProcessRef {
  /** Conversation this process already names (argv / fd / registry): it links nothing, but its id is taken. */
  knownId?: string
  /** The state database it holds open, when it was found. */
  statePath?: string | null
}

const POSITIVE_TTL_MS = 30_000
const NEGATIVE_TTL_MS = 10_000
const memo = new Map<string, { at: number; id: string | null }>()

/**
 * Link every codex process in `procs` (ALL of them, linked or not — ambiguity is judged against the whole
 * set, as opencode does). Grouped by database; each process asks only for the threads inside ITS window.
 * Positive answers are remembered 30 s, negatives 10 s, so a poll every 5 s does not reopen the database.
 */
export async function readCodexProcessSessions(
  procs: readonly CodexScanProc[],
  fallbackPath: string | null = codexStatePath(),
  taken: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  try {
    const takenAll = new Set(taken)
    for (const p of procs) if (p.knownId) takenAll.add(p.knownId)
    const byPath = new Map<string, CodexScanProc[]>()
    for (const p of procs) {
      const path = p.statePath ?? fallbackPath
      if (!path) continue
      let g = byPath.get(path); if (!g) byPath.set(path, g = [])
      g.push(p)
    }
    for (const [path, group] of byPath) {
      const open = group.filter(p => !p.knownId && p.startedMs !== undefined)
      const cached = new Map<number, string | null>()
      const ask: CodexScanProc[] = []
      for (const p of open) {
        const hit = memo.get(`${path}|${p.pid}|${p.startedMs}`)
        if (hit && now - hit.at < (hit.id ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) cached.set(p.pid, hit.id)
        else ask.push(p)
      }
      if (ask.length > 0) {
        let threads: CodexThread[] = []
        try {
          const byId = new Map<string, CodexThread>()
          for (const p of group) {
            if (p.startedMs === undefined) continue
            for (const t of readCodexThreads(path, p.startedMs - START_SKEW_MS, p.startedMs + START_SKEW_MS)) byId.set(t.id, t)
          }
          threads = [...byId.values()]
        } catch { continue }
        const linked = linkCodexProcesses(open, threads, undefined, takenAll)
        for (const p of ask) memo.set(`${path}|${p.pid}|${p.startedMs}`, { at: now, id: linked.get(p.pid) ?? null })
        for (const [pid, id] of linked) cached.set(pid, id)
      }
      for (const [pid, id] of cached) if (id) out.set(pid, id)
    }
    if (memo.size > 500) for (const [k, v] of memo) if (now - v.at > POSITIVE_TTL_MS) memo.delete(k)
  } catch { /* total */ }
  return out
}
