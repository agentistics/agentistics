import { hostWhich } from './host-which'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { freemem, homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer } from 'node:net'
import { gitEnv } from './backup/repo-probe'
import { applySeed, buildSeed, ensureNoStructured, heavyLockFds, SEED_ALLOW } from './run-seed'
import { insideHeavyLock, runMinAvailableBytes, runWaitMaxMs, shouldAnnounceWait, shouldWaitForMemory, shouldWrapHeavy } from './resources/mem-guard'

export { SEED_ALLOW }
const REAL_API_PORT = 47291
const REAL_WEB_PORT = 47292
const DEFAULT_TTL = '2h'
const THROWAWAY_PORT_BASE = 48100
const STATE_ROOT_NAME = 'agentistics-throwaway'

export function isRealAgentopPort(port: number): boolean { return port === REAL_API_PORT || port === REAL_WEB_PORT }

export type ThrowawayState = {
  name: string
  home: string
  apiPort: number
  webPort: number
  reservationPaths?: string[]
  // Kept for states written by older versions.
  reservationPath?: string
  /** Short per-run TMPDIR/TMUX_TMPDIR (see `createRunTmp`); removed with the run. */
  tmp?: string
  pid?: number
  unit?: string
  startedAt: string
  command: string[]
}

type RunOptions = { name: string; ttl: string; portOffset: number | null; remove: boolean; command: string[]; serve: boolean; seedFrom: string | null; seedReal: boolean; cwd: string | null }

/** A Unix socket path (sun_path) holds 108 bytes including the NUL; Chrome/tmux sockets live under TMPDIR. */
export const SOCKET_PATH_MAX = 107

/**
 * Per-run scratch dir: `/tmp/agr-XXXXXX`. The old `<home>/tmp` sat under the throwaway home
 * (`~/.cache/agentistics-throwaway/<name>-XXXXXX/tmp`, easily 90+ chars), so a socket such as
 * Chrome's `org.chromium.Chromium.XXXXXX/SingletonSocket` passed 108 bytes and Playwright's Chrome
 * died with SIGTRAP at launch. /tmp is used on purpose (not os.tmpdir(), which may itself be long).
 * `mkdtemp` creates it atomically, mode 0700, with an unpredictable name: it fails instead of
 * reusing a directory or following a symlink another user planted at a guessable name.
 */
export const RUN_TMP_PREFIX = '/tmp/agr-'

export function createRunTmp(env: Record<string, string | undefined> = process.env): string {
  // Test seam: `AGENTISTICS_RUN_TMP_TAG=<alnum>` makes the dir `/tmp/agr-<tag>-XXXXXX`, so a test can tell ITS run's
  // dir from every other run's on a shared /tmp. The result still starts with RUN_TMP_PREFIX and sits directly under
  // /tmp, so `removeRunTmp`'s guard is untouched; anything that is not 1-12 alphanumerics is ignored.
  const tag = env.AGENTISTICS_RUN_TMP_TAG
  return mkdtempSync(tag && /^[A-Za-z0-9]{1,12}$/.test(tag) ? `${RUN_TMP_PREFIX}${tag}-` : RUN_TMP_PREFIX)
}

/** Placeholder for the pure env builder when the caller has no created dir; never created. */
const UNSET_RUN_TMP = `${RUN_TMP_PREFIX}unset`

/** Remove a dir this run created. Never follows a symlink (a link is unlinked, its target kept); refuses foreign paths. */
export function removeRunTmp(path: string | undefined): void {
  if (!path || !path.startsWith(RUN_TMP_PREFIX) || path.includes('..') || path.includes('/', RUN_TMP_PREFIX.length)) return
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    else rmSync(path, { recursive: true, force: true })
  } catch {}
}

/**
 * AMBIENTE C2: variables that MOVE a harness's config directory (or the agentistics store) away from the run's own HOME. A
 * throwaway that inherited one would register its MCP port in the owner's real configs. Dropped from every `run --rm` env;
 * the XDG_* dirs are re-set inside the run's HOME. `KIMI_*_HOME` is matched by `isThrowawayEnvDrop`.
 */
