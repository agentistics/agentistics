/**
 * test-orphans.ts — what a `bun test` run left running, and which of it to end.
 *
 * Every process a run starts inherits `AGENTISTICS_TEST_RUNNER_PID=<runner pid>` from
 * `test-preload.ts`. At the end of the run (or on SIGINT/SIGTERM) anything still carrying THIS run's
 * marker is a leak: a structured relay, its child, its worker, a fixture shell. 31/10 one such leak
 * per test, accumulated over days of hook runs, took the real agentop server down with the OOM killer.
 *
 * Scope is deliberately narrow — the marker AND a command line naming this checkout or the temp dir —
 * so a process the run did not start (a tmux server on the default socket that a test merely talked
 * to, an editor) is never touched. Linux only: elsewhere there is no `/proc` and nothing is swept.
 */
import { readdirSync, readFileSync } from 'node:fs'

export const RUNNER_ENV = 'AGENTISTICS_TEST_RUNNER_PID'

/** The relay family: a leak of one of these FAILS the run (it is the one that ate the machine). */
export const RELAY_FAMILY = /structured-relay|__structured-relay|__relay-worker|fake-structured-agent/

export interface ProcInfo { pid: number; pgid: number; env: string[]; cmdline: string }

export interface SweepPlan {
  /** Every leaked pid, to SIGKILL. */
  kill: number[]
  /** Leaked process-group leaders: their whole group goes too (a relay's child runs in its own). */
  groups: number[]
  /** The leaked relay-family command lines (non-empty = the run failed to clean up). */
  relays: string[]
  /** Every other leaked command line (reported, not fatal). */
  others: string[]
}

export function planSweep(procs: ProcInfo[], runnerPid: number, roots: string[]): SweepPlan {
  const mark = `${RUNNER_ENV}=${runnerPid}`
  const plan: SweepPlan = { kill: [], groups: [], relays: [], others: [] }
  for (const p of procs) {
    if (p.pid === runnerPid || !p.env.includes(mark)) continue
    if (!roots.some(r => r !== '' && p.cmdline.includes(r))) continue
    plan.kill.push(p.pid)
    if (p.pgid === p.pid) plan.groups.push(p.pid)
    ;(RELAY_FAMILY.test(p.cmdline) ? plan.relays : plan.others).push(p.cmdline)
  }
  return plan
}

/** pgid is field 5 of /proc/<pid>/stat, counted after the `(comm)` that may itself hold spaces. */
export function pgidOfStat(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const pgid = Number(stat.slice(close + 2).split(' ')[2])
  return Number.isSafeInteger(pgid) ? pgid : null
}

export function readProcs(): ProcInfo[] {
  if (process.platform !== 'linux') return []
  const out: ProcInfo[] = []
  let names: string[]
  try { names = readdirSync('/proc') } catch { return [] }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const env = readFileSync(`/proc/${name}/environ`, 'utf8')
      if (!env.includes(RUNNER_ENV)) continue
      const pgid = pgidOfStat(readFileSync(`/proc/${name}/stat`, 'utf8'))
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ').trim()
      out.push({ pid: Number(name), pgid: pgid ?? -1, env: env.split('\0'), cmdline })
    } catch { /* gone, or not ours to read */ }
  }
  return out
}

/** End what the plan names. Groups first, so a child cannot be re-parented between the two kills. */
export function applySweep(plan: SweepPlan): void {
  for (const g of plan.groups) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } }
  for (const pid of plan.kill) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}
