/**
 * sandbox/wrap-argv.ts — the PURE argv builders behind the launcher (D-T5).
 *
 * Every function here maps (limits | docker settings, plan) → argv with no I/O, so the exact argv a
 * wrapped command runs under is pinned by tests byte for byte. Two properties are what the tests
 * guard, because each is how this kind of wrapper usually goes wrong:
 *
 *  1. **The wrapped argv is never interpolated into a string.** `prlimit … -- <argv>` hands it to
 *     `execvp` as-is; the `ulimit` fallback is `sh -c '<fixed script>' sh <argv…>`, where the script
 *     ends in `exec "$@"` and the argv arrives POSITIONALLY. The only things interpolated into the
 *     script are integers this module formatted itself. So a command containing spaces, quotes,
 *     `$(…)` or `;` reaches the program exactly as the model wrote it — the policy (D-T3) judged
 *     that argv, and it must be the one that runs.
 *  2. **Environment VALUES never reach an argv.** `docker run -e NAME` (no `=value`) makes the
 *     docker client forward the value from its own environment, which is the plan's `env`. An argv
 *     is visible to every user on the machine through `/proc/<pid>/cmdline` and `ps`; an env is not.
 *
 * Resource limits are NOT containment. `setrlimit` bounds CPU seconds, address space, file size,
 * process count and open files; it restricts nothing about what can be READ or REACHED. That is why
 * an rlimit-only launcher reports state `none` (see `./launcher.ts`).
 *
 * One limit carries a caveat worth knowing: `RLIMIT_NPROC` (prlimit `--nproc`, ulimit `-u`/`-p`)
 * counts every process owned by the ACCOUNT, not the wrapped tree — set it below the number of
 * processes the user already runs and the first `fork` inside fails. It is applied as configured and
 * nothing here second-guesses it; inside a container `--pids-limit` is the tree-scoped bound, so the
 * container path does not map it (see `dockerRunArgv`).
 */

import { isAbsolute, relative, resolve, sep } from 'path'
import type { UlimitFlags } from './probe'

export interface ResourceLimits {
  /** RLIMIT_CPU, seconds of CPU time. */
  cpuSeconds?: number
  /** RLIMIT_AS, bytes of virtual address space. */
  addressSpaceBytes?: number
  /** RLIMIT_FSIZE, bytes — the largest file the process may write. */
  fileSizeBytes?: number
  /** RLIMIT_NPROC — counts the whole ACCOUNT's processes, see the header. */
  processes?: number
  /** RLIMIT_NOFILE, open file descriptors. */
  openFiles?: number
}

export type LimitName = keyof ResourceLimits
export const LIMIT_NAMES: readonly LimitName[] = [
  'cpuSeconds',
  'addressSpaceBytes',
  'fileSizeBytes',
  'processes',
  'openFiles',
]

/** The first limit that is not a positive safe integer, or `null`. */
export function invalidLimit(limits: ResourceLimits): LimitName | null {
  for (const name of LIMIT_NAMES) {
    const v = limits[name]
    if (v === undefined) continue
    if (!Number.isSafeInteger(v) || v <= 0) return name
  }
  return null
}

export function hasLimits(limits: ResourceLimits | undefined): boolean {
  return limits !== undefined && LIMIT_NAMES.some((n) => limits[n] !== undefined)
}

// ── prlimit ─────────────────────────────────────────────────────────────────────────────────────

const PRLIMIT_FLAG: Record<LimitName, string> = {
  cpuSeconds: '--cpu',
  addressSpaceBytes: '--as',
  fileSizeBytes: '--fsize',
  processes: '--nproc',
  openFiles: '--nofile',
}

/** `prlimit --cpu=N … -- <argv>`. A single value sets soft AND hard, so the child cannot raise it. */
export function prlimitArgv(limits: ResourceLimits, argv: readonly string[]): string[] {
  const out = ['prlimit']
  for (const name of LIMIT_NAMES) {
    const v = limits[name]
    if (v !== undefined) out.push(`${PRLIMIT_FLAG[name]}=${v}`)
  }
  out.push('--', ...argv)
  return out
}

// ── ulimit (POSIX sh fallback) ──────────────────────────────────────────────────────────────────

/**
 * Units in `sh`: `-v` is KiB; `-f` is 512-byte blocks (POSIX, and what bash uses when invoked as
 * `sh`, i.e. in POSIX mode; dash and busybox ash agree). `-t` seconds, `-n`/`-u`/`-p` counts.
 * Byte limits round DOWN (never looser than configured), with a floor of 1 unit.
 */