export const THROWAWAY_ENV_DROP: readonly string[] = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'COPILOT_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT', 'KIMI_DIR', 'AGENTISTICS_FLOWS', 'AGENTISTICS_DATA_DIR',
  // The store itself: journal, archive and the git-stats cache are resolved from their own variables, not only from AGENTISTICS_DIR.
  'AGENTISTICS_JOURNAL_DIR', 'AGENTISTICS_ARCHIVE_DIR', 'AGENTISTICS_GIT_STATS_CACHE_FILE',
  // Harness homes the server reads (config.ts, account-roots.ts).
  'CLAUDE_DIR', 'CODEX_DIR', 'GEMINI_DIR', 'COPILOT_DIR', 'ANTIGRAVITY_DIR', 'HERMES_HOME',
  'CLAUDE_CREDENTIALS_FILE', 'CLAUDE_JSON_FILE', 'CLAUDE_SETTINGS_FILE', 'CLAUDE_SETTINGS_LOCAL_FILE', 'CODEX_AUTH_FILE',
  // Per-file / per-directory relocations of the store's own state (events, tasks, team sync, parse cache).
  'AGENTISTICS_EVENTS_FILE', 'AGENTISTICS_EVENT_PRODUCER_FILE', 'AGENTISTICS_EVENT_SUBSCRIPTIONS_FILE', 'AGENTISTICS_MOBILE_SUBSCRIPTIONS_FILE',
  'AGENTISTICS_PARSE_CACHE_FILE', 'AGENTISTICS_DELIVERIES_FILE', 'AGENTISTICS_TASKS_FILE', 'AGENTISTICS_TEAM_CONN_DIR', 'AGENTISTICS_TEAM_DIR', 'AGENTISTICS_TEAM_SENT_FILE',
  'AGENTISTICS_TEAM_SYNC_FILE',
  // R1: read through an injected `env` object (opencode-paths.ts, account-login.ts), invisible to a `process.env.X` grep.
  'OPENCODE_DB', 'OPENCODE_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  // A leaked git hook environment would point the run's git at the owner's real repository / index.
  'GIT_DIR', 'GIT_INDEX_FILE',
]
/** Path-moving variables the server reads that a run deliberately KEEPS, each with its reason (the lint test requires every one to be here or in the drop list). */
export const THROWAWAY_ENV_KEEP: Readonly<Record<string, string>> = {
  XDG_RUNTIME_DIR: 'systemd --user scope and the tmux socket dir live there; the run does not own it',
  TMUX_TMPDIR: 'overwritten by buildThrowawayEnv to the run tmp',
  TMPDIR: 'overwritten by buildThrowawayEnv to the run tmp',
  VOLTA_HOME: 'toolchain location, re-set explicitly from the real one so shims resolve',
  AGENTISTICS_DIR: 'overwritten by buildThrowawayEnv to <home>/.agentistics',
  MONGO_DB: 'a database NAME on the (never contacted) central, not a path',
  GIT_COMMON_DIR: 'a git variable, not a store path; the fixtures scrub it through gitEnv()',
  FIXTURE_DIR: 'test-only fixture location, never set in a run',
  XDG_CONFIG_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
  XDG_CACHE_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
  XDG_DATA_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
  XDG_STATE_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
}
export const isThrowawayEnvDrop = (key: string): boolean => THROWAWAY_ENV_DROP.includes(key) || /^KIMI_.*HOME$/.test(key)

export function buildThrowawayEnv(home: string, name: string, apiPort: number, webPort: number, source: NodeJS.ProcessEnv = process.env, opts: { tmp?: string; heavyHeld?: boolean } = {}): NodeJS.ProcessEnv {
  const tmp = opts.tmp ?? UNSET_RUN_TMP
  // Volta shims locate their toolchains relative to HOME unless VOLTA_HOME is set.
  // Capture the original installation before isolating HOME, or a shim may resolve itself.
  const voltaHome = source.VOLTA_HOME || join(source.HOME || source.USERPROFILE || homedir(), '.volta')
  const inherited = Object.fromEntries(Object.entries(source).filter(([k]) => !isThrowawayEnvDrop(k) && !/^XDG_(CONFIG|DATA|STATE|CACHE)_HOME$/.test(k)))
  return {
    ...inherited,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
    ...(source.VOLTA_HOME || existsSync(voltaHome) ? { VOLTA_HOME: voltaHome } : {}),
    HOME: home, USERPROFILE: home, AGENTISTICS_DIR: join(home, '.agentistics'),
    PORT: String(apiPort), WEB_PORT: String(webPort), SERVE_STATIC: '1',
    AGENTISTICS_SERVER_FOREGROUND: '1', AGENTISTICS_EXPERIMENTAL: '0',
    TMUX_TMPDIR: tmp, TMPDIR: tmp, AGENTISTICS_THROWAWAY: name,
    // The run already holds (or inherits) the machine heavy lock: children must not take it again
    // (`insideHeavyLock` reads this, so a nested `agentop heavy`/`agentop run` does not deadlock).
    ...(opts.heavyHeld ? { AGENTISTICS_HEAVY_JOB: '1' } : {}),
  }
}

