/**
 * resources/proc-read.ts — the IO half of the inventory: read `/proc` (Linux only) into `ProcEntry`s.
 *
 * Reads only processes owned by THIS uid — another user's process is not agentop's and its
 * environment is unreadable anyway. CPU is a rate, so it needs two samples: the previous tick's
 * per-pid CPU ticks are kept in this module and the first sample of a pid reports `null`, never a
 * made-up zero. Every read is guarded; a process that exits mid-read is simply skipped.
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import type { ProcEntry } from './inventory'
import { readProcCards, sweepProcCards, type ProcCard } from './proc-card'

/** `/proc/<pid>/stat` fields, from after the `comm` (which may hold spaces and parentheses). */
export function parseStat(text: string): { ppid: number; utime: number; stime: number; starttime: number } | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const f = text.slice(close + 2).split(' ')
  // After `) `: state(0) ppid(1) … utime(11) stime(12) … starttime(19)
  const ppid = Number(f[1])
  const utime = Number(f[11])
  const stime = Number(f[12])
  const starttime = Number(f[19])
  return [ppid, utime, stime, starttime].every(Number.isFinite) ? { ppid, utime, stime, starttime } : null
}

/** `KEY=value` entries of interest out of `/proc/<pid>/environ` — PURE. */
export function pickEnv(environ: string): ProcEntry['env'] {
  const want = new Set(['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'TMUX_PANE', 'AGENTISTICS_HELPER_ID', 'AGENTISTICS_HEAVY_JOB', 'HOME', 'AGENTOP_MANAGED_ID'])
  const out: Record<string, string> = {}
  for (const kv of environ.split('\0')) {
    const eq = kv.indexOf('=')
    if (eq <= 0) continue
    const k = kv.slice(0, eq)
    if (want.has(k)) out[k] = kv.slice(eq + 1)
  }
  return out as ProcEntry['env']
}

const CLK_TCK = 100
let previous = new Map<number, { ticks: number; atMs: number }>()

function uptimeSec(): number | null {
  try { return Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) } catch { return null }
}

/** The kernel start time of a pid, or null when it is gone — what makes a pid an identity. */
export function pidStarttime(pid: number): number | null {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = t.slice(t.lastIndexOf(')') + 2).split(' ')
    const n = Number(f[19])
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

/** Is this pid alive right now? */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** One row of the process table: what `/proc/<pid>/stat` says about a pid. */
export interface ProcStatRow { pid: number; comm: string; ppid: number; utime: number; stime: number; starttime: number }

/** `/proc/<pid>/stat` → a table row, `null` when it cannot be read whole — PURE. */
export function parseStatRow(pid: number, text: string): ProcStatRow | null {
  const open = text.indexOf('('), close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const st = parseStat(text)
  return st ? { pid, comm: text.slice(open + 1, close), ...st } : null
}

/**
 * How long one read of the process table is shared. The governor's tick asks for it twice (its own
 * inventory and the bare-`flock` jobs, `heavy-io.ts`) within milliseconds; a second sweep of every
 * process on the machine learns nothing the first did not.
 */
const TABLE_TTL_MS = 1_000
let tableMemo: { atMs: number; rows: ProcStatRow[] } | null = null

/**
 * Every pid's `stat`, read SYNCHRONOUSLY. These are procfs reads — no disk, microseconds each — and
 * issuing one async read per process sent several hundred tasks through the runtime's thread pool at
 * once: measured (PERF.IDLE, 380 processes) ~5.3 ms of CPU per sweep against ~1.9 ms read in line,
 * most of the difference being pool threads spinning on the burst. `null` when `/proc` is unreadable.
 */
export function readProcTable(nowMs = Date.now()): ProcStatRow[] | null {
  if (process.platform !== 'linux') return null
  if (tableMemo && nowMs - tableMemo.atMs < TABLE_TTL_MS && nowMs >= tableMemo.atMs) return tableMemo.rows
  let names: string[]
  try { names = readdirSync('/proc') } catch { return null }
  const rows: ProcStatRow[] = []
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    let text: string
    try { text = readFileSync(`/proc/${n}/stat`, 'utf8') } catch { continue }
    const row = parseStatRow(Number(n), text)
    if (row) rows.push(row)
  }
  tableMemo = { atMs: nowMs, rows }
  return rows
}

/**
 * What a process IS — owner, argv, exe, the environment entries of interest — decided once per
 * process identity (pid + kernel start time + comm; an exec changes the comm) instead of once per
 * tick: the governor used to read status, cmdline, exe and environ of EVERY process on the machine
 * every 30 s to find the handful that are agentop's. Re-read after `IDENTITY_TTL_MS` regardless, so
 * an exec that kept its comm, or an argv rewritten in place, is picked up within minutes.
 */
interface ProcIdentity { key: string; atMs: number; ours: boolean; intrinsic: boolean; argv: string[]; exe: string | null; env: ProcEntry['env'] }
const IDENTITY_TTL_MS = 5 * 60_000
const identities = new Map<number, ProcIdentity>()

function readSync(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}
function readlinkQuiet(path: string): string | null {
  try { return readlinkSync(path) } catch { return null }
}

function identityOf(row: ProcStatRow, uid: number | undefined, nowMs: number): ProcIdentity | null {
  const key = `${row.starttime}:${row.comm}`
  const known = identities.get(row.pid)
  if (known && known.key === key && nowMs - known.atMs < IDENTITY_TTL_MS && nowMs >= known.atMs) return known
  const status = readSync(`/proc/${row.pid}/status`)
  if (status === null) return null
  const uidLine = /^Uid:\s+(\d+)/m.exec(status)
  const ours = !(uid !== undefined && uidLine && Number(uidLine[1]) !== uid)
  let argv: string[] = [], exe: string | null = null, env: ProcEntry['env'] = {}
  if (ours) {
    const cmd = readSync(`/proc/${row.pid}/cmdline`)
    if (cmd === null) return null
    argv = cmd.split('\0').filter(Boolean)
    exe = readlinkQuiet(`/proc/${row.pid}/exe`)
    env = pickEnv(readSync(`/proc/${row.pid}/environ`) ?? '')
  }
  const intrinsic = ours && (env.AGENTISTICS_HEAVY_JOB !== undefined || env.AGENTISTICS_HELPER_ID !== undefined
    || argv.some(a => /(^|\/)agentop(\.[\w-]+)?$/.test(a) || a.endsWith('packages/server/bin/cli.ts'))
    || /\/agentop[^/]*$/.test((exe ?? '').replace(/ \(deleted\)$/, '')))
  const id: ProcIdentity = { key, atMs: nowMs, ours, intrinsic, argv, exe, env }
  identities.set(row.pid, id)
  return id
}

/**
 * Read every process of this uid whose argv could make it agentop's (cheap pre-filter on argv/exe),
 * plus any pid in `alwaysPids` (registered helpers, heavy jobs). `null` when `/proc` is unreadable.
 */
export async function readProcEntries(alwaysPids: ReadonlySet<number> = new Set()): Promise<ProcEntry[] | null> {
  const nowMs = Date.now()
  const table = readProcTable(nowMs)
  if (!table) return null
  const up = uptimeSec()
  const uid = process.getuid?.()
  const next = new Map<number, { ticks: number; atMs: number }>()
  const out: ProcEntry[] = []
  // What each agentop process declared about itself — its environment is unreadable (proc-card.ts).
  const cards = readProcCards()
  const starttimes = new Map<number, number>()
  for (const stat of table) {
    starttimes.set(stat.pid, stat.starttime)
    const pid = stat.pid
    try {
      const id = identityOf(stat, uid, nowMs)
      if (!id || !id.ours) continue
      const card = cards.get(pid)
      const candidate = id.intrinsic || card !== undefined || alwaysPids.has(pid)
      if (!candidate) continue
      const status = readSync(`/proc/${pid}/status`)
      if (status === null) continue
      let env = id.env
      const cwdGone = (readlinkQuiet(`/proc/${pid}/cwd`) ?? '').endsWith(' (deleted)')
      const ancestorManagedId = env.AGENTOP_MANAGED_ID ? undefined : ancestorManagedIdOf(stat.ppid)
      // A card counts only for the process that wrote it — same pid AND same start time.
      const own = card && card.starttime === stat.starttime ? card : undefined
      if (own) env = { ...cardEnv(own), ...env }
      const kb = (key: string): number | null => {
        const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(status)
        return m ? Number(m[1]) * 1024 : null
      }
      const ticks = stat.utime + stat.stime
      next.set(pid, { ticks, atMs: nowMs })
      const prev = previous.get(pid)
      const cpuPercent = prev && nowMs > prev.atMs
        ? Math.round(((ticks - prev.ticks) / CLK_TCK) / ((nowMs - prev.atMs) / 1000) * 100)
        // First sight of a pid: no earlier sample, so report its lifetime average (measured, and
        // labelled by the column as CPU) instead of N/A on every row of a fresh snapshot.
        : up !== null && up - stat.starttime / CLK_TCK > 0.5
          ? Math.round(ticks / CLK_TCK / (up - stat.starttime / CLK_TCK) * 100)
          : null
      out.push({
        pid, ppid: stat.ppid, argv: id.argv, exe: id.exe,
        rssBytes: kb('VmRSS'), swapBytes: kb('VmSwap'),
        cpuPercent,
        ageSec: up !== null ? Math.max(0, Math.round(up - stat.starttime / CLK_TCK)) : 0,
        env,
        ...(cwdGone ? { cwdGone } : {}),
        ...(ancestorManagedId ? { ancestorManagedId } : {}),
        ...(own?.owner ? { cardOwner: own.owner } : {}),
      })
    } catch { /* exited mid-read, or not ours */ }
  }
  previous = next
  // Forget the identities of processes that are gone, so the memo is as large as the table.
  for (const pid of identities.keys()) if (!starttimes.has(pid)) identities.delete(pid)
  // Cards whose process is gone, or whose pid now belongs to someone else.
  sweepProcCards(c => starttimes.get(c.pid) === c.starttime)
  return out
}

function cardEnv(c: ProcCard): ProcEntry['env'] {
  return {
    ...(c.home ? { HOME: c.home } : {}),
    ...(c.claudePid ? { CLAUDE_PID: String(c.claudePid) } : {}),
    ...(c.sessionId ? { CLAUDE_CODE_SESSION_ID: c.sessionId } : {}),
  }
}

/** Walk up to 6 ancestors for the nearest AGENTOP_MANAGED_ID (the session an MCP was started under). */
function ancestorManagedIdOf(ppid: number): string | undefined {
  let pid = ppid
  for (let i = 0; i < 6 && pid > 1; i++) {
    const env = pickEnv(readSync(`/proc/${pid}/environ`) ?? '')
    if (env.AGENTOP_MANAGED_ID) return env.AGENTOP_MANAGED_ID
    const st = parseStat(readSync(`/proc/${pid}/stat`) ?? '')
    if (!st) return undefined
    pid = st.ppid
  }
  return undefined
}
