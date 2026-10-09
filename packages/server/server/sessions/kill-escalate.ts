/**
 * kill-escalate.ts — what happens to a session's PROCESSES after its tmux session is killed.
 *
 * `tmux kill-session` ends the session by sending SIGHUP to the pane's process group, and that is
 * the whole of it. A harness that ignores SIGHUP — measured: `gemini --resume`, 2 of 2 kills — is
 * left running as an orphan, and the next reopen of the same conversation then refuses on it
 * ("already in use") and lands as another dead row, while the registry says the session is finished.
 * Confirming the tmux session is gone is therefore not confirming the SESSION is gone.
 *
 * So the pids are taken BEFORE the kill (afterwards the survivors are reparented to init and nothing
 * links them to the row any more), given a short grace to exit on their own, and whatever is still
 * there is SIGKILLed. Three rules keep this from becoming a gun pointed at the wrong process:
 *  - the pids are the ROW'S OWN — the pane pid and what runs beneath it — never found by name;
 *  - a pid is signalled only while it is still the SAME process (its /proc start time is compared),
 *    because a pid freed and reused during the grace is somebody else's;
 *  - the logic is pure over an injected `EscalateIO`, so the timing is tested without waiting.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { childrenOf } from './process-conversation'

/** A process as it was when the session was alive: the pid and the start time that makes it unique. */
export interface PidRef {
  pid: number
  /** `/proc/<pid>/stat` field 22, or `null` where it cannot be read (then only the pid identifies it). */
  start: string | null
}

export interface EscalateIO {
  /** Is `ref` still running AS THE SAME PROCESS? A reused pid answers false. */
  alive(ref: PidRef): boolean
  /** Sends `signal`; false when it could not be delivered (already gone, or not ours). */
  signal(pid: number, signal: 'SIGKILL'): boolean
  sleep(ms: number): Promise<void>
  now(): number
}

export interface EscalateOptions {
  /** How long the processes get to exit on their own after the hang-up. */
  graceMs?: number
  /** How long to wait for a SIGKILL to take effect before reporting the process as stuck. */
  killWaitMs?: number
  pollMs?: number
}

export const KILL_GRACE_MS = 2_500
export const KILL_WAIT_MS = 1_500
const POLL_MS = 50

export interface EscalateResult {
  /** Needed SIGKILL, and it worked. */
  killed: number[]
  /** Still running after SIGKILL (uninterruptible sleep, or not ours to signal). */
  stuck: number[]
}

/**
 * Wait for `refs` to exit; SIGKILL whatever outlasts the grace. Resolves as soon as every one is
 * gone, so an ordinary kill — where the hang-up does its job — costs one poll, not the grace.
 */
export async function escalateKill(refs: readonly PidRef[], io: EscalateIO, opts: EscalateOptions = {}): Promise<EscalateResult> {
  const graceMs = opts.graceMs ?? KILL_GRACE_MS
  const killWaitMs = opts.killWaitMs ?? KILL_WAIT_MS
  const pollMs = opts.pollMs ?? POLL_MS
  const survivors = (): PidRef[] => refs.filter(r => io.alive(r))

  const waitUntilGone = async (ms: number): Promise<PidRef[]> => {
    const until = io.now() + ms
    let left = survivors()
    while (left.length > 0 && io.now() < until) {
      await io.sleep(pollMs)
      left = survivors()
    }
    return left
  }

  const afterGrace = await waitUntilGone(graceMs)
  if (afterGrace.length === 0) return { killed: [], stuck: [] }

  for (const r of afterGrace) io.signal(r.pid, 'SIGKILL')
  const afterKill = await waitUntilGone(killWaitMs)
  const stuck = new Set(afterKill.map(r => r.pid))
  return { killed: afterGrace.filter(r => !stuck.has(r.pid)).map(r => r.pid), stuck: [...stuck] }
}

// ── the real /proc ────────────────────────────────────────────────────────────────────────────────

/** `/proc/<pid>/stat` field 22 (starttime). The command name sits in parentheses and may hold spaces. */
export function startTimeOf(stat: string): string | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const rest = stat.slice(close + 2).split(' ')
  // After `(comm)` come state (field 3) onward, so field 22 is index 19.
  const v = rest[19]
  return v && /^\d+$/.test(v) ? v : null
}

async function startOf(pid: number): Promise<string | null> {
  try { return startTimeOf(await readFile(`/proc/${pid}/stat`, 'utf-8')) } catch { return null }
}

const MAX_DEPTH = 8
const MAX_PIDS = 64

/** The pane process and everything running beneath it, with identities. `[]` off Linux or when it is gone. */
export async function collectOwnPids(panePid: number | undefined): Promise<PidRef[]> {
  if (!panePid || process.platform !== 'linux') return []
  const out: PidRef[] = []
  const seen = new Set<number>()
  const visit = async (pid: number, depth: number): Promise<void> => {
    if (seen.has(pid) || out.length >= MAX_PIDS) return
    seen.add(pid)
    const start = await startOf(pid)
    if (start === null) return // not readable: gone, or not ours — nothing to hold it to later
    out.push({ pid, start })
    if (depth >= MAX_DEPTH) return
    for (const c of await childrenOf(pid)) await visit(c, depth + 1)
  }
  await visit(panePid, 0)
  return out
}

/** Is this `/proc/<pid>/stat` a zombie? It keeps a /proc entry until its parent reaps it and runs nothing. */
export function isZombie(stat: string): boolean {
  const close = stat.lastIndexOf(')')
  return close >= 0 && stat[close + 2] === 'Z'
}

/** The default IO: `process.kill(pid, 0)` for liveness, confirmed against the recorded start time. */
export function procIO(): EscalateIO {
  return {
    alive(ref) {
      try { process.kill(ref.pid, 0) } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
      if (ref.start === null) return true
      try {
        const stat = readFileSync(`/proc/${ref.pid}/stat`, 'utf-8')
        return startTimeOf(stat) === ref.start && !isZombie(stat)
      } catch { return false }
    },
    signal(pid, signal) {
      try { process.kill(pid, signal); return true } catch { return false }
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}
