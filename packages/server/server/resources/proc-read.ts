/**
 * resources/proc-read.ts — the IO half of the inventory: read `/proc` (Linux only) into `ProcEntry`s.
 *
 * Reads only processes owned by THIS uid — another user's process is not agentop's and its
 * environment is unreadable anyway. CPU is a rate, so it needs two samples: the previous tick's
 * per-pid CPU ticks are kept in this module and the first sample of a pid reports `null`, never a
 * made-up zero. Every read is guarded; a process that exits mid-read is simply skipped.
 */

import { readdir, readFile, readlink } from 'node:fs/promises'
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
  const want = new Set(['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'TMUX_PANE', 'AGENTISTICS_HELPER_ID', 'AGENTISTICS_HEAVY_JOB', 'HOME'])
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

async function uptimeSec(): Promise<number | null> {
  try { return Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]) } catch { return null }
}

/** Is this pid alive right now? */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Read every process of this uid whose argv could make it agentop's (cheap pre-filter on argv/exe),
 * plus any pid in `alwaysPids` (registered helpers, heavy jobs). `null` when `/proc` is unreadable.
 */
export async function readProcEntries(alwaysPids: ReadonlySet<number> = new Set()): Promise<ProcEntry[] | null> {
  if (process.platform !== 'linux') return null
  let names: string[]
  try { names = await readdir('/proc') } catch { return null }
  const up = await uptimeSec()
  const uid = process.getuid?.()
  const nowMs = Date.now()
  const next = new Map<number, { ticks: number; atMs: number }>()
  const out: ProcEntry[] = []
  // What each agentop process declared about itself — its environment is unreadable (proc-card.ts).
  const cards = readProcCards()
  await Promise.all(names.filter(n => /^\d+$/.test(n)).map(async n => {
    const pid = Number(n)
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      const uidLine = /^Uid:\s+(\d+)/m.exec(status)
      if (uid !== undefined && uidLine && Number(uidLine[1]) !== uid) return
      const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8')
      const argv = cmd.split('\0').filter(Boolean)
      const exe = await readlink(`/proc/${pid}/exe`).catch(() => null)
      let env = pickEnv(await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => ''))
      const card = cards.get(pid)
      const candidate = card !== undefined || alwaysPids.has(pid)
        || env.AGENTISTICS_HEAVY_JOB !== undefined || env.AGENTISTICS_HELPER_ID !== undefined
        || argv.some(a => /(^|\/)agentop(\.[\w-]+)?$/.test(a) || a.endsWith('packages/server/bin/cli.ts'))
        || /\/agentop[^/]*$/.test((exe ?? '').replace(/ \(deleted\)$/, ''))
      if (!candidate) return
      const stat = parseStat(await readFile(`/proc/${pid}/stat`, 'utf8'))
      if (!stat) return
      // A card counts only for the process that wrote it — same pid AND same start time.
      if (card && card.starttime === stat.starttime) env = { ...cardEnv(card), ...env }
      const kb = (key: string): number | null => {
        const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(status)
        return m ? Number(m[1]) * 1024 : null
      }
      const ticks = stat.utime + stat.stime
      next.set(pid, { ticks, atMs: nowMs })
      const prev = previous.get(pid)
      const cpuPercent = prev && nowMs > prev.atMs
        ? Math.round(((ticks - prev.ticks) / CLK_TCK) / ((nowMs - prev.atMs) / 1000) * 100)
        : null
      out.push({
        pid, ppid: stat.ppid, argv, exe,
        rssBytes: kb('VmRSS'), swapBytes: kb('VmSwap'),
        cpuPercent,
        ageSec: up !== null ? Math.max(0, Math.round(up - stat.starttime / CLK_TCK)) : 0,
        env,
      })
    } catch { /* exited mid-read, or not ours */ }
  }))
  previous = next
  // Cards whose process is gone, or whose pid now belongs to someone else.
  const live = new Map(await Promise.all([...cards.keys()].map(async pid => {
    const st = parseStat(await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''))
    return [pid, st?.starttime ?? null] as const
  })))
  sweepProcCards(c => live.get(c.pid) === c.starttime)
  return out
}

function cardEnv(c: ProcCard): ProcEntry['env'] {
  return {
    ...(c.home ? { HOME: c.home } : {}),
    ...(c.claudePid ? { CLAUDE_PID: String(c.claudePid) } : {}),
    ...(c.sessionId ? { CLAUDE_CODE_SESSION_ID: c.sessionId } : {}),
  }
}