export function readState(name: string): ThrowawayState | null {
  try { return JSON.parse(readFileSync(statePath(name), 'utf8')) as ThrowawayState } catch { return null }
}

function usage(): string {
  return `Usage: agentop run --rm [--ttl 2h] [--port-offset N] [--name x] -- <command...>
       agentop run --rm [--ttl 2h] [--port-offset N] [--name x]
       agentop run --rm --serve [--seed-from <staging> | --seed-real] [--cwd <worktree>] [--ttl 2h] [--name x] [-- <server command...>]
       agentop run ls
       agentop run stop <name>`
}

export function stateRoot(): string { return join(process.env.HOME || process.env.USERPROFILE || homedir(), '.cache', STATE_ROOT_NAME) }
export function statePath(name: string): string { return join(stateRoot(), `${name}.json`) }
function safeName(value: string): string {
  const name = value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  if (!name) throw new Error('run name must contain letters, numbers, dot, underscore or hyphen')
  return name.slice(0, 48)
}

function parseTtl(value: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(value)
  if (!m) throw new Error(`invalid --ttl ${value}; use e.g. 30m, 2h or 1d`)
  const n = Number(m[1])
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]!]!
}

export function parseArgs(args: string[]): RunOptions | { action: 'ls' } | { action: 'help' } | { action: 'stop'; name: string } {
  if (args[0] === '--help' || args[0] === '-h') return { action: 'help' }
  if (args[0] === 'ls') return { action: 'ls' }
  if (args[0] === 'stop') {
    if (!args[1]) throw new Error('run stop needs a name')
    return { action: 'stop', name: safeName(args[1]) }
  }
  let name = `run-${Date.now().toString(36)}`
  let ttl = DEFAULT_TTL
  let portOffset: number | null = null
  let remove = false
  let serve = false
  let seedFrom: string | null = null
  let seedReal = false
  let cwd: string | null = null
  let command: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { command = args.slice(i + 1); break }
    if (arg === '--rm') { remove = true; continue }
    if (arg === '--serve') { serve = true; continue }
    if (arg === '--seed-real') { seedReal = true; continue }
    if (arg === '--seed-from') { seedFrom = args[++i] ?? ''; continue }
    if (arg === '--cwd') { cwd = args[++i] ?? ''; continue }
    if (arg === '--name') { name = safeName(args[++i] ?? ''); continue }
    if (arg === '--ttl') { ttl = args[++i] ?? ''; parseTtl(ttl); continue }
    if (arg === '--port-offset') {
      const raw = args[++i] ?? ''
      if (!/^\d+$/.test(raw)) throw new Error('--port-offset must be a non-negative integer')
      portOffset = Number(raw)
      continue
    }
    throw new Error(`unknown run option: ${arg}`)
  }
  if (!remove) throw new Error('agentop run requires --rm (throwaway runs are always explicit)')
  if ((seedFrom !== null || seedReal || cwd !== null) && !serve) throw new Error('--seed-from, --seed-real and --cwd only apply with --serve')
  if (seedFrom !== null && seedReal) throw new Error('--seed-from and --seed-real are exclusive')
  return { name, ttl, portOffset, remove, command, serve, seedFrom, seedReal, cwd }
}

type ThrowawayPorts = { apiPort: number; webPort: number; reservationPaths: string[] }

