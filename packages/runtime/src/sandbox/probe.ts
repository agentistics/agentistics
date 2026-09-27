/**
 * sandbox/probe.ts — what THIS machine can actually do to contain a process (D-T5).
 *
 * ## Why a probe, and why it is allowed to say "unknown"
 *
 * The owner decided (docs/superpowers/specs/2026-09-25-owner-decisions.md, D-T5) that the sandbox is
 * OPTIONAL in v1 and that the screen states one of four states in plain words. D-T3 rule 4 adds the
 * constraint that makes this module exist: a sandbox is "never claimed where it does not exist" — a
 * sandbox that is advertised and absent is worse than none. So before a launcher may say `container`
 * (or apply a resource limit), something has to have ASKED the machine, and the answer must keep the
 * difference between three things apart:
 *
 *  - `available`   — the mechanism was exercised and worked;
 *  - `unavailable` — the mechanism was asked and said no, for a REASON we can name (the binary is
 *                    absent, the Docker daemon is not running, the socket refused us);
 *  - `unknown`     — the probe itself could not run (it timed out, crashed, or answered in a way we
 *                    do not recognise).
 *
 * `unknown` is never rounded up to `available`: availability of a syscall is not the same as a
 * mechanism you can rely on (Codex's own sandbox intermittently refuses to run under WSL — their
 * issue #1039, cited in the spec). The launcher treats anything but `available` as "not here".
 *
 * ## What is probed, and what is only reported
 *
 * v1's mechanisms are all subprocess composition (zero native-module cost, single-binary safe):
 * `prlimit` (util-linux), the POSIX `sh` `ulimit` fallback, and `docker`. Those three decide what a
 * launcher can do. Landlock, unprivileged user namespaces, the platform and WSL are INFORMATIONAL:
 * no v1 mechanism uses them (bubblewrap / Landlock via `bun:ffi` / Seatbelt come later, per D-T5),
 * and the result says so in `informational.note` so nobody reads their presence as containment.
 *
 * Landlock's ABI is deliberately not measured: the only faithful way to read it is the
 * `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` syscall, which belongs to the
 * later `bun:ffi` work. We report whether the kernel lists the LSM (from securityfs) and `abi: null`.
 * On WSL securityfs is typically not mounted, so this reads `unknown` there — true, if unhelpful.
 *
 * ## Shape
 *
 * Every effect goes through injected dependencies (`run`, `readText`, `platform`), so the tests
 * script every outcome offline. The default runner uses `Bun.spawn` with a FIXED argv (never a shell
 * string built from data) and a short timeout. `probeSandbox` never throws.
 */

import { readFileSync } from 'fs'

// ── The injectable world ────────────────────────────────────────────────────────────────────────

export type RunResult =
  | { kind: 'exited'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'not-found' }
  | { kind: 'timed-out' }
  | { kind: 'crashed'; message: string }

/** Runs a fixed argv. Must resolve, never reject. */
export type CommandRunner = (argv: readonly string[], opts: { timeoutMs: number }) => Promise<RunResult>

export type Platform = 'linux' | 'darwin' | 'win32' | 'other'

export interface ProbeDeps {
  run?: CommandRunner
  /** Reads a small text file; `null` when it cannot be read. Must not throw. */
  readText?: (path: string) => string | null
  platform?: Platform
  /** Per-command timeout. Docker's first answer can be slow on a cold daemon; 5 s by default. */
  timeoutMs?: number
}

// ── The answer ──────────────────────────────────────────────────────────────────────────────────

export type ProbeStatus = 'available' | 'unavailable' | 'unknown'

export interface Capability<Reason extends string> {
  status: ProbeStatus
  /** Present exactly when `status` is not `available`. */
  reason?: Reason
  /** Free text for a log or a detail pane (e.g. the first line of stderr). Never a secret. */
  detail?: string
}

export type PrlimitReason = 'not-linux' | 'not-found' | 'refused' | 'timed-out' | 'probe-failed'
export type UlimitReason = 'no-posix-sh' | 'refused' | 'timed-out' | 'probe-failed'
export type DockerReason =
  | 'binary-absent'
  | 'daemon-down'
  | 'permission-denied'
  | 'timed-out'
  | 'probe-failed'
export type UserNsReason = 'not-linux' | 'refused' | 'no-unshare' | 'timed-out' | 'probe-failed'
export type LandlockReason = 'not-linux' | 'not-enabled' | 'securityfs-unreadable'

/**
 * The `ulimit` flag the shell accepts for each limit, or `null` when it rejects it. Needed because
 * `ulimit` beyond `-f` is not portable: dash (Debian/Ubuntu `/bin/sh`) has no `-u` and spells the
 * process limit `-p`, while in bash `-p` is the (read-only) PIPE size. Guessing would either fail
 * the command or, worse, set the wrong limit.
 */
export interface UlimitFlags {
  cpu: '-t' | null
  addressSpace: '-v' | null
  fileSize: '-f' | null
  openFiles: '-n' | null
  processes: '-u' | '-p' | null
}

