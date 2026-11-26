/**
 * resources/machine-health-io.ts — the reads behind `machine-health.ts`, and the sample log.
 *
 * Every primitive (read a file, `statfs`, run a bounded command, write a file) is INJECTED: this module holds
 * the decisions — which file, how often, what to cache, where the Windows drive is — and none of the
 * capabilities. Two reasons: the darwin/win32/unreadable cases are tests over fixtures rather than over this
 * machine, and the delivery guard pins which modules may touch the filesystem (delivery/doors.lint.test.ts),
 * so the real primitives are wired in by `governor-daemon.ts` from modules that already hold them.
 *
 * Cost per 10 s tick on Linux: one read each of buddyinfo / meminfo / vmstat / mounts (+ the two PSI
 * files where they exist) and three `statfs`. The kernel log is a process (`dmesg`) and is read at most every
 * `KERNEL_LOG_EVERY_MS`; the WSL drive lookup is `powershell.exe` (hundreds of ms, can hang) and runs ONCE,
 * bounded, retried at most every `HOST_DRIVE_RETRY_MS` after a failure — never on every tick.
 */

import { join } from 'node:path'
import {
  CURRENT_SAMPLE_NAME,
  SAMPLE_EVERY_MS,
  evaluateHealth,
  foldWorst,
  rotatedSampleName,
  sampleFileDay,
  utcDay,
  type FsFacts,
  type HealthSample,
  type HealthState,
  type Level,
  type SampleLine,
  type SignalId,
} from './machine-health'

export interface CommandResult { code: number; stdout: string }

export interface HealthIo {
  platform: string
  env: Readonly<Record<string, string | undefined>>
  dataDir: string
  /** Wall clock — stamped on the sample for display. */
  now: () => number
  /** Monotonic clock (`performance.now()`) — every pace and window here is measured on it, never on `now`. */
  mono: () => number
  readText: (path: string) => Promise<string | null>
  statfs: (path: string) => Promise<FsFacts | null>
  /** Run argv with a hard timeout; `null` when it could not start or was killed. */
  run: (argv: string[], timeoutMs: number) => Promise<CommandResult | null>
}

export const KERNEL_LOG_EVERY_MS = 30_000
export const KERNEL_LOG_TIMEOUT_MS = 3_000
export const HOST_DRIVE_TIMEOUT_MS = 5_000
export const HOST_DRIVE_RETRY_MS = 10 * 60_000
const POWERSHELL_ARGV0 = ['powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']

/** WSL: `/proc/version` names the Microsoft kernel, or the interop env says so. */
export function isWsl(procVersion: string | null, env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.WSL_DISTRO_NAME) || (procVersion !== null && /microsoft/i.test(procVersion))
}

/**
 * `DistributionName|BasePath` lines (what `lxssQuery` prints) → the `/mnt/<drive>` holding `distro`'s disk
 * image. `\\?\C:\WSL\Ubuntu-22.04` → `/mnt/c`. `null` when the distro is not listed or the path is not on a
 * drive letter (a network share cannot be statfs'd from here).
 */
export function hostDriveMount(lines: string, distro: string | undefined): string | null {
  const rows = lines.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf('|')
    return i < 0 ? null : { name: l.slice(0, i), base: l.slice(i + 1) }
  }).filter((r): r is { name: string; base: string } => r !== null)
  const row = distro ? rows.find(r => r.name === distro) : rows.length === 1 ? rows[0] : undefined
  const m = row ? /^(?:\\\\\?\\)?([A-Za-z]):\\/.exec(row.base) : null
  return m ? `/mnt/${m[1]!.toLowerCase()}` : null
}

/** The registry query, printed one `name|BasePath` per distro. Read-only (HKCU, Get-ItemProperty). */
export const LXSS_QUERY = "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\*' | ForEach-Object { $_.DistributionName + '|' + $_.BasePath }"

export interface HealthReader { sample: () => Promise<HealthSample> }