function portReservationRoot(): string { return join(stateRoot(), 'ports') }
function portReservationPath(port: number): string { return join(portReservationRoot(), String(port)) }
function allocationLockPath(): string { return join(portReservationRoot(), '.allocation-lock') }

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function reclaimDeadReservation(path: string): void {
  try {
    const reservation = JSON.parse(readFileSync(join(path, 'reservation.json'), 'utf8')) as { pid?: number }
    if (typeof reservation.pid !== 'number' || !processIsAlive(reservation.pid)) rmSync(path, { recursive: true, force: true })
  } catch {
    // A reservation without its file may still be in the middle of being written.
    try { if (Date.now() - statSync(path).mtimeMs > 10_000) rmSync(path, { recursive: true, force: true }) } catch {}
  }
}

async function acquireAllocationLock(): Promise<string> {
  const path = allocationLockPath()
  for (let attempts = 0; attempts < 1000; attempts++) {
    try {
      mkdirSync(path, { mode: 0o700 })
      writeFileSync(join(path, 'reservation.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
      return path
    } catch {
      reclaimDeadReservation(path)
      await Bun.sleep(5)
    }
  }
  throw new Error('timed out waiting for the throwaway port allocator')
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    // The server binds 0.0.0.0 (index.ts), so that is the address to probe: 127.0.0.1 alone misses a
    // listener on another interface, which still makes the server's own bind fail with EADDRINUSE.
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)))
  })
}

/** A registered run is live while its pid answers or anything still carries its HOME (relays outlive the launcher). */
function runIsLive(state: ThrowawayState): boolean {
  if (typeof state.pid === 'number' && alive(state.pid)) return true
  return process.platform === 'linux' && runOwnedPids(state.home).length > 0
}

/**
 * Dead registered runs (launcher killed, state never cleaned) kept the registry — and `agentop run ls` — full of
 * entries for ports nobody holds. Prune only entries with no live pid and nothing carrying their HOME; returns the
 * ports held by LIVE registered runs so the picker can skip them.
 */
export function pruneStaleRuns(): Set<number> {
  const held = new Set<number>()
  for (const state of readStates()) {
    if (!state || typeof state.name !== 'string' || typeof state.home !== 'string') continue
    if (runIsLive(state)) { held.add(state.apiPort); held.add(state.webPort); continue }
    if (!state.home.startsWith(stateRoot() + sep)) continue // never delete a home outside the run registry
    rmSync(state.home, { recursive: true, force: true })
    removeRunTmp(state.tmp)
    releaseThrowawayPorts(state.reservationPaths ?? state.reservationPath)
    rmSync(statePath(state.name), { force: true })
  }
  return held
}

