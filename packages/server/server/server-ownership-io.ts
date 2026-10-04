/**
 * The IO half of `server-ownership.ts`: read the facts, take back a stray, start the unit.
 *
 * Every launcher that used to spawn its own `agentop server` asks `serviceOwnsServerHere()` first,
 * and when the answer is yes calls `startServerUnit()` instead — the one way a server may come up
 * on a machine whose service manager owns it.
 */
import { readFileSync } from 'fs'
import { platform } from 'os'
import {
  FOREGROUND_ENV, isInsideUnit, planServerStart, planStrayReclaim, serviceOwnsServer,
  type OwnershipFacts, type ReclaimPlan, type StartRoute,
} from './server-ownership.ts'
import type { ServerProc } from './server-restart-plan.ts'

export const SERVER_UNIT = 'agentop-server'

/** The facts every decision in `server-ownership.ts` is made from. */
export async function ownershipFacts(): Promise<OwnershipFacts> {
  const { unitInstalled } = await import('./autostart.ts')
  const { isOwnersStore } = await import('./server-ports.ts')
  const { accountHome } = await import('./account-home.ts')
  const { AGENTISTICS_DATA_DIR } = await import('./config.ts')
  let cgroup = ''
  try { cgroup = readFileSync('/proc/self/cgroup', 'utf8') } catch { /* not Linux */ }
  return {
    platform: platform(),
    unitInstalled: await unitInstalled('server'),
    ownersStore: isOwnersStore(AGENTISTICS_DATA_DIR, accountHome()),
    insideUnit: isInsideUnit(cgroup, process.env.INVOCATION_ID),
    foregroundForced: process.env[FOREGROUND_ENV] === '1',
  }
}

/** Should a launcher here go through the unit instead of spawning a server? */
export async function serviceOwnsServerHere(): Promise<boolean> {
  return serviceOwnsServer(await ownershipFacts())
}

/** The route a hand-run `agentop server` takes. */
export async function serverStartRoute(): Promise<StartRoute> {
  return planServerStart(await ownershipFacts())
}

function readProc(pid: number): ServerProc | null {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    let cgroup = ''
    try { cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8') } catch { /* unreadable */ }
    return argv.length ? { pid, argv, cgroup } : null
  } catch {
    return null
  }
}

export type ReclaimResult =
  | { kind: 'none' }
  | { kind: 'reclaimed'; pid: number }
  | { kind: 'failed'; pid: number; reason: string }
  | { kind: 'unproven'; pid: number }

export interface ReclaimDeps {
  holder?: () => Promise<number | null>
  readProc?: (pid: number) => ServerProc | null
  stop?: (pid: number) => Promise<{ ok: true } | { ok: false; reason: string }>
  selfPid?: number
}

/**
 * Stop the server holding THIS data dir when — and only when — it is provably ours and outside
 * the unit (`planStrayReclaim`), and wait until the lock is free. Starts nothing: the caller is
 * the unit (which then claims the data dir) or a path that starts the unit next.
 */
export async function reclaimStrayServer(deps: ReclaimDeps = {}): Promise<ReclaimResult> {
  const { serverLockFile } = await import('./config.ts')
  const { probeInstanceLock } = await import('./single-instance.ts')
  const lock = serverLockFile()
  const holder = await (deps.holder ?? (() => probeInstanceLock(lock).catch(() => null)))()
  const plan: ReclaimPlan = planStrayReclaim({
    holder,
    proc: holder === null ? null : (deps.readProc ?? readProc)(holder),
    selfPid: deps.selfPid ?? process.pid,
  })
  if (plan.kind === 'none') return { kind: 'none' }
  if (plan.kind === 'unproven') return { kind: 'unproven', pid: plan.pid }
  const stop = deps.stop ?? (async (pid: number) => {
    const { handOverDetached } = await import('./server-restart-io.ts')
    return handOverDetached([pid], lock)
  })
  const r = await stop(plan.pid)
  return r.ok ? { kind: 'reclaimed', pid: plan.pid } : { kind: 'failed', pid: plan.pid, reason: r.reason }
}

async function exec(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, stdout, stderr }
  } catch (err) {
    return { code: 127, stdout: '', stderr: String((err as Error)?.message ?? err) }
  }
}

export interface StartUnitDeps {
  run?: typeof exec
  answering?: () => Promise<boolean>
  reclaim?: () => Promise<ReclaimResult>
  timeoutMs?: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type StartUnitResult =
  | { ok: true; message: string }
  /** `unreachable`: the user manager could not be asked (no bus) — the caller may fall back. */
  | { ok: false; unreachable: boolean; message: string }

/**
 * Bring THIS machine's server up THROUGH the unit: take back a provable stray (so the unit is not
 * refused), clear a `failed` state (a unit left failed by a refused start never retries on its
 * own), `systemctl --user start`, and wait for the server to answer.
 */
export async function startServerUnit(deps: StartUnitDeps = {}): Promise<StartUnitResult> {
  const run = deps.run ?? exec
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const answering = deps.answering ?? (async () => {
    const { PORT } = await import('./config.ts')
    try { return (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok } catch { return false }
  })
  const reclaimed = await (deps.reclaim ?? (() => reclaimStrayServer()))()
  if (reclaimed.kind === 'failed') {
    return { ok: false, unreachable: false, message: `the server outside ${SERVER_UNIT} (pid ${reclaimed.pid}) did not stop: ${reclaimed.reason}` }
  }
  if (reclaimed.kind === 'unproven') {
    // Something holds the data dir that cannot be proven to be our own server: starting the unit
    // would only be refused, and "started" would be read off THAT process answering.
    return { ok: false, unreachable: false, message: `pid ${reclaimed.pid} holds the data directory and is not an agentop server this machine can stop — it was left alone` }
  }
  await run(['systemctl', '--user', 'reset-failed', SERVER_UNIT])
  const r = await run(['systemctl', '--user', 'start', SERVER_UNIT])
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim()
    const unreachable = /bus|XDG_RUNTIME_DIR|Failed to connect/i.test(why) || r.code === 127
    return { ok: false, unreachable, message: `systemctl --user start ${SERVER_UNIT} failed: ${why || `exit ${r.code}`}` }
  }
  const timeoutMs = deps.timeoutMs ?? 60_000
  const intervalMs = deps.intervalMs ?? 500
  for (let t = 0; t <= timeoutMs; t += intervalMs) {
    if (await answering()) {
      const note = reclaimed.kind === 'reclaimed' ? ` (stopped pid ${reclaimed.pid}, which ran outside it)` : ''
      return { ok: true, message: `started the ${SERVER_UNIT} service${note}` }
    }
    await sleep(intervalMs)
  }
  return { ok: false, unreachable: false, message: `${SERVER_UNIT} started but the server did not answer within ${Math.round(timeoutMs / 1000)}s — \`journalctl --user -u ${SERVER_UNIT}\` says why` }
}
