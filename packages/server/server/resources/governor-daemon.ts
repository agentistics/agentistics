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

import { readProcEntries, pidAlive } from './proc-read'
import { buildInventory, type AgentopProcess } from './inventory'
import { planGovernor, type Alert, type Kill } from './governor'
import { readHelpers, mutateHelpers, pruneHelpers, type HelperRecord } from './helpers'
import { readHeavyState, type HeavyState } from './heavy-io'

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

export function resourcesSnapshot(): ResourcesSnapshot | null {
  return snapshot
}

const killsEnabled = (): boolean => process.env.AGENTISTICS_GOVERNOR !== '0'

function terminate(pid: number): void {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  setTimeout(() => { if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }, KILL_GRACE_MS).unref?.()
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
    if (staleMcp.length > lastStaleMcpCount) {
      deps.notify({ type: 'info', code: 'hardware.mcp_stale', meta: { count: staleMcp.length } })
    }
    lastStaleMcpCount = staleMcp.length
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
    }
    return snapshot
  })().finally(() => { running = null })
  return running
}

function mbText(bytes: number | null): string {
  return bytes === null ? '?' : `${Math.round(bytes / (1024 * 1024))} MB`
}

export function startGovernor(deps: GovernorDeps): void {
  if (timer || process.platform !== 'linux') return
  void governorTick(deps).catch(e => deps.log(`[governor] tick failed: ${String(e)}`))
  timer = setInterval(() => {
    void governorTick(deps).catch(e => deps.log(`[governor] tick failed: ${String(e)}`))
  }, TICK_MS)
  timer.unref?.()
}
