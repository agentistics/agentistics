/**
 * hardware-probe.ts — the impure I/O layer for reading machine hardware resources.
 *
 * Reads:
 * 1. Host level metrics: CPU loadavg, total/used RAM, disk usage of HOME_DIR.
 * 2. Agentop process metrics: server process (process.pid), otel-watcher daemon, Docker containers.
 * 3. Degrades to `null` or N/A on non-Linux or unreadable metrics.
 */

import { readFile, statfs } from 'node:fs/promises'
import { loadavg, totalmem, freemem, cpus } from 'node:os'
import { HOME_DIR } from './config'
import {
  calculateProcCpu,
  isOtelWatcherCmdline,
  parseDiskUsage,
  parseProcRss,
  parseProcStat,
  resolveServiceState,
  type DiskUsage,
  type ProcStatSample,
  type ServiceHosting,
  type ServiceRunState,
} from './hardware-pure'
import { otelWatcherHosted } from './watcher-state'
import { procAvailable } from './sessions/proc-liveness'
import { readManagedSessionHardware, type ManagedSessionsSnapshot } from './hardware-sessions'
import type { SessionSnapshot } from './sessions/sessions-host'

export interface ProcessMetrics {
  pid: number | null
  name: string
  running: boolean
  /**
   * The honest three-way answer. `running` above is kept as the boolean older readers (the TUI
   * hardware screen) already consume; `unknown` reads as `false` there, which is the same shape it
   * had before — but a reader that knows about this field can say "cannot tell" instead of "off".
   */
  state?: ServiceRunState
  /** Where a running service lives. `in-process` means its CPU/RSS are the server's own. */
  hosting?: ServiceHosting
  cpuPercent: number | null
  rssBytes: number | null
}

export interface ContainerMetrics {
  id: string
  name: string
  image: string
  cpuPercent: number | null
  memUsageBytes: number | null
  memLimitBytes: number | null
}

export interface HostMetricsSnapshot {
  loadavg: number[] | null
  cpuCores: number | null
  totalMemoryBytes: number | null
  freeMemoryBytes: number | null
  usedMemoryBytes: number | null
  memAvailableBytes?: number | null
  buffersBytes?: number | null
  cachedBytes?: number | null
  swapTotalBytes?: number | null
  swapUsedBytes?: number | null
  disk: DiskUsage
}

export interface AgentopMetricsSnapshot {
  server: ProcessMetrics
  otelWatcher: ProcessMetrics
  services: ProcessMetrics[]
  dockerContainers: ContainerMetrics[]
  dockerAvailable: boolean
}

export interface HardwareResourcesSnapshot {
  procAvailable: boolean
  host: HostMetricsSnapshot
  agentop: AgentopMetricsSnapshot
  /**
   * The managed fleet's own footprint. It travels on THIS snapshot rather than on
   * `/api/live-sessions`, whose payload is host-process detection for the dashboard's session rows
   * and carries no per-session hardware at all — reading it as if it did is what made this surface
   * report zero sessions on a machine running six.
   */
  sessions: ManagedSessionsSnapshot
  sampledAtMs: number
}

/** Read raw /proc/<pid>/stat and parse it into a sample. */
export async function readProcStat(pid: number, timestampMs = Date.now()): Promise<ProcStatSample | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    return parseProcStat(pid, raw, timestampMs)
  } catch {
    return null
  }
}

/** Read raw /proc/<pid>/status VmRSS. */
export async function readProcRss(pid: number): Promise<number | null> {
  try {
    const raw = await readFile(`/proc/${pid}/status`, 'utf8')
    return parseProcRss(raw)
  } catch {
    return null
  }
}

/** Read disk usage via statfs on target path (defaulting to HOME_DIR). */
export async function readDiskMetrics(path = HOME_DIR): Promise<DiskUsage> {
  try {
    const stats = await statfs(path)
    return parseDiskUsage(stats.blocks, stats.bavail, stats.bsize, path)
  } catch {
    return {
      mountPath: path,
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      available: false,
    }
  }
}

