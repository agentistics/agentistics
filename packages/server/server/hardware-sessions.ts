/**
 * hardware-sessions.ts — what the MANAGED fleet is costing this machine, read over HTTP.
 *
 * The cockpit's poller (`sessions/sessions-host.ts`) already computes this, but it only ever runs in
 * the CLI and in the events daemon: nothing served it to the browser. The hardware page therefore
 * read `/api/live-sessions`, whose payload has no `sessions` array at all, and printed a confident
 * "0 active sessions" on a machine running six of them.
 *
 * This is deliberately NOT the poller. The poller captures a screen per session and infers what each
 * one is DOING; a hardware read needs none of that, and paying for a `capture-pane` per session on
 * every dashboard poll would be the expensive way to learn nothing. What it needs is the registry
 * (which session is which), the backend (which of them is alive, and its pane pid) and `/proc`.
 *
 * **The fleet poller's own snapshot is preferred when one is FRESH** (`hardwareFromSnapshot`). The poller
 * already lists the sessions, reads the pane pids and samples `/proc` for every live row on every tick,
 * so while anything keeps the SessionHub ticking (a `/sessions` tab, a fleet stream, the event producer)
 * a hardware read costs no tmux call at all — it was a `list-sessions` + `list-panes` PER REQUEST,
 * outside the hub, 33 a minute each with two tabs open (QA.F1.2 step 4; ENGINE.MAP P-01/P-02). It only
 * PEEKS: reading the hub here would put the hardware page on the hub's demand lease and buy a full poll
 * (a screen capture per session) every five seconds to learn what two cheap calls answer, so with no
 * fresh snapshot the direct read below runs exactly as before.
 *
 * Two states it must never confuse — the rule `sessions-host.ts` states and `liveEmptyNotice`
 * enforces on the dashboard: "nothing is running" and "this machine cannot tell". Every path that
 * cannot answer returns a REASON, and the reason is rendered as a sentence.
 */

import type { HarnessId } from '@agentistics/core'
import type { SessionSnapshot } from './sessions/sessions-host'
import { calculateProcCpu, type ProcStatSample } from './hardware-pure'
import { readProcRss, readProcStat } from './hardware-probe'
import { procAvailable } from './sessions/proc-liveness'

/** Why the list below may not be the whole truth. Each maps to one sentence in the UI. */
export type HardwareSessionsReason =
  /** The session backend cannot run here at all (no tmux; Windows). Its own words come with it. */
  | 'backend-unavailable'
  /** The backend is there but the read failed — a tmux server that went away mid-question. */
  | 'read-failed'

/** Why a listed session carries no CPU/memory figure. The session is real; the numbers are not. */
export type HardwareSessionMetricsReason =
  /** No `/proc` on this machine (or not Linux) — nothing per-process is readable. */
  | 'no-proc'
  /** The backend gave no pid for this pane, so there is nothing to measure. */
  | 'no-pid'
  /** First sample: CPU is a delta between two readings and the first one has no predecessor. */
  | 'first-sample'

export interface ManagedSessionHardware {
  id: string
  harness?: HarnessId
  label?: string
  cwd?: string
  task?: string
  /** True while the backend still hosts a living command. Only live rows are returned. */
  alive: true
  pid: number | null
  cpuPercent: number | null
  rssBytes: number | null
  /** Absent when both figures are real. */
  metricsReason?: HardwareSessionMetricsReason
}

export interface ManagedSessionsSnapshot {
  sessions: ManagedSessionHardware[]
  /** Whether per-process figures are readable on this machine at all. */
  procAvailable: boolean
  /** Set when the fleet itself could not be listed. `sessions` is then empty and means nothing. */
  unavailable?: HardwareSessionsReason
  /** The backend's own sentence, when it has one (it names the actual remedy — e.g. use WSL). */
  unavailableDetail?: string
}

/**
 * How old the hub's snapshot may be and still answer a hardware read: two poll intervals, i.e. the hub
 * is ticking. Older means nothing is keeping it ticking, and the direct read is the cheaper truth.
 */
export const HUB_SNAPSHOT_MAX_AGE_MS = 10_000

/**
 * PURE. The managed fleet's hardware, read off the fleet poller's snapshot — or `null` when that
 * snapshot cannot answer (none yet, too old, or one the poller itself marked `unavailable`), and the
 * caller reads the backend directly instead.
 *
 * A live row is one the backend hosts with a living command: `running` (registered) or `unregistered`
 * (the backend has it, the registry forgot it) whose activity is not `exited` — the same rows the
 * direct read keeps with its `b.alive` test.
 */