export async function reserveThrowawayPorts(preferred: number): Promise<ThrowawayPorts> {
  mkdirSync(portReservationRoot(), { recursive: true, mode: 0o700 })
  const lockPath = await acquireAllocationLock()
  try {
    const held = pruneStaleRuns()
    let apiPort = Math.max(1024, preferred)
    for (let attempts = 0; attempts < 1000 && apiPort < 65534; attempts++, apiPort++) {
      const webPort = apiPort + 1
      if (isRealAgentopPort(apiPort) || isRealAgentopPort(webPort) || held.has(apiPort) || held.has(webPort)) continue
      const apiReservationPath = portReservationPath(apiPort)
      try {
        mkdirSync(apiReservationPath, { mode: 0o700 })
      } catch {
        reclaimDeadReservation(apiReservationPath)
        try { mkdirSync(apiReservationPath, { mode: 0o700 }) } catch { continue }
      }
      writeFileSync(join(apiReservationPath, 'reservation.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
      const webReservationPath = portReservationPath(webPort)
      try {
        mkdirSync(webReservationPath, { mode: 0o700 })
      } catch {
        reclaimDeadReservation(webReservationPath)
        try { mkdirSync(webReservationPath, { mode: 0o700 }) } catch {
          rmSync(apiReservationPath, { recursive: true, force: true })
          continue
        }
      }
      writeFileSync(join(webReservationPath, 'reservation.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
      try {
        if (await portIsFree(apiPort) && await portIsFree(webPort)) {
          return { apiPort, webPort, reservationPaths: [apiReservationPath, webReservationPath] }
        }
      } catch {
        // A failed bind probe must not leave a reservation behind.
      }
      rmSync(apiReservationPath, { recursive: true, force: true })
      rmSync(webReservationPath, { recursive: true, force: true })
    }
    throw new Error('no free throwaway port is available')
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}

export function releaseThrowawayPorts(reservationPaths: string[] | string | undefined): void {
  for (const reservationPath of reservationPaths ? (Array.isArray(reservationPaths) ? reservationPaths : [reservationPaths]) : []) {
    rmSync(reservationPath, { recursive: true, force: true })
  }
}

export function readStates(): ThrowawayState[] {
  try { return readdirSync(stateRoot()).flatMap(file => {
    try { return [JSON.parse(readFileSync(join(stateRoot(), file), 'utf8')) as ThrowawayState] } catch { return [] }
  }) } catch { return [] }
}

/**
 * Pids whose environment carries this run's own HOME — the per-run `mkdtemp` directory, unique to
 * the run, which `buildThrowawayEnv` puts in every process the run starts and which children
 * inherit. That is how the run's STRUCTURED RELAYS (and a tmux server) are found: they start
 * `setsid`-detached, so neither the run's process group nor, off systemd, any tree walk reaches
 * them, and a relay outlives the server that launched it by design. An EXACT match on the
 * environment entry — never a name or an argv substring — so nothing outside the run can match.
 */
export function runOwnedPids(home: string, procRoot = '/proc', self = process.pid): number[] {
  const needle = `HOME=${home}`
  const out: number[] = []
  let entries: string[]
  try { entries = readdirSync(procRoot) } catch { return out }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === self) continue
    try {
      if (readFileSync(join(procRoot, entry, 'environ'), 'utf8').split('\0').includes(needle)) out.push(pid)
    } catch { /* gone, or not ours to read */ }
  }
  return out
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

/** TERM everything the run owns, wait, then KILL what is left. Returns the pids that needed KILL. */
export async function reapRunOwned(home: string, graceMs = 3000, procRoot = '/proc'): Promise<number[]> {
  const pids = runOwnedPids(home, procRoot)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && pids.some(alive)) await Bun.sleep(50)
  const left = pids.filter(alive)
  for (const pid of left) { try { process.kill(pid, 'SIGKILL') } catch {} }
  return left
}

export async function stopState(state: ThrowawayState): Promise<void> {
  if (state.unit && process.platform === 'linux' && existsSync('/run/systemd/system')) {
    const result = spawn('systemctl', ['--user', 'stop', state.unit], { stdio: 'ignore' })
    await new Promise<void>(resolve => { result.once('exit', () => resolve()); result.once('error', () => resolve()) })
  } else if (state.pid) {
    try { process.kill(-state.pid, 'SIGTERM') } catch { try { process.kill(state.pid, 'SIGTERM') } catch {} }
  }
  // Backstop for the detached relays/tmux the group kill and (off systemd) the scope never reach.
  if (process.platform === 'linux') await reapRunOwned(state.home)
  rmSync(state.home, { recursive: true, force: true })
  removeRunTmp(state.tmp)
  releaseThrowawayPorts(state.reservationPaths ?? state.reservationPath)
  rmSync(statePath(state.name), { force: true })
  console.log(`removed ${state.home}`)
}

async function listRuns(): Promise<number> {
  for (const state of readStates()) {
    console.log(`${state.name}\tapi=${state.apiPort}\tweb=${state.webPort}\thome=${state.home}${state.unit ? `\tunit=${state.unit}` : `\tpid=${state.pid ?? '-'}`}`)
  }
  return 0
}

/** cmdlines of this process's ancestors (Linux /proc); empty where unreadable. */
export function ancestorCmdlines(): string[] {
  const out: string[] = []
  let pid = process.ppid
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    try {
      out.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim())
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    } catch { break }
  }
  return out
}

export function memAvailableBytes(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
    return m ? Number(m[1]) * 1024 : null
  } catch { return null }
}

/**
 * PURE. Available memory from macOS `vm_stat` output: free + inactive + speculative + purgeable pages, times the page size
 * the header states. `os.freemem()` on macOS counts only the FREE pages, so a healthy Mac routinely reports under 3 GB —
 * the inactive/cached pages are reclaimable and are what "available" means on Linux's `MemAvailable`.
 */
export function parseVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text)
  if (!size) return null
  const pages = (label: string) => { const m = new RegExp(`^${label}:\\s+(\\d+)\\.?`, 'm').exec(text); return m ? Number(m[1]) : 0 }
  const free = pages('Pages free'), inactive = pages('Pages inactive'), speculative = pages('Pages speculative'), purgeable = pages('Pages purgeable')
  if (!free && !inactive) return null
  return (free + inactive + speculative + purgeable) * Number(size[1])
}