export function createHealthReader(io: HealthIo): HealthReader {
  let kernel: { atMs: number; text: string | null } | null = null
  let drive: { path: string | null; why?: string; atMs: number } | null = null
  let wsl: boolean | null = null

  const readKernelLog = async (now: number): Promise<string | null> => {
    if (kernel && now - kernel.atMs < KERNEL_LOG_EVERY_MS) return kernel.text
    const r = await io.run(['dmesg'], KERNEL_LOG_TIMEOUT_MS)
    // dmesg_restrict=1 (or no dmesg) exits non-zero: the signal is unavailable, said in words by the pure side.
    kernel = { atMs: now, text: r && r.code === 0 ? r.stdout : null }
    return kernel.text
  }

  const resolveHostDrive = async (now: number): Promise<{ path: string | null; why?: string }> => {
    if (!wsl) return { path: io.dataDir }
    if (drive && (drive.path !== null || now - drive.atMs < HOST_DRIVE_RETRY_MS)) return drive
    let out: CommandResult | null = null
    for (const argv0 of POWERSHELL_ARGV0) {
      out = await io.run([argv0, '-NoProfile', '-NonInteractive', '-Command', LXSS_QUERY], HOST_DRIVE_TIMEOUT_MS)
      if (out && out.code === 0) break
    }
    const path = out && out.code === 0 ? hostDriveMount(out.stdout, io.env.WSL_DISTRO_NAME) : null
    drive = path
      ? { path, atMs: now }
      : { path: null, atMs: now, why: out && out.code === 0 ? `the WSL registry (Lxss BasePath) does not place this distro's disk image on a drive letter${io.env.WSL_DISTRO_NAME ? ` (${io.env.WSL_DISTRO_NAME})` : ''}` : 'powershell.exe could not be run to find the drive holding the WSL disk image (interop off, or it timed out)' }
    return drive
  }

  return {
    async sample(): Promise<HealthSample> {
      const atMs = io.now()
      const monoMs = io.mono()
      const empty: HealthSample = {
        atMs, monoMs, platform: io.platform, wsl: false, buddyinfo: null, meminfo: null, vmstat: null, psiMemory: null, psiIo: null,
        kernelLog: null, mounts: null, dataDir: io.dataDir, rootFs: null, dataFs: null, hostDrive: null,
      }
      // G1 reads Linux/WSL only; darwin and win32 are `unavailable` signal by signal (spec §1.2 "Other platforms").
      if (io.platform !== 'linux') return empty
      if (wsl === null) wsl = isWsl(await io.readText('/proc/version'), io.env)
      const [buddyinfo, meminfo, vmstat, psiMemory, psiIo, mounts, rootFs, dataFs, kernelLog, hd] = await Promise.all([
        io.readText('/proc/buddyinfo'),
        io.readText('/proc/meminfo'),
        io.readText('/proc/vmstat'),
        io.readText('/proc/pressure/memory'),
        io.readText('/proc/pressure/io'),
        io.readText('/proc/mounts'),
        io.statfs('/'),
        io.statfs(io.dataDir),
        readKernelLog(monoMs),
        resolveHostDrive(monoMs),
      ])
      return {
        ...empty,
        wsl,
        buddyinfo, meminfo, vmstat, psiMemory, psiIo, mounts, kernelLog,
        rootFs, dataFs,
        hostDrive: hd.path ? { path: hd.path, fs: hd.path === io.dataDir ? dataFs : await io.statfs(hd.path) } : null,
        ...(hd.why ? { hostDriveWhy: hd.why } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The sample log.

/** How long `/api/hardware-resources` serves one on-demand sample before reading another (spec §7: interop at most once a minute; the reader paces `powershell.exe` and `dmesg` further). */
export const HEALTH_API_FRESH_MS = 30_000

export interface HealthApiCache {
  /** The last on-demand state and its age; a new read only once it is `freshMs` old, shared by every caller waiting on it. */
  get: () => Promise<{ state: HealthState; ageMs: number }>
}

/**
 * The route's fallback when the governor's tick is stale (or not running): ONE long-lived reader — so its drive
 * lookup and kernel-log pace are remembered — evaluated with no history (`instant`), memoized for `freshMs` on the
 * monotonic clock, concurrent GETs coalesced onto the read in flight. Without it every GET ran `dmesg` and
 * `powershell.exe` (up to 2 × 5 s).
 */
export function createHealthApiCache(reader: HealthReader, mono: () => number, freshMs = HEALTH_API_FRESH_MS): HealthApiCache {
  let last: { state: HealthState; monoMs: number } | null = null
  let inFlight: Promise<{ state: HealthState; monoMs: number }> | null = null
  return {
    async get() {
      if (last && mono() - last.monoMs < freshMs) return { state: last.state, ageMs: mono() - last.monoMs }
      if (!inFlight) {
        inFlight = (async () => {
          const monoMs = mono()
          last = { state: evaluateHealth(await reader.sample(), undefined, { instant: true }).state, monoMs }
          return last
        })().finally(() => { inFlight = null })
      }
      const got = await inFlight
      return { state: got.state, ageMs: Math.max(0, mono() - got.monoMs) }
    },
  }
}

export interface SampleLogIo {
  dir: string
  readText: (path: string) => Promise<string | null>
  ensureDir: (dir: string) => Promise<boolean>
  /** Replace a file's content (crash-safe: the old bytes or the complete new ones). */
  write: (path: string, text: string) => Promise<void>
}

/** How often the current day's file is rewritten when nothing else forces it (a transition or a new day does). */
export const SAMPLE_FLUSH_EVERY_MS = 5 * 60_000

export interface SampleLog {
  /** Feed one evaluated tick. Resolves once any write it triggered has landed. */
  record: (state: HealthState, transition: { from: Level; to: Level } | null) => Promise<void>
  /** The current day's lines held in memory (tests, and a future reader). */
  lines: () => readonly string[]
}

/**
 * One line per minute (the worst value of each signal over it) plus one per transition, kept per UTC day:
 * `samples.jsonl` is today, `samples.<weekday>.jsonl` the last seven days, overwritten a week later — so the
 * log is bounded (~1 440 short lines a day) without ever deleting a file.
 */
export function createSampleLog(io: SampleLogIo): SampleLog {
  const current = join(io.dir, CURRENT_SAMPLE_NAME)
  let loaded = false
  let day: string | null = null
  let lines: string[] = []
  let minuteStart: number | null = null
  let worst: Partial<Record<SignalId, number | null>> = {}
  let lastFlush = 0
  let dirty = false
  let chain: Promise<void> = Promise.resolve()

  const write = async (path: string, text: string): Promise<boolean> => {
    if (!(await io.ensureDir(io.dir))) return false
    try { await io.write(path, text); return true } catch { return false }
  }
  const body = (ls: readonly string[]) => (ls.length ? `${ls.join('\n')}\n` : '')

  const load = async (now: number) => {
    loaded = true
    const text = await io.readText(current)
    if (!text) { day = utcDay(now); return }
    const d = sampleFileDay(text)
    const kept = text.split('\n').filter(l => l.trim())
    if (d === utcDay(now)) { day = d; lines = kept; return }
    // A file left from an earlier day (the server was down at midnight): move it into its slot first.
    if (d) await write(join(io.dir, rotatedSampleName(d)), body(kept))
    day = utcDay(now)
    lines = []
    dirty = true
  }

  const step = async (state: HealthState, transition: { from: Level; to: Level } | null) => {
    const now = state.sampledAtMs
    if (!loaded) await load(now)
    if (day !== utcDay(now)) {
      if (day && lines.length) await write(join(io.dir, rotatedSampleName(day)), body(lines))
      day = utcDay(now)
      lines = []
      minuteStart = null
      worst = {}
      dirty = true
    }
    worst = foldWorst(worst, state.values)
    if (minuteStart === null) minuteStart = now
    const reasons = state.reasons.map(r => r.signal)
    if (transition) {
      lines.push(JSON.stringify({ t: now, level: state.level, from: transition.from, v: state.values, r: reasons } satisfies SampleLine))
      dirty = true
    }
    if (now - minuteStart >= SAMPLE_EVERY_MS - 1) {
      lines.push(JSON.stringify({ t: now, level: state.level, v: worst, r: reasons } satisfies SampleLine))
      worst = {}
      minuteStart = now
      dirty = true
    }
    if (dirty && (transition || lastFlush === 0 || now - lastFlush >= SAMPLE_FLUSH_EVERY_MS || lines.length === 1)) {
      if (await write(current, body(lines))) { lastFlush = now; dirty = false }
    }
  }

  return {
    record(state, transition) {
      chain = chain.then(() => step(state, transition)).catch(() => {})
      return chain
    },
    lines: () => lines,
  }
}