export function hardwareFromSnapshot(
  snap: SessionSnapshot | null | undefined,
  o: { nowMs: number; canReadProc: boolean; maxAgeMs?: number },
): ManagedSessionsSnapshot | null {
  if (!snap || snap.unavailable !== undefined) return null
  if (o.nowMs - snap.polledAtMs > (o.maxAgeMs ?? HUB_SNAPSHOT_MAX_AGE_MS)) return null
  const sessions: ManagedSessionHardware[] = []
  for (const s of snap.sessions) {
    if (s.status !== 'running' && s.status !== 'unregistered') continue
    if (s.activity === 'exited') continue
    const pid = s.pid !== undefined && Number.isFinite(s.pid) && s.pid > 0 ? s.pid : null
    const cpuPercent = s.cpuPercent ?? null
    const rssBytes = s.rssBytes ?? null
    let metricsReason: HardwareSessionMetricsReason | undefined
    if (!o.canReadProc) metricsReason = 'no-proc'
    else if (pid === null) metricsReason = 'no-pid'
    else if (cpuPercent === null) metricsReason = 'first-sample'
    sessions.push({
      id: s.id,
      ...(s.harness ? { harness: s.harness } : {}),
      ...(s.label ? { label: s.label } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.task ? { task: s.task } : {}),
      alive: true,
      pid,
      cpuPercent: o.canReadProc ? cpuPercent : null,
      rssBytes: o.canReadProc ? rssBytes : null,
      ...(metricsReason ? { metricsReason } : {}),
    })
  }
  sessions.sort((a, b) => (b.rssBytes ?? -1) - (a.rssBytes ?? -1))
  return { sessions, procAvailable: o.canReadProc }
}

/**
 * Sample every LIVE managed session's CPU and RSS.
 *
 * `prevStats` is the caller's memory between calls: CPU is a delta over wall time, so the first
 * sample of a pid is honestly `null` (`first-sample`) rather than a zero.
 */
export async function readManagedSessionHardware(
  prevStats: Map<number, ProcStatSample>,
  timestampMs = Date.now(),
  /** The SessionHub's last snapshot, PEEKED (never read: see the header). */
  hubSnapshot?: () => SessionSnapshot | null | undefined,
): Promise<ManagedSessionsSnapshot> {
  const canReadProc = await procAvailable()

  const fromHub = hardwareFromSnapshot(hubSnapshot?.(), { nowMs: timestampMs, canReadProc })
  if (fromHub) return fromHub

  let backend
  try {
    const { resolveBackend } = await import('./sessions')
    backend = await resolveBackend()
  } catch {
    return { sessions: [], procAvailable: canReadProc, unavailable: 'read-failed' }
  }

  const why = await backend.unavailable().catch(() => 'the session backend could not be reached')
  if (why) {
    return {
      sessions: [],
      procAvailable: canReadProc,
      unavailable: 'backend-unavailable',
      unavailableDetail: why,
    }
  }

  try {
    const { readRegistry } = await import('./sessions/registry')
    const [backendSessions, registry, panePids] = await Promise.all([
      backend.list(),
      readRegistry().catch(() => []),
      backend.listPanePids?.().catch(() => new Map<string, number>()) ?? Promise.resolve(new Map<string, number>()),
    ])

    const meta = new Map(registry.map(m => [m.id, m]))
    const sessions: ManagedSessionHardware[] = []

    for (const b of backendSessions) {
      if (!b.alive) continue
      const m = meta.get(b.id)
      const pid = panePids.get(b.id) ?? null

      let cpuPercent: number | null = null
      let rssBytes: number | null = null
      let metricsReason: HardwareSessionMetricsReason | undefined

      if (!canReadProc) {
        metricsReason = 'no-proc'
      } else if (pid === null || !Number.isFinite(pid) || pid <= 0) {
        metricsReason = 'no-pid'
      } else {
        rssBytes = await readProcRss(pid)
        const curr = await readProcStat(pid, timestampMs)
        if (curr) {
          cpuPercent = calculateProcCpu(prevStats.get(pid), curr)
          prevStats.set(pid, curr)
        }
        if (cpuPercent === null) metricsReason = 'first-sample'
      }

      sessions.push({
        id: b.id,
        ...(m?.harness ? { harness: m.harness } : {}),
        ...(m?.label ? { label: m.label } : {}),
        ...(m?.cwd ? { cwd: m.cwd } : {}),
        ...(m?.task ? { task: m.task } : {}),
        alive: true,
        pid,
        cpuPercent,
        rssBytes,
        ...(metricsReason ? { metricsReason } : {}),
      })
    }

    // Newest first is meaningless here (the backend list is ordered by name); order by what the
    // reader is looking for — the heaviest session.
    sessions.sort((a, b) => (b.rssBytes ?? -1) - (a.rssBytes ?? -1))

    return { sessions, procAvailable: canReadProc }
  } catch {
    return { sessions: [], procAvailable: canReadProc, unavailable: 'read-failed' }
  }
}
