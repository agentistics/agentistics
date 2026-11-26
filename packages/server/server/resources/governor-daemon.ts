/**
 * resources/governor-daemon.ts — runs the governor inside `agentop server`, every `TICK_MS`.
 *
 * One tick: prune dead helpers, read `/proc`, build the inventory, plan, carry out the kills (SIGTERM,
 * then SIGKILL if the process is still there after `KILL_GRACE_MS`), and announce what is NEW — a kill
 * always, an alert once per (pid, reason) for as long as it holds. The last snapshot is kept for
 * `GET /api/resources` so the route never reads `/proc` on a request.
 *
 * `AGENTISTICS_GOVERNOR=0` turns the KILLS off (the inventory and the alerts still run): an escape
 * hatch for debugging a process by hand, never a default.
 */

import { readProcEntries, pidAlive, pidStarttime } from './proc-read'
import { memoryAlarmStep, type MemAlarmState } from './mem-guard'
import { buildInventory, DEFAULT_TEMP_ROOTS, type AgentopProcess } from './inventory'
import { tmpdir } from 'node:os'
import { planGovernor, type Alert, type Kill } from './governor'
import { readHelpers, mutateHelpers, pruneHelpers, HELPERS_FILE, type HelperRecord } from './helpers'
import { readHeavyState, type HeavyState } from './heavy-io'
import { registeredSpawnQueue } from '../sessions/spawn-queue'
import { reaperState, startSessionReaper, type ReaperState } from '../sessions/session-reaper-io'
import { dirname, join } from 'node:path'
import { evaluateHealth, healthBlock, HEALTH_TICK_MS, type HealthBlock, type HealthState } from './machine-health'
import { createHealthApiCache, createHealthReader, createSampleLog, type HealthApiCache, type HealthIo, type HealthReader, type SampleLog } from './machine-health-io'

export const TICK_MS = 30_000
export const KILL_GRACE_MS = 5_000
const RECENT_MAX = 50

export interface ResourcesSnapshot {
  atMs: number
  /** `false` when `/proc` could not be read here — the panel says so instead of drawing an empty list. */
  measured: boolean
  inventory: AgentopProcess[]
  alerts: Alert[]
  helpers: HelperRecord[]
  heavy: HeavyState
  /** The kills this server carried out, newest first, capped. */
  recent: Array<Kill & { atMs: number }>
  killsEnabled: boolean
  /** Spawns the memory gate refused and is holding until room frees (sessions/spawn-queue.ts). */
  spawnQueue: Array<{ id: string; label: string; sinceMs: number; position: number }>
  /** The collector of closed sessions' leftover processes (sessions/session-reaper-io.ts). */
  reaper?: ReaperState
}

export interface GovernorDeps {
  notify: (n: { type: 'warning' | 'info'; code: string; meta: Record<string, unknown> }) => void
  log: (line: string) => void
}

let snapshot: ResourcesSnapshot | null = null
const recent: Array<Kill & { atMs: number }> = []
const announced = new Set<string>()
let timer: ReturnType<typeof setInterval> | null = null
let running: Promise<ResourcesSnapshot> | null = null
let lastStaleMcpCount = 0
let memAlarm: MemAlarmState = { raised: false }

export function resourcesSnapshot(): ResourcesSnapshot | null {
  // The queue moves between ticks (a spawn queued a second ago); read it live.
  return snapshot ? { ...snapshot, spawnQueue: registeredSpawnQueue()?.list() ?? [], reaper: reaperState() } : null
}

const killsEnabled = (): boolean => process.env.AGENTISTICS_GOVERNOR !== '0'

function terminate(pid: number): void {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  setTimeout(() => { if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }, KILL_GRACE_MS).unref?.()
}

async function memAvailableNow(): Promise<number | null> {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(await Bun.file('/proc/meminfo').text())
    return m ? Number(m[1]) * 1024 : null
  } catch { return null }
}