/**
 * The machine's AVAILABLE memory on any platform: `MemAvailable` on Linux, `vm_stat` on macOS (see `parseVmStat`),
 * `os.freemem()` elsewhere. null = unmeasured.
 */
export function memAvailableAnyBytes(): number | null {
  if (process.platform === 'linux') return memAvailableBytes()
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('vm_stat', [], { encoding: 'utf8', timeout: 3000 })
      const n = parseVmStat(out)
      if (n !== null) return n
    } catch { /* fall through to freemem */ }
  }
  try { return freemem() } catch { return null }
}

/**
 * MEM.GUARD: a heavy job does not start while the machine is short of memory. Runs BEFORE anything
 * is created on disk, so an interrupted wait leaves nothing behind. Gives up after `runWaitMaxMs`
 * (false); `AGENTISTICS_RUN_NO_WAIT=1` skips. Unmeasured (not Linux) never waits.
 */
async function waitForMemory(): Promise<boolean> {
  if (process.env.AGENTISTICS_RUN_NO_WAIT === '1') return true
  const min = runMinAvailableBytes()
  const deadline = Date.now() + runWaitMaxMs()
  let last: { gb: string; at: number } | null = null
  for (;;) {
    const avail = memAvailableBytes()
    if (!shouldWaitForMemory(avail, min)) return true
    const now = Date.now()
    if (now >= deadline) {
      console.error(`agentop run: gave up after waiting ${Math.round(runWaitMaxMs() / 60000)} min — the machine still has only ${(avail! / 1024 ** 3).toFixed(1)} GB of memory free. Close something heavy and try again.`)
      return false
    }
    if (shouldAnnounceWait(last, avail!, now)) {
      const gb = (avail! / 1024 ** 3).toFixed(1)
      console.error(`agentop run: waiting for memory — ${gb} GB available, need ${(min / 1024 ** 3).toFixed(1)} GB`)
      last = { gb, at: now }
    }
    await Bun.sleep(2000)
  }
}

/** The data dir the flows write under (`<dataDir>/flows/ambientes/<id>/semente/` is the only place a seed may come from). */
export function realDataDir(): string { return process.env.AGENTISTICS_DIR || join(homedir(), '.agentistics') }

/** `--seed-from` accepts a path only inside `<dataDir>/flows/ambientes/<id>/semente/` (realpath), never anything else. */
export function seedSourceOk(path: string, dataDir = realDataDir()): string | null {
  let real: string
  try { real = realpathSync(path) } catch { return null }
  let base: string
  try { base = realpathSync(join(dataDir, 'flows', 'ambientes')) } catch { return null }
  const rel = real.startsWith(base + sep) ? real.slice(base.length + 1).split(sep) : null
  return rel && rel.length >= 2 && rel[1] === 'semente' ? real : null
}

/**
 * Runs the (synchronous) seed with SIGTERM/SIGINT remembered rather than lost: a failure cleans up and rethrows; a signal that arrived
 * during the seed cleans up as soon as it ends and reports `interrupted`. Handlers are removed again on every path.
 */
export async function guardedSeed(seed: () => void, cleanup: () => void, signals: Pick<NodeJS.Process, 'on' | 'off'> = process): Promise<'done' | 'interrupted'> {
  let hit = false
  const mark = () => { hit = true }
  signals.on('SIGTERM', mark); signals.on('SIGINT', mark)
  try {
    try { seed() } catch (error) { cleanup(); throw error }
    await new Promise<void>(resolveTick => setTimeout(resolveTick, 0))
    if (hit) { cleanup(); return 'interrupted' }
    return 'done'
  } finally { signals.off('SIGTERM', mark); signals.off('SIGINT', mark) }
}

/** `--cwd` accepts a linked git worktree only (its git-dir differs from the common dir). */
export function serveCwdOk(dir: string): string | null {
  try {
    const real = realpathSync(dir)
    const env = gitEnv()
    const run = (a: string[]) => Bun.spawnSync(['git', '-C', real, ...a], { stdout: 'pipe', stderr: 'ignore', env }).stdout.toString().trim()
    const gd = run(['rev-parse', '--absolute-git-dir']), cd = run(['rev-parse', '--git-common-dir'])
    if (!gd || !cd) return null
    const gitDir = realpathSync(gd)
    const common = realpathSync(resolve(real, cd))
    return gitDir !== common ? real : null
  } catch { return null }
}