export interface SandboxProbe {
  platform: Platform
  /** `null` = could not tell (a Linux whose /proc/version was unreadable). */
  wsl: boolean | null
  prlimit: Capability<PrlimitReason>
  ulimit: Capability<UlimitReason> & { flags?: UlimitFlags }
  docker: Capability<DockerReason> & { serverVersion?: string }
  informational: {
    /** Always present: these facts drive NO v1 mechanism. */
    note: string
    landlock: Capability<LandlockReason> & { abi: number | null }
    userNamespaces: Capability<UserNsReason>
  }
}

export const INFORMATIONAL_NOTE =
  'Informational only: no v1 sandbox mechanism uses Landlock or user namespaces ' +
  '(bubblewrap / Landlock / Seatbelt come later, per D-T5); their presence contains nothing today.'

const DEFAULT_TIMEOUT_MS = 5000

// ── Default effects ─────────────────────────────────────────────────────────────────────────────

export const defaultRunner: CommandRunner = async (argv, { timeoutMs }) => {
  try {
    const [cmd] = argv
    if (cmd === undefined) return { kind: 'crashed', message: 'empty argv' }
    if (Bun.which(cmd) === null) return { kind: 'not-found' }
    const proc = Bun.spawn([...argv], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (proc.signalCode !== null && proc.signalCode !== undefined) {
      // Bun's `timeout` kills with killSignal; a kill we did not ask for is still not an answer.
      return proc.signalCode === 'SIGKILL' ? { kind: 'timed-out' } : { kind: 'crashed', message: `signal ${proc.signalCode}` }
    }
    return { kind: 'exited', exitCode, stdout, stderr }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/ENOENT|not found/i.test(message)) return { kind: 'not-found' }
    return { kind: 'crashed', message }
  }
}

export function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function currentPlatform(): Platform {
  const p = process.platform
  return p === 'linux' || p === 'darwin' || p === 'win32' ? p : 'other'
}

// ── Pure classifiers (exported for tests) ───────────────────────────────────────────────────────

function firstLine(s: string): string {
  return s.trim().split('\n')[0]?.trim().slice(0, 300) ?? ''
}

export function classifyWsl(platform: Platform, procVersion: string | null): boolean | null {
  if (platform !== 'linux') return false
  if (procVersion === null) return null
  return /microsoft|wsl/i.test(procVersion)
}

/** `docker version --format '{{.Server.Version}}'` → a capability. Permission is checked FIRST:
 * its message also contains "connect to the Docker daemon". */
export function classifyDocker(r: RunResult): SandboxProbe['docker'] {
  switch (r.kind) {
    case 'not-found':
      return { status: 'unavailable', reason: 'binary-absent' }
    case 'timed-out':
      return { status: 'unknown', reason: 'timed-out' }
    case 'crashed':
      return { status: 'unknown', reason: 'probe-failed', detail: r.message }
    case 'exited': {
      const version = r.stdout.trim()
      if (r.exitCode === 0 && version !== '') return { status: 'available', serverVersion: version }
      const err = `${r.stderr}\n${r.stdout}`
      const detail = firstLine(r.stderr) || firstLine(r.stdout) || undefined
      if (/permission denied/i.test(err)) return { status: 'unavailable', reason: 'permission-denied', ...(detail ? { detail } : {}) }
      if (
        /cannot connect to the docker daemon|is the docker daemon running|error during connect|connection refused|docker\.sock.*no such file|no such file or directory.*docker\.sock/i.test(
          err,
        )
      ) {
        return { status: 'unavailable', reason: 'daemon-down', ...(detail ? { detail } : {}) }
      }
      return { status: 'unknown', reason: 'probe-failed', ...(detail ? { detail } : {}) }
    }
  }
}

export function classifyPrlimit(platform: Platform, r: RunResult | null): SandboxProbe['prlimit'] {
  if (platform !== 'linux' || r === null) return { status: 'unavailable', reason: 'not-linux' }
  switch (r.kind) {
    case 'not-found':
      return { status: 'unavailable', reason: 'not-found' }
    case 'timed-out':
      return { status: 'unknown', reason: 'timed-out' }
    case 'crashed':
      return { status: 'unknown', reason: 'probe-failed', detail: r.message }
    case 'exited':
      if (r.exitCode === 0) return { status: 'available' }
      return { status: 'unavailable', reason: 'refused', detail: firstLine(r.stderr) || `exit ${r.exitCode}` }
  }
}

/** Output of `ULIMIT_PROBE_SCRIPT`: the letters the shell accepted, space-separated. */
export function parseUlimitFlags(stdout: string): UlimitFlags {
  const ok = new Set(stdout.trim().split(/\s+/).filter(Boolean))
  return {
    cpu: ok.has('t') ? '-t' : null,
    addressSpace: ok.has('v') ? '-v' : null,
    fileSize: ok.has('f') ? '-f' : null,
    openFiles: ok.has('n') ? '-n' : null,
    // bash/ksh/zsh-as-sh accept -u; only when -u is REJECTED does -p mean processes (dash, ash).
    processes: ok.has('u') ? '-u' : ok.has('p') ? '-p' : null,
  }
}