/** One governor pass. Concurrent callers share the pass in flight. */
export function governorTick(deps: GovernorDeps): Promise<ResourcesSnapshot> {
  if (running) return running
  running = (async () => {
    const nowMs = Date.now()
    const helpers = await mutateHelpers(rs => {
      const next = pruneHelpers(rs, pidAlive)
      return { next, result: next }
    }).catch(() => readHelpers())
    const heavy = await readHeavyState()
    const always = new Set<number>([...helpers.map(h => h.pid), ...heavy.running.map(r => r.pid)])
    const entries = await readProcEntries(always)
    const inventory = entries
      ? buildInventory(entries, {
        selfPid: process.pid,
        home: process.env.HOME,
        tempRoots: tempRoots(),
        startOf: pidStarttime,
        alive: pidAlive,
        helpers: new Map(helpers.map(h => [h.pid, { id: h.id, ...(h.ownerPid ? { ownerPid: h.ownerPid } : {}), ...(h.ownerSessionId ? { ownerSessionId: h.ownerSessionId } : {}) }])),
      })
      : []
    const plan = planGovernor({ inventory, helpers, nowMs })

    if (killsEnabled()) {
      for (const k of plan.kills) {
        terminate(k.pid)
        recent.unshift({ ...k, atMs: nowMs })
        deps.log(`[governor] stopped pid ${k.pid} (${k.label}): ${k.reason}`)
        deps.notify({
          type: 'info',
          code: k.reason.startsWith('helper') ? 'hardware.helper_stopped' : 'hardware.orphan_stopped',
          meta: { label: k.label, pid: k.pid, size: mbText(k.usedBytes), why: k.reason },
        })
      }
      recent.splice(RECENT_MAX)
      if (plan.kills.length) {
        const gone = new Set(plan.kills.map(k => k.pid))
        await mutateHelpers(rs => ({ next: rs.filter(r => !gone.has(r.pid)), result: null })).catch(() => {})
      }
    }

    const live = new Set<string>()
    // After an upgrade EVERY session's MCP server runs the replaced binary — harmless (it keeps
    // working until its session reconnects) and one per session, so it is said ONCE, as a count,
    // whenever that count grows. The panel still lists each one.
    const mcpPids = new Set(inventory.filter(p => p.kind === 'mcp').map(p => p.pid))
    const staleMcp = plan.alerts.filter(a => a.reason === 'stale-binary' && mcpPids.has(a.pid))
    // A stale MCP raises NO notification (owner 10/10: nothing the user can do); the panel keeps a
    // quiet line. Orphans are different — something the user CAN end — and are announced once.
    lastStaleMcpCount = staleMcp.length
    for (const o of inventory.filter(p => p.orphanWhy && !p.self)) {
      const key = `${o.pid}:orphan`
      live.add(key)
      if (announced.has(key)) continue
      announced.add(key)
      deps.notify({ type: 'info', code: 'hardware.process_orphan', meta: { label: o.label, pid: o.pid, size: mbText(o.usedBytes) } })
    }
    for (const a of plan.alerts) {
      if (a.reason === 'stale-binary' && mcpPids.has(a.pid)) continue
      const key = `${a.pid}:${a.reason}`
      live.add(key)
      if (announced.has(key)) continue
      announced.add(key)
      deps.notify({
        type: 'warning',
        code: a.reason === 'stale-binary' ? 'hardware.process_stale' : a.reason === 'spinning' ? 'hardware.process_spinning' : 'hardware.process_over_budget',
        meta: { label: a.label, pid: a.pid, size: mbText(a.usedBytes), budget: mbText(a.budgetBytes ?? null) },
      })
    }
    // MEM.GUARD: one bell notice under the hard floor, naming the biggest process; re-arms past 3 GB.
    const alarm = memoryAlarmStep(memAlarm, await memAvailableNow())
    memAlarm = alarm.state
    if (alarm.raise) {
      const { readBiggestConsumer } = await import('../sessions/memory-probe')
      const hog = await readBiggestConsumer().catch(() => null)
      deps.notify({
        type: 'warning',
        code: 'hardware.memory_critical',
        meta: { available: mbText(await memAvailableNow()), label: hog?.label ?? '?', pid: hog?.pid ?? 0, size: mbText(hog?.usedBytes ?? null) },
      })
    }
    // An alert that cleared may be announced again if it comes back.
    for (const k of [...announced]) if (!live.has(k)) announced.delete(k)

    snapshot = {
      atMs: nowMs,
      measured: entries !== null,
      inventory,
      alerts: plan.alerts,
      helpers: helpers.filter(h => !plan.kills.some(k => k.pid === h.pid)),
      heavy,
      recent: [...recent],
      killsEnabled: killsEnabled(),
      spawnQueue: registeredSpawnQueue()?.list() ?? [],
      reaper: reaperState(),
    }
    return snapshot
  })().finally(() => { running = null })
  return running
}

/** The temp roots, plus this machine's own temp dir when it lives somewhere else. */
export function tempRoots(): string[] {
  const roots = [...DEFAULT_TEMP_ROOTS]
  const t = tmpdir()
  if (t && t !== '/' && !roots.some(r => `${t}/`.startsWith(r))) roots.push(`${t.replace(/\/+$/, '')}/`)
  return roots
}

function mbText(bytes: number | null): string {
  return bytes === null ? '?' : `${Math.round(bytes / (1024 * 1024))} MB`
}

// ---------------------------------------------------------------------------------------------------------------------
// Machine health guard (spec 2026-11-26-machine-health-guard §1, slice G1: OBSERVE ONLY — no gate, no notice).
// Its own 10 s tick: the hysteresis counts in machine-health.ts are in 10 s ticks, the governor's pass is 30 s.