export function ulimitValue(name: LimitName, v: number): number {
  if (name === 'addressSpaceBytes') return Math.max(1, Math.floor(v / 1024))
  if (name === 'fileSizeBytes') return Math.max(1, Math.floor(v / 512))
  return v
}

function ulimitFlag(name: LimitName, flags: UlimitFlags): string | null {
  switch (name) {
    case 'cpuSeconds':
      return flags.cpu
    case 'addressSpaceBytes':
      return flags.addressSpace
    case 'fileSizeBytes':
      return flags.fileSize
    case 'processes':
      return flags.processes
    case 'openFiles':
      return flags.openFiles
  }
}

/** The limits this shell cannot express — said by the launcher, never dropped silently. */
export function ulimitUnsupported(limits: ResourceLimits, flags: UlimitFlags): LimitName[] {
  return LIMIT_NAMES.filter((n) => limits[n] !== undefined && ulimitFlag(n, flags) === null)
}

/**
 * `sh -c 'ulimit -t 30 && ulimit -n 64 && exec "$@"' sh <argv…>`. `&&`: a limit the shell refuses
 * stops the command instead of running it unlimited. Unsupported limits are skipped here; the
 * caller reports them (`ulimitUnsupported`).
 */
export function ulimitArgv(limits: ResourceLimits, flags: UlimitFlags, argv: readonly string[]): string[] {
  const steps: string[] = []
  for (const name of LIMIT_NAMES) {
    const v = limits[name]
    const flag = ulimitFlag(name, flags)
    if (v === undefined || flag === null) continue
    steps.push(`ulimit ${flag} ${ulimitValue(name, v)}`)
  }
  steps.push('exec "$@"')
  return ['sh', '-c', steps.join(' && '), 'sh', ...argv]
}

// ── docker ──────────────────────────────────────────────────────────────────────────────────────

export interface DockerSettings {
  image: string
  /** `none` unless explicitly widened. */
  network: 'none' | 'bridge'
  /** Absolute. Mounted read-write at the SAME path, so paths the model sees stay valid inside. */
  workspaceRoot: string
  memory: string
  pidsLimit: number
  readOnlyRoot: boolean
  uid: number
  gid: number
}

/**
 * Env names forwarded with `-e NAME` are the plan's, MINUS these: they describe the HOST (its
 * PATH, its home, its docker client config) and would break or mislead the image's own runtime.
 * They still reach the docker CLIENT through the spawn env, which is where they belong.
 */
export const HOST_ONLY_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TMPDIR'])
export function isHostOnlyEnv(name: string): boolean {
  return HOST_ONLY_ENV.has(name) || name.startsWith('DOCKER_')
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Docker's `--ulimit` names for the limits that are per-PROCESS inside a container. */
const DOCKER_ULIMIT: Partial<Record<LimitName, string>> = {
  cpuSeconds: 'cpu',
  addressSpaceBytes: 'as',
  fileSizeBytes: 'fsize',
  openFiles: 'nofile',
  // processes: deliberately absent — RLIMIT_NPROC counts the host uid's processes (no userns
  // remap), so `--pids-limit` is the bound that actually scopes to the container.
}

export function dockerRunArgv(
  s: DockerSettings,
  plan: { argv: readonly string[]; cwd: string; env: Record<string, string> },
  limits: ResourceLimits = {},
): string[] {
  const out = [
    'docker', 'run', '--rm', '-i', '--init',
    '--network', s.network,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(s.pidsLimit),
    '--memory', s.memory,
    '--user', `${s.uid}:${s.gid}`,
    '-v', `${s.workspaceRoot}:${s.workspaceRoot}`,
    '-w', plan.cwd,
  ]
  if (s.readOnlyRoot) out.push('--read-only', '--tmpfs', '/tmp')
  for (const name of LIMIT_NAMES) {
    const v = limits[name]
    const dn = DOCKER_ULIMIT[name]
    if (v !== undefined && dn !== undefined) out.push('--ulimit', `${dn}=${v}`)
  }
  for (const name of Object.keys(plan.env).sort()) {
    if (isHostOnlyEnv(name)) continue
    out.push('-e', name)
  }
  out.push(s.image, ...plan.argv)
  return out
}

/** True when `cwd` is `root` or below it (lexically; both resolved). */
export function isInside(root: string, cwd: string): boolean {
  const rel = relative(resolve(root), resolve(cwd))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