/** Read host CPU load, RAM, and Disk metrics. */
export async function readHostMetrics(): Promise<HostMetricsSnapshot> {
  const disk = await readDiskMetrics()
  try {
    const loads = loadavg()
    const total = totalmem()
    const free = freemem()
    const cores = cpus()?.length ?? null

    const validLoads = loads && loads.length === 3 && loads.every(Number.isFinite) ? loads : null
    const validTotal = Number.isFinite(total) && total > 0 ? total : null
    const validFree = Number.isFinite(free) && free >= 0 ? free : null
    const validUsed = validTotal !== null && validFree !== null ? Math.max(0, validTotal - validFree) : null

    let swapTotalBytes: number | null = null
    let swapUsedBytes: number | null = null
    let memAvailableBytes: number | null = null
    let buffersBytes: number | null = null
    let cachedBytes: number | null = null

    try {
      const meminfo = await readFile('/proc/meminfo', 'utf8')
      let sTotalKb: number | null = null
      let sFreeKb: number | null = null
      let availKb: number | null = null
      let bufKb: number | null = null
      let cacheKb: number | null = null
      let reclKb: number | null = null

      for (const line of meminfo.split('\n')) {
        if (line.startsWith('SwapTotal:')) {
          const parts = line.split(/\s+/)
          if (parts[1]) sTotalKb = Number(parts[1])
        } else if (line.startsWith('SwapFree:')) {
          const parts = line.split(/\s+/)
          if (parts[1]) sFreeKb = Number(parts[1])
        } else if (line.startsWith('MemAvailable:')) {
          const parts = line.split(/\s+/)
          if (parts[1]) availKb = Number(parts[1])
        } else if (line.startsWith('Buffers:')) {
          const parts = line.split(/\s+/)
          if (parts[1]) bufKb = Number(parts[1])
        } else if (line.startsWith('Cached:')) {
          const parts = line.split(/\s+/)
          if (parts[1]) cacheKb = Number(parts[1])
        } else if (line.startsWith('SReclaimable:')) {
          const parts = line.split(/\s+/)
          if (parts[1]) reclKb = Number(parts[1])
        }
      }
      if (sTotalKb !== null && Number.isFinite(sTotalKb) && sTotalKb > 0) {
        swapTotalBytes = sTotalKb * 1024
        if (sFreeKb !== null && Number.isFinite(sFreeKb)) {
          swapUsedBytes = Math.max(0, (sTotalKb - sFreeKb) * 1024)
        }
      }
      if (availKb !== null && Number.isFinite(availKb)) {
        memAvailableBytes = availKb * 1024
      }
      if (bufKb !== null && Number.isFinite(bufKb)) {
        buffersBytes = bufKb * 1024
      }
      if (cacheKb !== null && Number.isFinite(cacheKb)) {
        const totalCache = cacheKb + (reclKb ?? 0)
        cachedBytes = totalCache * 1024
      }
    } catch {
      /* no /proc/meminfo */
    }

    return {
      loadavg: validLoads,
      cpuCores: Number.isFinite(cores) && cores! > 0 ? cores : null,
      totalMemoryBytes: validTotal,
      freeMemoryBytes: validFree,
      usedMemoryBytes: validUsed,
      memAvailableBytes,
      buffersBytes,
      cachedBytes,
      swapTotalBytes,
      swapUsedBytes,
      disk,
    }
  } catch {
    return {
      loadavg: null,
      cpuCores: null,
      totalMemoryBytes: null,
      freeMemoryBytes: null,
      usedMemoryBytes: null,
      disk,
    }
  }
}

/**
 * Look for an otel-watcher running as a process of its OWN.
 *
 * Two things this used to get wrong, both of which reported a running watcher as stopped:
 *  - it returned early unless `OTEL_EXPORTER_OTLP_ENDPOINT` was set in the SERVER's environment.
 *    That is an environment variable of this process and says nothing about another one: a watcher
 *    started as its own service (`agentop watch`, a systemd unit) has its own environment.
 *  - it could only ever find a SEPARATE process, and under `agentop server` the watcher is imported
 *    into the server's own process (bin/cli.ts) — the normal case has no second pid at all. That
 *    half is answered by `otelWatcherHosted()`, not here.
 *
 * Returns `scanned: false` when the process list could not be read: that is "cannot tell", and the
 * caller must not turn it into "stopped".
 */
