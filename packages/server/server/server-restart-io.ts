/**
 * The IO half of `server-restart-plan.ts`: read the facts the plan decides on, and perform the one
 * hand-made restart it allows (no service manager installed at all).
 */
import { readdirSync, readFileSync } from 'fs'
import { probeInstanceLock } from './single-instance.ts'
import type { ServerProc } from './server-restart-plan.ts'

/** Every process `/proc` lets us read, with its argv and cgroup. Linux only; elsewhere `[]`. */
export function readProcs(): ServerProc[] {
  let entries: string[]
  try { entries = readdirSync('/proc') } catch { return [] }
  const out: ServerProc[] = []
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (argv.length === 0) continue
      let cgroup = ''
      try { cgroup = readFileSync(`/proc/${name}/cgroup`, 'utf8') } catch { /* unreadable — treated as unmanaged */ }
      out.push({ pid: Number(name), argv, cgroup })
    } catch { /* gone, or not ours */ }
  }
  return out
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export interface HandoverDeps {
  kill?: (pid: number, sig: NodeJS.Signals) => void
  isAlive?: (pid: number) => boolean
  lockHolder?: () => Promise<number | null>
  spawnServer?: () => void
  sleep?: (ms: number) => Promise<void>
  /** How long each stopped server gets to exit (and release the data-dir lock) before SIGKILL. */
  termMs?: number
  killMs?: number
}

/**
 * Stop the given unmanaged servers and start ONE detached replacement — but only once every old
 * one has exited and the data-dir lock is free. The old fallback sent SIGKILL a fixed second after
 * SIGTERM and spawned regardless, so the new process could race a dying one for the lock and port.
 * Returns a failure sentence when the handover could not be completed; nothing is spawned then.
 */
export async function handOverDetached(pids: readonly number[], lockFile: string, deps: HandoverDeps = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const kill = deps.kill ?? ((pid, sig) => { process.kill(pid, sig) })
  const isAlive = deps.isAlive ?? alive
  const lockHolder = deps.lockHolder ?? (() => probeInstanceLock(lockFile))
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const termMs = deps.termMs ?? 15_000
  const killMs = deps.killMs ?? 5_000
  const step = 250

  const waitGone = async (budget: number) => {
    for (let t = 0; t < budget; t += step) {
      if (pids.every(p => !isAlive(p)) && (await lockHolder()) === null) return true
      await sleep(step)
    }
    return pids.every(p => !isAlive(p)) && (await lockHolder()) === null
  }

  for (const pid of pids) { try { kill(pid, 'SIGTERM') } catch { /* already gone */ } }
  if (!(await waitGone(termMs))) {
    for (const pid of pids) { if (isAlive(pid)) { try { kill(pid, 'SIGKILL') } catch { /* gone */ } } }
    if (!(await waitGone(killMs))) {
      const holder = await lockHolder()
      return { ok: false, reason: `the old server did not exit${holder ? ` (pid ${holder} still holds the data dir)` : ''} — not starting a second one` }
    }
  }
  if (deps.spawnServer) deps.spawnServer()
  return { ok: true }
}