/**
 * The data directory, read off a path that is defined to live in it — `helpers.json` is
 * `join(<data dir>, 'helpers.json')` — so this module does not name the data directory itself (the delivery
 * guard pins which modules may reference it: delivery/doors.lint.test.ts).
 */
const HEALTH_DATA_DIR = dirname(HELPERS_FILE)
export const HEALTH_SAMPLES_DIR = join(HEALTH_DATA_DIR, 'health')

let healthState: HealthState | null = null
/** Monotonic time `healthState` was sampled at — its freshness is never judged on the wall clock. */
let healthStateMono = 0
let healthTimer: ReturnType<typeof setInterval> | null = null
let healthRunning: Promise<HealthState> | null = null
let healthReader: HealthReader | null = null
let sampleLog: SampleLog | null = null
/** The route's own memoized single-sample reader (see `createHealthApiCache`); separate from the tick's, which carries history. */
let apiCache: Promise<HealthApiCache> | null = null
const monoNow = (): number => performance.now()

/** The real primitives, from modules that already hold the capability (see machine-health-io.ts header). */
async function realHealthIo(): Promise<HealthIo> {
  const probe = await import('../hardware-probe')
  return {
    platform: process.platform,
    env: process.env,
    dataDir: HEALTH_DATA_DIR,
    now: () => Date.now(),
    mono: monoNow,
    readText: probe.readTextOrNull,
    statfs: probe.readFsFacts,
    // The one bounded "run argv, collect lines, kill at the deadline" runner the server already has.
    run: async (argv, timeoutMs) => {
      const { defaultRunner } = await import('../sessions/harness-install')
      const out: string[] = []
      try {
        const code = await defaultRunner(argv, (line, stream) => { if (stream !== 'stderr') out.push(line) }, timeoutMs)
        return { code, stdout: out.join('\n') }
      } catch {
        return null
      }
    },
  }
}

/** One health tick: sample, evaluate against the last state, record. Concurrent callers share the tick. */
export function healthTick(): Promise<HealthState> {
  if (healthRunning) return healthRunning
  healthRunning = (async () => {
    if (!healthReader) healthReader = createHealthReader(await realHealthIo())
    if (!sampleLog) {
      const probe = await import('../hardware-probe')
      const { durableWrite } = await import('../durable-file')
      sampleLog = createSampleLog({ dir: HEALTH_SAMPLES_DIR, readText: probe.readTextOrNull, ensureDir: probe.ensureDirectory, write: (p, t) => durableWrite(p, t, 0o600) })
    }
    const sample = await healthReader.sample()
    const step = evaluateHealth(sample, healthState ?? undefined)
    healthState = step.state
    healthStateMono = sample.monoMs
    await sampleLog.record(step.state, step.transition)
    return step.state
  })().finally(() => { healthRunning = null })
  return healthRunning
}

/**
 * The `health` block for `/api/hardware-resources`: the governor's state when it is fresh, otherwise ONE sample
 * read now and evaluated with no history (`basis: 'single-sample'` says so) — a darwin/win32 server, or a process
 * whose governor is not running, still answers, with every signal `unavailable` where it cannot read. That sample
 * is memoized (`HEALTH_API_FRESH_MS`) and concurrent GETs share one read, so a burst of requests never runs
 * `dmesg`/`powershell.exe` once each; `ageMs` says how old the answer is.
 */
export async function healthForApi(): Promise<HealthBlock> {
  const now = monoNow()
  if (healthState && now - healthStateMono < 3 * HEALTH_TICK_MS) return healthBlock(healthState, 'governor', now - healthStateMono)
  apiCache ??= realHealthIo().then(io => createHealthApiCache(createHealthReader(io), monoNow))
  const { state, ageMs } = await (await apiCache).get()
  return healthBlock(state, 'single-sample', ageMs)
}

function startHealthWatch(log: (line: string) => void): void {
  if (healthTimer) return
  const tick = () => { void healthTick().catch(e => log(`[health] tick failed: ${String(e)}`)) }
  tick()
  healthTimer = setInterval(tick, HEALTH_TICK_MS)
  healthTimer.unref?.()
}

export function startGovernor(deps: GovernorDeps): void {
  if (timer || process.platform !== 'linux') return
  // Closed sessions' leftover processes: boot + periodic (or the coletor-processos flow, flows on).
  startSessionReaper(deps.log)
  startHealthWatch(deps.log)
  void governorTick(deps).catch(e => deps.log(`[governor] tick failed: ${String(e)}`))
  timer = setInterval(() => {
    void governorTick(deps).catch(e => deps.log(`[governor] tick failed: ${String(e)}`))
  }, TICK_MS)
  timer.unref?.()
}