/** `--serve` is long-lived: it must never sit under (or hold a descriptor of) the machine-wide heavy lock. */
export function serveLockRefusal(env: NodeJS.ProcessEnv, ancestors: string[], fds: number[]): string | null {
  if (insideHeavyLock(env, ancestors)) return 'agentop run --serve was started inside a heavy job; the server would stay tied to its lock. Run it from outside.'
  if (fds.length) return `agentop run --serve inherited the heavy lock (fd ${fds.join(', ')}); the server would hold it. Run it from outside.`
  return null
}

async function startRun(options: RunOptions): Promise<number> {
  if (options.serve) {
    const refusal = serveLockRefusal(process.env, ancestorCmdlines(), heavyLockFds('self'))
    if (refusal) { console.error(refusal); return 4 }
    if (options.seedFrom !== null && !seedSourceOk(options.seedFrom)) { console.error('--seed-from must be a staged seed under <dataDir>/flows/ambientes/<id>/semente/'); return 2 }
    if (options.cwd !== null && !serveCwdOk(options.cwd)) { console.error('--cwd must be a linked git worktree'); return 2 }
  }
  if (!await waitForMemory()) return 3
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 })
  if (existsSync(statePath(options.name))) throw new Error(`a throwaway run named ${options.name} already exists`)
  const home = mkdtempSync(join(stateRoot(), `${safeName(options.name)}-`))
  const agentistics = join(home, '.agentistics')
  mkdirSync(agentistics, { recursive: true, mode: 0o700 })
  for (const dir of ['.claude', '.codex', '.gemini', '.copilot']) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 })
  let ports: ThrowawayPorts
  try {
    const preferred = options.portOffset === null ? THROWAWAY_PORT_BASE : REAL_API_PORT + options.portOffset
    if (isRealAgentopPort(preferred) || isRealAgentopPort(preferred + 1)) {
      throw new Error(`--port-offset ${options.portOffset} would land on the real agentop ports ${REAL_API_PORT}/${REAL_WEB_PORT}; refused`)
    }
    ports = await reserveThrowawayPorts(preferred)
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
  const { apiPort, webPort, reservationPaths } = ports
  const cleanupSeed = () => { releaseThrowawayPorts(reservationPaths); rmSync(home, { recursive: true, force: true }) }
  // R3: a SIGTERM/SIGINT that lands while the (synchronous) seed copy runs is honoured the moment it ends: the half-built home and the port reservations go.
  const seeded = await guardedSeed(() => {
    if (options.seedFrom !== null) applySeed(join(seedSourceOk(options.seedFrom)!, '.agentistics'), agentistics)
    // B4: the allow-list copy of the REAL store runs HERE, in the run's own launcher process, never inside the real server's event loop.
    if (options.seedReal) buildSeed(realDataDir(), agentistics)
    ensureNoStructured(agentistics)
  }, cleanupSeed)
  if (seeded === 'interrupted') return 143
  const state: ThrowawayState = { name: options.name, home, apiPort, webPort, reservationPaths, startedAt: new Date().toISOString(), command: options.command }
  const script = process.argv[1]
  const inside = insideHeavyLock(process.env, ancestorCmdlines())
  const heavyPrefix = options.serve ? [] : shouldWrapHeavy({
    hasCommand: options.command.length > 0, linux: process.platform === 'linux', hasFlock: !!hostWhich('flock'),
    inside,
  }) ? (script?.endsWith('.ts') || script?.endsWith('.js') ? [process.execPath, script, 'heavy', '--'] : [process.execPath, 'heavy', '--']) : []
  const argv = options.command.length ? [...heavyPrefix, ...options.command] : (script?.endsWith('.ts') || script?.endsWith('.js') ? [process.execPath, script, 'server'] : [process.execPath, 'server'])
  const tmp = createRunTmp()
  state.tmp = tmp
  let child: ReturnType<typeof spawn>
  let systemd = false
  const unit = `agentistics-throwaway-${options.name}.scope`
  try {
    const env = buildThrowawayEnv(home, options.name, apiPort, webPort, process.env, { tmp, heavyHeld: inside || heavyPrefix.length > 0 })
    systemd = process.platform === 'linux' && !!process.env.XDG_RUNTIME_DIR && await commandExists('systemd-run')
    const childArgs = systemd ? ['--user', '--scope', '--unit', unit.replace(/\.scope$/, ''), '-p', 'MemoryMax=2G', '-p', `RuntimeMaxSec=${parseTtl(options.ttl)}`, '--', ...argv] : argv
    child = spawn(systemd ? 'systemd-run' : argv[0]!, systemd ? childArgs : argv.slice(1), { env, stdio: 'inherit', detached: !systemd, ...(options.cwd ? { cwd: serveCwdOk(options.cwd)! } : {}) })
    state.pid = child.pid
    if (systemd) state.unit = unit
    writeFileSync(statePath(options.name), JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch (error) {
    removeRunTmp(tmp)
    throw error
  }
  console.log(`throwaway ${options.name}`)
  console.log(`  api:  http://localhost:${apiPort}`)
  console.log(`  web:  http://localhost:${webPort}`)
  console.log(`  home: ${home}`)
  console.log(`  stop: agentop run stop ${options.name}`)

  // One shared promise: a signal handler and the normal exit path both call this, and the second
  // caller must wait for the first one's removal instead of exiting the process under it.
  let cleaning: Promise<void> | undefined
  const cleanup = () => (cleaning ??= stopState(state))
  // The command's end is recorded in the log BEFORE any cleanup line, so whoever reads run.log (the ambiente flow) can name the exit code.
  const childExit = new Promise<number>(resolve => {
    child.once('exit', (status, sig) => { console.log(status !== null ? `exit ${status}` : `exit signal ${sig}`); resolve(status ?? (sig ? 1 : 0)) })
    child.once('error', () => { console.log('exit 1'); resolve(1) })
  })
  const signal = async (sig: NodeJS.Signals) => { try { process.kill(child.pid!, sig) } catch {} ; await childExit; await cleanup(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)) }
  process.once('SIGINT', () => void signal('SIGINT'))
  process.once('SIGTERM', () => void signal('SIGTERM'))
  // The run is tied to whoever started it. A session's pane hangs up its process group when the
  // session is killed — the default SIGHUP action ended this launcher WITHOUT its cleanup, and the
  // run's systemd scope (a cgroup of its own) kept the command alive until its TTL (03/11: run-r*
  // scopes still active after their session ended). A parent that died outright reparents us: same.
  process.once('SIGHUP', () => void signal('SIGTERM'))
  const parentWatch = watchParent(process.ppid, () => process.ppid, () => void signal('SIGTERM'))
  const ttlTimer = setTimeout(() => { try { process.kill(child.pid!, 'SIGTERM') } catch {} }, parseTtl(options.ttl) * 1000)
  const code = await childExit
  clearTimeout(ttlTimer)
  clearInterval(parentWatch)
  await cleanup()
  return code
}

/** Calls `onGone` once when the launcher's parent changes (it died and we were reparented). */
export function watchParent(initial: number, current: () => number, onGone: () => void, everyMs = 1000): ReturnType<typeof setInterval> {
  let fired = false
  const t = setInterval(() => {
    if (fired || current() === initial) return
    fired = true
    clearInterval(t)
    onGone()
  }, everyMs)
  t.unref?.()
  return t
}

async function commandExists(command: string): Promise<boolean> {
  const check = spawn('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' })
  return await new Promise(resolve => { check.once('exit', code => resolve(code === 0)); check.once('error', () => resolve(false)) })
}

export async function runRun(args: string[]): Promise<number> {
  try {
    const parsed = parseArgs(args)
    if ('action' in parsed) {
      if (parsed.action === 'help') { console.log(usage()); return 0 }
      if (parsed.action === 'ls') return listRuns()
      const stateFile = statePath(parsed.name)
      if (!existsSync(stateFile)) throw new Error(`no throwaway run named ${parsed.name}`)
      await stopState(JSON.parse(readFileSync(stateFile, 'utf8')) as ThrowawayState)
      return 0
    }
    return await startRun(parsed)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
    return 2
  }
}
