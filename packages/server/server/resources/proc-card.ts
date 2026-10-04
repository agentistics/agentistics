/**
 * resources/proc-card.ts — every agentop process DECLARES who it is, because `/proc` will not say.
 *
 * Measured 2026-10-03: Bun marks its processes non-dumpable, so `/proc/<pid>/environ` and
 * `/proc/<pid>/cwd` of every agentop process (the compiled binary and `bun cli.ts` alike) are owned by
 * root and unreadable even to the same user. The governor's owner rule (`CLAUDE_PID`) and its
 * isolated-HOME rule both read the environment, so without this they would see nothing for exactly
 * the processes they exist to judge.
 *
 * So each agentop process writes one small card at boot into a per-uid runtime directory shared by
 * every HOME (`$XDG_RUNTIME_DIR/agentop/procs`, else `/tmp/agentop-<uid>/procs`, mode 0700) and
 * removes it on a clean exit. A card carries no secret: a HOME path, a parent session's pid and id.
 * It is keyed by pid AND the kernel start time, so a card left by a killed process can never be
 * attributed to a later process that reused the pid. A process with no card (an old binary, a
 * process from before this existed) simply has no owner on record, which the governor reads as
 * "unknown" — never as "owner ended".
 */

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ProcCard {
  pid: number
  /** `/proc/<pid>/stat` field 22, so a reused pid never inherits this card. */
  starttime: number
  home?: string
  claudePid?: number
  sessionId?: string
  command: string
  version?: string
}

export function procCardDir(): string {
  const uid = process.getuid?.() ?? 0
  const runtime = process.env.XDG_RUNTIME_DIR
  return runtime ? join(runtime, 'agentop', 'procs') : join(tmpdir(), `agentop-${uid}`, 'procs')
}

function ownStarttime(): number | null {
  try {
    const t = readFileSync('/proc/self/stat', 'utf8')
    const f = t.slice(t.lastIndexOf(')') + 2).split(' ')
    const n = Number(f[19])
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

/** Write this process's card. Linux only; never throws — a card is a courtesy, not a requirement. */
export function writeProcCard(command: string, version?: string, dir = procCardDir()): void {
  if (process.platform !== 'linux') return
  const starttime = ownStarttime()
  if (starttime === null) return
  const claudePid = Number(process.env.CLAUDE_PID)
  const card: ProcCard = {
    pid: process.pid,
    starttime,
    command,
    ...(process.env.HOME ? { home: process.env.HOME } : {}),
    ...(Number.isInteger(claudePid) && claudePid > 0 ? { claudePid } : {}),
    ...(process.env.CLAUDE_CODE_SESSION_ID ? { sessionId: process.env.CLAUDE_CODE_SESSION_ID } : {}),
    ...(version ? { version } : {}),
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${process.pid}.json`)
    writeFileSync(file, JSON.stringify(card), { mode: 0o600 })
    process.once('exit', () => { try { unlinkSync(file) } catch { /* already gone */ } })
  } catch { /* unwritable runtime dir — no card */ }
}

/** Every card on file, by pid. The caller checks `starttime` against `/proc`. */
export function readProcCards(dir = procCardDir()): Map<number, ProcCard> {
  const out = new Map<number, ProcCard>()
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return out }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const c = JSON.parse(readFileSync(join(dir, n), 'utf8')) as ProcCard
      if (typeof c.pid === 'number' && typeof c.starttime === 'number') out.set(c.pid, c)
    } catch { /* half-written */ }
  }
  return out
}

/** Drop the cards whose process is gone (or whose pid was reused) — the governor's sweep. */
export function sweepProcCards(valid: (card: ProcCard) => boolean, dir = procCardDir()): number {
  let removed = 0
  for (const c of readProcCards(dir).values()) {
    if (valid(c)) continue
    try { unlinkSync(join(dir, `${c.pid}.json`)); removed++ } catch { /* raced */ }
  }
  return removed
}