async function findOtelWatcherPid(serverPid: number): Promise<{ pid: number | null; scanned: boolean }> {
  try {
    const { readdir } = await import('node:fs/promises')
    const pids = await readdir('/proc')
    for (const p of pids) {
      if (!/^\d+$/.test(p)) continue
      const pid = Number(p)
      if (pid === serverPid) continue
      try {
        const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8')
        // argv is NUL-separated; a trailing NUL leaves an empty tail the parser drops.
        if (isOtelWatcherCmdline(cmdline.split('\0'))) return { pid, scanned: true }
      } catch { /* process gone or unreadable */ }
    }
    return { pid: null, scanned: true }
  } catch {
    return { pid: null, scanned: false }
  }
}

const CENTRAL_FILTER = 'label=com.docker.compose.project=team-mode'
const MACHINE_FILTER = 'ancestor=agentistics-machine'

/** Read Docker container metrics for agentistics central/machine/mcp containers. */
async function readDockerMetrics(): Promise<{ containers: ContainerMetrics[]; available: boolean }> {
  try {
    const proc = Bun.spawn(
      ['docker', 'ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}'],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    )
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      return { containers: [], available: false }
    }
    const stdout = await new Response(proc.stdout).text()
    const allLines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    const lines = allLines.filter(l => {
      const lower = l.toLowerCase()
      return (
        lower.includes('agentop') ||
        lower.includes('agentistics') ||
        lower.includes('team-mode') ||
        lower.includes('central') ||
        lower.includes('machine')
      )
    })
    if (lines.length === 0) {
      return { containers: [], available: true }
    }

    // Try `docker stats --no-stream` for live container CPU & RAM
    const statsProc = Bun.spawn(
      ['docker', 'stats', '--no-stream', '--format', '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}'],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    )
    const statsOut = (await statsProc.exited) === 0 ? await new Response(statsProc.stdout).text() : ''
    const statsMap = new Map<string, { cpuPercent: number | null; memUsageBytes: number | null; memLimitBytes: number | null }>()

    for (const rawLine of statsOut.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const [id, cpuStr, memStr] = line.split('\t')
      if (!id) continue

      let cpuPercent: number | null = null
      if (cpuStr && cpuStr.endsWith('%')) {
        const val = Number(cpuStr.slice(0, -1))
        if (Number.isFinite(val)) cpuPercent = val
      }

      let memUsageBytes: number | null = null
      let memLimitBytes: number | null = null
      if (memStr && memStr.includes('/')) {
        const [usagePart, limitStr] = memStr.split('/').map(s => s.trim())
        memUsageBytes = parseDockerBytes(usagePart)
        memLimitBytes = parseDockerBytes(limitStr)
      }

      statsMap.set(id, { cpuPercent, memUsageBytes, memLimitBytes })
    }

    const containers: ContainerMetrics[] = lines.map(line => {
      const [id, name, image] = line.split('\t')
      const stats = statsMap.get(id ?? '') ?? { cpuPercent: null, memUsageBytes: null, memLimitBytes: null }
      return {
        id: id ?? '',
        name: name ?? 'docker-container',
        image: image ?? '',
        cpuPercent: stats.cpuPercent,
        memUsageBytes: stats.memUsageBytes,
        memLimitBytes: stats.memLimitBytes,
      }
    })

    return { containers, available: true }
  } catch {
    return { containers: [], available: false }
  }
}

/** Helper to parse docker stats human memory strings e.g. "120.5MiB", "1.2GiB", "500kB". */
function parseDockerBytes(str: string | undefined): number | null {
  if (!str) return null
  const m = /^([\d.]+)\s*([A-Za-z]+)?$/.exec(str.trim())
  if (!m || !m[1]) return null
  const num = Number(m[1])
  if (!Number.isFinite(num)) return null
  const unit = (m[2] ?? '').toLowerCase()
  if (unit.startsWith('gi') || unit === 'gb' || unit === 'g') return Math.round(num * 1024 * 1024 * 1024)
  if (unit.startsWith('mi') || unit === 'mb' || unit === 'm') return Math.round(num * 1024 * 1024)
  if (unit.startsWith('ki') || unit === 'kb' || unit === 'k') return Math.round(num * 1024)
  if (unit === 'b' || !unit) return Math.round(num)
  return Math.round(num)
}

