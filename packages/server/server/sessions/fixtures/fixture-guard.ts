/**
 * fixture-guard.ts — TEST HELPER: which processes started by THIS `bun test` run are still running with
 * their working directory inside `root` (a rig's temp dir). A structured relay runs in its session
 * directory and its fake agent in the rig's cwd, so after a test's teardown this list must be EMPTY;
 * a test whose fixture survived it fails on the spot instead of feeding a leak that is only noticed when
 * the machine runs out of memory (03/11: ≈200 fake-structured-agent processes left by worker runs).
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function fixturesUnder(root: string): Array<{ pid: number; cmd: string }> {
  if (process.platform !== 'linux') return []
  const run = process.env.AGENTISTICS_TEST_RUNNER_PID
  const out: Array<{ pid: number; cmd: string }> = []
  let names: string[]
  try { names = readdirSync('/proc') } catch { return [] }
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue
    try {
      const cwd = readlinkSync(`/proc/${n}/cwd`)
      if (cwd !== root && !cwd.startsWith(`${root}/`)) continue
      if (run && !readFileSync(`/proc/${n}/environ`, 'utf8').split('\0').includes(`AGENTISTICS_TEST_RUNNER_PID=${run}`)) continue
      const stat = readFileSync(`/proc/${n}/stat`, 'utf8')
      if (stat[stat.lastIndexOf(')') + 2] === 'Z') continue
      out.push({ pid: Number(n), cmd: readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').join(' ').trim() })
    } catch { /* gone, or not ours */ }
  }
  return out
}

/** Waits up to `ms` for the fixtures under `root` to go; returns the survivors (SIGKILLed, so the next test is clean). */
export async function survivingFixtures(root: string, ms = 3000): Promise<Array<{ pid: number; cmd: string }>> {
  const until = Date.now() + ms
  let left = fixturesUnder(root)
  while (left.length && Date.now() < until) { await sleep(50); left = fixturesUnder(root) }
  for (const p of left) { try { process.kill(p.pid, 'SIGKILL') } catch { /* gone */ } }
  return left
}