export function classifyUlimit(r: RunResult): SandboxProbe['ulimit'] {
  switch (r.kind) {
    case 'not-found':
      return { status: 'unavailable', reason: 'no-posix-sh' }
    case 'timed-out':
      return { status: 'unknown', reason: 'timed-out' }
    case 'crashed':
      return { status: 'unknown', reason: 'probe-failed', detail: r.message }
    case 'exited': {
      if (r.exitCode !== 0) return { status: 'unavailable', reason: 'refused', detail: firstLine(r.stderr) || `exit ${r.exitCode}` }
      const flags = parseUlimitFlags(r.stdout)
      const any = Object.values(flags).some((f) => f !== null)
      if (!any) return { status: 'unavailable', reason: 'refused', detail: 'the shell accepted no ulimit flag', flags }
      return { status: 'available', flags }
    }
  }
}

export function classifyUserNs(platform: Platform, r: RunResult | null): Capability<UserNsReason> {
  if (platform !== 'linux' || r === null) return { status: 'unavailable', reason: 'not-linux' }
  switch (r.kind) {
    case 'not-found':
      return { status: 'unknown', reason: 'no-unshare' }
    case 'timed-out':
      return { status: 'unknown', reason: 'timed-out' }
    case 'crashed':
      return { status: 'unknown', reason: 'probe-failed', detail: r.message }
    case 'exited':
      return r.exitCode === 0
        ? { status: 'available' }
        : { status: 'unavailable', reason: 'refused', detail: firstLine(r.stderr) || `exit ${r.exitCode}` }
  }
}

export function classifyLandlock(platform: Platform, lsm: string | null): SandboxProbe['informational']['landlock'] {
  if (platform !== 'linux') return { status: 'unavailable', reason: 'not-linux', abi: null }
  if (lsm === null) return { status: 'unknown', reason: 'securityfs-unreadable', abi: null }
  const listed = lsm.trim().split(',').map((s) => s.trim())
  return listed.includes('landlock')
    ? { status: 'available', abi: null, detail: 'listed in the active LSMs; ABI not measured (needs the syscall, via bun:ffi later)' }
    : { status: 'unavailable', reason: 'not-enabled', abi: null }
}

// ── The fixed argvs (never built from data) ─────────────────────────────────────────────────────

export const PRLIMIT_PROBE_ARGV = ['prlimit', '--nofile=256', '--', 'true'] as const
/** Each flag is READ (no value) inside a subshell, so an illegal option cannot abort the loop. */
export const ULIMIT_PROBE_SCRIPT =
  'for f in t v f n u p; do if (ulimit -$f) >/dev/null 2>&1; then printf "%s " "$f"; fi; done'
export const ULIMIT_PROBE_ARGV = ['sh', '-c', ULIMIT_PROBE_SCRIPT] as const
export const DOCKER_PROBE_ARGV = ['docker', 'version', '--format', '{{.Server.Version}}'] as const
export const USERNS_PROBE_ARGV = ['unshare', '--user', '--map-root-user', 'true'] as const

// ── The probe ───────────────────────────────────────────────────────────────────────────────────

export async function probeSandbox(deps: ProbeDeps = {}): Promise<SandboxProbe> {
  const run = deps.run ?? defaultRunner
  const readText = deps.readText ?? defaultReadText
  const platform = deps.platform ?? currentPlatform()
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const safeRun = async (argv: readonly string[]): Promise<RunResult> => {
    try {
      return await run(argv, { timeoutMs })
    } catch (err) {
      return { kind: 'crashed', message: err instanceof Error ? err.message : String(err) }
    }
  }
  const safeRead = (path: string): string | null => {
    try {
      return readText(path)
    } catch {
      return null
    }
  }

  const linux = platform === 'linux'
  const [prl, ul, dock, userns] = await Promise.all([
    linux ? safeRun(PRLIMIT_PROBE_ARGV) : Promise.resolve(null),
    // win32 may still have an `sh` (Git Bash, MSYS); let the runner answer rather than assume.
    safeRun(ULIMIT_PROBE_ARGV),
    safeRun(DOCKER_PROBE_ARGV),
    linux ? safeRun(USERNS_PROBE_ARGV) : Promise.resolve(null),
  ])

  return {
    platform,
    wsl: classifyWsl(platform, linux ? safeRead('/proc/version') : null),
    prlimit: classifyPrlimit(platform, prl),
    ulimit: classifyUlimit(ul),
    docker: classifyDocker(dock),
    informational: {
      note: INFORMATIONAL_NOTE,
      landlock: classifyLandlock(platform, linux ? safeRead('/sys/kernel/security/lsm') : null),
      userNamespaces: classifyUserNs(platform, userns),
    },
  }
}