/**
 * Sample agentop's own process metrics (server, watcher, docker containers).
 */
export async function readAgentopMetrics(
  prevStatsMap: Map<number, ProcStatSample>,
  timestampMs = Date.now(),
): Promise<AgentopMetricsSnapshot> {
  const serverPid = process.pid
  const serverStat = await readProcStat(serverPid, timestampMs)
  const serverRss = await readProcRss(serverPid)

  let serverCpuPercent: number | null = null
  if (serverStat) {
    const prevServer = prevStatsMap.get(serverPid)
    serverCpuPercent = calculateProcCpu(prevServer, serverStat)
    prevStatsMap.set(serverPid, serverStat)
  }

  const { pid: watcherPid, scanned } = await findOtelWatcherPid(serverPid)
  const watcher = resolveServiceState({ inProcess: otelWatcherHosted(), scanned, pid: watcherPid })
  let watcherCpuPercent: number | null = null
  let watcherRss: number | null = null

  if (watcherPid !== null) {
    const watcherStat = await readProcStat(watcherPid, timestampMs)
    watcherRss = await readProcRss(watcherPid)
    if (watcherStat) {
      const prevWatcher = prevStatsMap.get(watcherPid)
      watcherCpuPercent = calculateProcCpu(prevWatcher, watcherStat)
      prevStatsMap.set(watcherPid, watcherStat)
    }
  }

  const serverProc: ProcessMetrics = {
    pid: serverPid,
    name: 'agentop server',
    running: true,
    state: 'running',
    hosting: 'in-process',
    cpuPercent: serverCpuPercent,
    rssBytes: serverRss,
  }

  const watcherProc: ProcessMetrics = {
    // In-process: it has no pid of its own, it has the SERVER's — reporting one would invite the
    // reader to `kill` it, and the figures beside it are already counted under `agentop server`.
    pid: watcherPid,
    name: 'otel-watcher',
    running: watcher.state === 'running',
    state: watcher.state,
    ...(watcher.hosting ? { hosting: watcher.hosting } : {}),
    cpuPercent: watcherCpuPercent,
    rssBytes: watcherRss,
  }

  const { containers, available: dockerAvailable } = await readDockerMetrics()

  // Collect ONLY running services (never list inactive ones to avoid clutter)
  const activeServices: ProcessMetrics[] = [serverProc]
  if (watcherProc.running) {
    activeServices.push(watcherProc)
  }

  return {
    server: serverProc,
    otelWatcher: watcherProc,
    services: activeServices,
    dockerContainers: containers,
    dockerAvailable,
  }
}

/** Collect full hardware resources snapshot. */
export async function getHardwareSnapshot(
  prevStatsMap: Map<number, ProcStatSample>,
  /** The SessionHub's last snapshot, when the process has one — see `hardware-sessions.ts`. */
  hubSnapshot?: () => SessionSnapshot | null | undefined,
): Promise<HardwareResourcesSnapshot> {
  const canReadProc = await procAvailable()
  const sampledAtMs = Date.now()

  const host = await readHostMetrics()
  const serverFallback: ProcessMetrics = { pid: process.pid, name: 'agentop server', running: true, cpuPercent: null, rssBytes: null }
  const watcherFallback: ProcessMetrics = { pid: null, name: 'otel-watcher', running: false, cpuPercent: null, rssBytes: null }
  const agentop = canReadProc
    ? await readAgentopMetrics(prevStatsMap, sampledAtMs)
    : {
        server: serverFallback,
        otelWatcher: watcherFallback,
        services: [serverFallback],
        dockerContainers: [],
        dockerAvailable: false,
      }

  const sessions = await readManagedSessionHardware(prevStatsMap, sampledAtMs, hubSnapshot)

  return {
    procAvailable: canReadProc,
    host,
    agentop,
    sessions,
    sampledAtMs,
  }
}
