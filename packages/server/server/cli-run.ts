import { hostWhich } from './host-which'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { freemem, homedir, hostname, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer } from 'node:net'
import { gitEnv } from './backup/repo-probe'
import { CURRENT_VERSION } from './version'
import { applySeed, buildSeed, ensureNoStructured, heavyLockFds, SEED_ALLOW } from './run-seed'
import { blockedPorts, createCtlDir, netnsHardening, outsideNodeModules, persistenceGuard, hostAddresses, forwardPorts, netnsArgv, netnsNotice, pollHostAddresses, probeNetns, removeCtlDir, startSlirp, stopSlirp } from './run-netns'
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
  /** slirp4netns serving this run's network namespace (see run-netns.ts); signalled only while it still is a slirp4netns. */
  slirpPid?: number
  /** Directory holding the slirp API socket (N4): hidden from the run; removed with it. */
  ctl?: string
  unit?: string
  startedAt: string
  command: string[]
}

type RunOptions = { name: string; ttl: string; portOffset: number | null; remove: boolean; command: string[]; serve: boolean; seedFrom: string | null; seedReal: boolean; cwd: string | null; keepEnv: string[]; noNetns: boolean }

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
  'OPENCODE_CONFIG_CONTENT', 'KIMI_DIR', 'AGENTISTICS_DATA_DIR',
  // The store itself: journal, archive and the git-stats cache are resolved from their own variables, not only from AGENTISTICS_DIR.
  'AGENTISTICS_JOURNAL_DIR', 'AGENTISTICS_ARCHIVE_DIR', 'AGENTISTICS_GIT_STATS_CACHE_FILE',
  // Harness homes the server reads (config.ts, account-roots.ts).
  'CLAUDE_DIR', 'CODEX_DIR', 'GEMINI_DIR', 'COPILOT_DIR', 'ANTIGRAVITY_DIR', 'HERMES_HOME',
  'CLAUDE_CREDENTIALS_FILE', 'CLAUDE_JSON_FILE', 'CLAUDE_SETTINGS_FILE', 'CLAUDE_SETTINGS_LOCAL_FILE', 'CODEX_AUTH_FILE',
  // Per-file / per-directory relocations of the store's own state (events, tasks, parse cache).
  'AGENTISTICS_EVENTS_FILE', 'AGENTISTICS_EVENT_PRODUCER_FILE', 'AGENTISTICS_EVENT_SUBSCRIPTIONS_FILE', 'AGENTISTICS_MOBILE_SUBSCRIPTIONS_FILE',
  'AGENTISTICS_PARSE_CACHE_FILE', 'AGENTISTICS_DELIVERIES_FILE', 'AGENTISTICS_TASKS_FILE',
  // R1: read through an injected `env` object (opencode-paths.ts, account-login.ts), invisible to a `process.env.X` grep.
  'OPENCODE_DB', 'OPENCODE_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  // A leaked git hook environment would point the run's git at the owner's real repository / index.
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]
/** Every GIT_CONFIG_* (GLOBAL, SYSTEM, NOSYSTEM, COUNT, KEY_n, VALUE_n, ...): a hook leaks them and they redirect the run's git to the real config. */
const isGitConfigLeak = (key: string): boolean => /^GIT_CONFIG_/i.test(key)
/** The git variables dropped from a run (a hook leaks them; they point git at the real checkout). `--keep-env` may keep one explicitly. */
const isGitLeak = (key: string): boolean => THROWAWAY_ENV_DROP.some(k => k === key.toUpperCase() && k.startsWith('GIT_')) || isGitConfigLeak(key)
/** Path-moving variables the server reads that a run deliberately KEEPS, each with its reason (the lint test requires every one to be here or in the drop list). */
export const THROWAWAY_ENV_KEEP: Readonly<Record<string, string>> = {
  XDG_RUNTIME_DIR: 'systemd --user scope and the tmux socket dir live there; the run does not own it',
  TMUX_TMPDIR: 'overwritten by buildThrowawayEnv to the run tmp',
  TMPDIR: 'overwritten by buildThrowawayEnv to the run tmp',
  VOLTA_HOME: 'toolchain location, re-set explicitly from the real one so shims resolve',
  AGENTISTICS_DIR: 'overwritten by buildThrowawayEnv to <home>/.agentistics',
  FIXTURE_DIR: 'test-only fixture location, never set in a run',
  XDG_CONFIG_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
  XDG_CACHE_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
  XDG_DATA_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
  XDG_STATE_HOME: 'dropped and re-set inside the run HOME by buildThrowawayEnv',
  PLAYWRIGHT_BROWSERS_PATH: 'read-only location of the browser executables (browser-bin.ts); holds no store, config or secret',
  AGENTISTICS_HOME: 'read only by noq-policy as a path a no-questions session may never write to; it relocates nothing',
}
/**
 * RUN.FLOWS-HERDADO: the AGENTISTICS_* names (and the session identity) a run KEEPS from its parent, each with its reason.
 * Everything else under those prefixes is a behaviour switch of the REAL app (`AGENTISTICS_FLOWS`, `_PROVIDER`, `_ADAPTER_CHAT`,
 * `_JOURNAL`, `_MULTI_ACCOUNT`, `_EXPERIMENTAL_APPLIED`, ...) and is dropped: a managed session carries them in its environment,
 * and a throwaway server that inherited them ran the real destructive flows against real paths (21/11: 15 real worktrees removed).
 * A prefix rule, not a hand list, so the next switch is dropped by having been added. `--keep-env NAME` re-allows one.
 */
export const THROWAWAY_ENV_ALLOW: Readonly<Record<string, string>> = {
  AGENTISTICS_HEAVY_JOB: 'the machine heavy-lock marker; a nested agentop heavy/run must not take the lock again',
  AGENTISTICS_RUN_TMP_TAG: 'test seam that names the run tmp dir; touches nothing real',
  AGENTISTICS_RUN_NO_WAIT: 'run memory-guard knob; only shortens the launcher wait',
  AGENTISTICS_RUN_MIN_AVAILABLE_MB: 'run memory-guard knob; a threshold, no behaviour switch',
  AGENTISTICS_RUN_WAIT_MAX_SEC: 'run memory-guard knob; a threshold, no behaviour switch',
  AGENTISTICS_ADMISSION_RESERVE_MB: 'memory admission threshold; a number, not a behaviour switch',
  AGENTISTICS_REAPER: 'a protective narrower (=0 switches the reaper off); dropping it would turn the reaper ON in the run',
  AGENTISTICS_GOVERNOR: 'a protective narrower (=0 switches the governor kills off); dropping it would turn them ON in the run',
  AGENTISTICS_AUTO_RECONCILE: 'a protective narrower (=0 switches auto-reconcile off); dropping it would turn it ON in the run',
  AGENTISTICS_NO_UPDATE_CHECK: 'a protective narrower; keeps the run from checking or installing updates',
  AGENTISTICS_BROWSER_BIN: 'location of the browser executable the QA drives; holds no store, config or secret',
  AGENTISTICS_BROWSER_NO_SANDBOX: 'browser launch flag for containers; no real resource',
  AGENTISTICS_LANG: 'language of the CLI output only',
}
/** A behaviour switch of the real app (or the identity of the real session) that a run must not inherit. */
export const isThrowawaySwitch = (key: string): boolean => /^(AGENTISTICS|AGENTOP)_/i.test(key) && !Object.hasOwn(THROWAWAY_ENV_ALLOW, key)
export const isThrowawayEnvDrop = (key: string): boolean => THROWAWAY_ENV_DROP.includes(key) || /^KIMI_.*HOME$/.test(key) || isThrowawaySwitch(key) || isGitLeak(key)

/** Canonical host text: lower case, brackets kept, trailing dots removed (`LOCALHOST.` is `localhost`). */
const normaliseHost = (host: string): string => host.toLowerCase().replace(/\.+$/, '')

/**
 * Does this URL host name THIS machine (loopback in any spelling, the unspecified address, or the machine's own hostname)?
 * `new URL` already canonicalises numeric IPv4 forms (`127.1`, `2130706433`, `0x7f000001`) and IPv6 forms, so this reads the
 * canonical text: `localhost`/`*.localhost`, 127.0.0.0/8, 0.0.0.0, `[::1]`, `[::]`, `[::ffff:7f..:..]` and the own hostname.
 */
export function isOwnMachineHost(rawHost: string, ownHostname: string = hostname()): boolean {
  const host = normaliseHost(rawHost)
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const own = normaliseHost(ownHostname)
  if (own && host === own) return true
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1)
    if (inner === '::1' || inner === '::') return true
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner)
    if (mapped) { const hi = parseInt(mapped[1]!, 16); return hi >> 8 === 127 || (hi === 0 && parseInt(mapped[2]!, 16) === 0) }
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(inner)
    return dotted ? isOwnMachineHost(dotted[1]!, '') : false
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!v4) return false
  return Number(v4[1]) === 127 || host === '0.0.0.0'
}

/**
 * RUN.CLI-SERVIDOR-REAL: why a call the agentop CLI is about to make must NOT go out from inside a run, else null.
 * SCOPE: this guards the agentop CLI process only (its `fetch` and `WebSocket`). The REAL block for every other process is the
 * run's own network namespace (`run-netns.ts`); this guard remains as the fallback where namespaces are unavailable (`--no-netns`).
 * The real server sits on 47291/47292 and a CLI verb that fell back to it listed real sessions and could write to the real
 * store; a run with no `--serve` has no server of its own, so its own ports are refused with a sentence rather than left to fail.
 * Every loopback spelling counts (see `isOwnMachineHost`) over http, https, ws and wss.
 */
export function throwawayFetchRefusal(env: Record<string, string | undefined>, input: string, ownHostname: string = hostname()): string | null {
  if (!env.AGENTISTICS_THROWAWAY) return null
  let url: URL
  try { url = new URL(input) } catch { return null }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null
  if (!isOwnMachineHost(url.hostname, ownHostname)) return null
  const port = Number(url.port)
  if (isRealAgentopPort(port)) return `inside an agentop run: refusing to reach the real agentop server on :${port}`
  const own = [env.AGENTISTICS_THROWAWAY_API_PORT, env.AGENTISTICS_THROWAWAY_WEB_PORT].map(Number)
  if (own.includes(port) && env.AGENTISTICS_THROWAWAY_SERVE !== '1') return 'inside an agentop run without --serve: no server to talk to'
  return null
}

/** Installs the guard above in front of this process's `fetch` and `WebSocket`; a no-op outside a run. It guards the agentop CLI only. */
export function installThrowawayFetchGuard(env: Record<string, string | undefined> = process.env): void {
  if (!env.AGENTISTICS_THROWAWAY) return
  const real = globalThis.fetch
  const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const refusal = throwawayFetchRefusal(env, target)
    if (refusal) { console.error(refusal); return Promise.reject(new Error(refusal)) }
    return real(input, init)
  }) as typeof fetch
  globalThis.fetch = Object.assign(guarded, real)
  const RealWebSocket = globalThis.WebSocket
  if (RealWebSocket) {
    globalThis.WebSocket = new Proxy(RealWebSocket, {
      construct(target, args, newTarget) {
        const refusal = throwawayFetchRefusal(env, String(args[0]))
        if (refusal) { console.error(refusal); throw new Error(refusal) }
        return Reflect.construct(target, args, newTarget)
      },
    })
  }
}

/** Names `buildThrowawayEnv` always sets itself: keeping one would be printed and then overwritten. */
const THROWAWAY_OVERWRITTEN = /^(HOME|USERPROFILE|PORT|WEB_PORT|SERVE_STATIC|TMPDIR|TMUX_TMPDIR|XDG_.+|AGENTISTICS_DIR|AGENTISTICS_EXPERIMENTAL|AGENTISTICS_SERVER_FOREGROUND|AGENTISTICS_THROWAWAY(_.*)?)$/i
/** Names that move or point at the store, a config or a home (agentistics' own `*_DIR/_HOME/_PATH/_FILE`, and the drop list's harness homes). */
const THROWAWAY_MOVES_STORE = (name: string): boolean =>
  /^AGENTISTICS_(DIR|HOME)$/i.test(name) || /^AGENTISTICS_.*(_DIR|_HOME|_PATH|_FILE)$/i.test(name) || (THROWAWAY_ENV_DROP.includes(name) && !isGitLeak(name)) || /^KIMI_.*HOME$/.test(name)

/**
 * `--keep-env NAME` may re-allow a behaviour switch or a leaked git variable, never a variable that moves the run's store or
 * config, nor one the run overwrites. Returns the sentence that says why not, or null when the name may be kept.
 */
export function throwawayKeepRefusal(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return '--keep-env needs a variable name such as AGENTISTICS_FLOWS'
  if (THROWAWAY_OVERWRITTEN.test(name)) return `${name} cannot be kept: the run sets it itself, so keeping it would change nothing`
  if (THROWAWAY_MOVES_STORE(name)) return `${name} cannot be kept: it moves the run's store or config, and those stay isolated`
  if (!isThrowawaySwitch(name) && !isGitLeak(name)) return `${name} cannot be kept: it is not a variable the run drops`
  return null
}
export const throwawayKeepable = (name: string): boolean => throwawayKeepRefusal(name) === null

/** The names of `keep` that really reach the child with the parent's own value; what `run` prints is derived from the env it built, never from the request. */
export function keptEnvOf(env: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, keep: readonly string[]): string[] {
  return keep.filter(k => throwawayKeepable(k) && source[k] !== undefined && env[k] === source[k])
}

export function buildThrowawayEnv(home: string, name: string, apiPort: number, webPort: number, source: NodeJS.ProcessEnv = process.env, opts: { tmp?: string; heavyHeld?: boolean; keep?: readonly string[]; serve?: boolean } = {}): NodeJS.ProcessEnv {
  const tmp = opts.tmp ?? UNSET_RUN_TMP
  // Volta shims locate their toolchains relative to HOME unless VOLTA_HOME is set.
  // Capture the original installation before isolating HOME, or a shim may resolve itself.
  const voltaHome = source.VOLTA_HOME || join(source.HOME || source.USERPROFILE || homedir(), '.volta')
  const inherited = Object.fromEntries(Object.entries(source).filter(([k]) => (!isThrowawayEnvDrop(k) || (opts.keep?.includes(k) && throwawayKeepable(k)) === true) && !/^XDG_(CONFIG|DATA|STATE|CACHE)_HOME$/.test(k)))
  return {
    // QA 2.225.0 R1: an explicit 0, so a copied store whose preferences say experimental/away cannot
    // switch the destructive flows back on at boot (applyExperimentalFromDisk honours an explicit value).
    // `--keep-env AGENTISTICS_FLOWS` (in `inherited`) still wins on purpose.
    AGENTISTICS_FLOWS: '0',
    ...inherited,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
    // a PRIVATE bun cache: the shared one is the source of hardlinks into every worktree's node_modules (RUN.ISOLAMENTO-PERSISTENCIA r2)
    BUN_INSTALL_CACHE_DIR: join(home, '.cache', 'bun-install'),
    ...(source.VOLTA_HOME || existsSync(voltaHome) ? { VOLTA_HOME: voltaHome } : {}),
    HOME: home, USERPROFILE: home, AGENTISTICS_DIR: join(home, '.agentistics'),
    PORT: String(apiPort), WEB_PORT: String(webPort), SERVE_STATIC: '1',
    AGENTISTICS_SERVER_FOREGROUND: '1', AGENTISTICS_EXPERIMENTAL: '0',
    TMUX_TMPDIR: tmp, TMPDIR: tmp, AGENTISTICS_THROWAWAY: name,
    // RUN.CLI-SERVIDOR-REAL: the CLI inside the run reads these (see `throwawayFetchRefusal`).
    AGENTISTICS_THROWAWAY_SERVE: opts.serve ? '1' : '0', AGENTISTICS_THROWAWAY_API_PORT: String(apiPort), AGENTISTICS_THROWAWAY_WEB_PORT: String(webPort),
    // The run already holds (or inherits) the machine heavy lock: children must not take it again
    // (`insideHeavyLock` reads this, so a nested `agentop heavy`/`agentop run` does not deadlock).
    ...(opts.heavyHeld ? { AGENTISTICS_HEAVY_JOB: '1' } : {}),
  }
}

export function readState(name: string): ThrowawayState | null {
  try { return JSON.parse(readFileSync(statePath(name), 'utf8')) as ThrowawayState } catch { return null }
}

function usage(): string {
  return `Usage: agentop run --rm [--ttl 2h] [--port-offset N] [--name x] [--keep-env NAME]... [--no-netns] -- <command...>
       agentop run --rm [--ttl 2h] [--port-offset N] [--name x]
       agentop run --rm --serve [--seed-from <staging> | --seed-real] [--cwd <worktree>] [--ttl 2h] [--name x] [-- <server command...>]
       --serve with no command runs the installed agentop; use --cwd with an explicit checkout command to serve that checkout.
       Env: AGENTISTICS_*/AGENTOP_* switches (and leaked GIT_* vars) are dropped; --keep-env NAME re-allows one (never a store/config path).
       Network: a run gets its own user/net/mount/pid namespaces (own loopback; internet via slirp4netns). New connections to every private /
       link-local / reserved range (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 198.18/15, 240/4, fc00::/7, fe80::/10, ...), to every
       address of this host and to its gateways are rejected whatever the port, so the real server (:47291/:47292) is not reachable directly,
       through a local proxy, or through an address created after the run started (a public one is ruled within ~1 s by the launcher).
       Hidden inside: all of /run (the Docker/containerd/podman/system-bus sockets, the WSL interop channel, the user runtime dir with
       D-Bus / systemd --user / cc-socks / gpg: a socket recreated later cannot come back), the Windows directories of /mnt/<drive>, the
       real server's unix sockets and tmux dir, /tmp/ssh-* /.X11-unix, ~/.gnupg and ~/.ssh/agent; WSL .exe programs cannot be started;
       the real data dir (~/.agentistics) is read-only; its pid is not visible.
       Persistence: the REAL home is read-only inside the run (writing ~/.claude/skills, ~/.local/bin, ~/.config/systemd/user, ~/.bashrc,
       ~/.ssh, ~/.gitconfig by absolute path fails with EROFS; the run's own HOME is a throwaway). Writable carve-outs, and why: the run's
       own home and tmp (scratch), the git worktree you run from (or --cwd) with its common git dir (so git commit works; its hooks/ and
       config stay read-only). bun's hardlinks: bun fills node_modules by HARDLINK from ~/.bun/install/cache, so one inode is named in the
       shared cache and in other worktrees; therefore the shared cache is read-only, every node_modules under the worktree is read-only, and
       BUN_INSTALL_CACHE_DIR points at a private cache in the run home. To install inside, do it in a fresh directory (a copy in the run
       home or /tmp) with \`bun install --backend=copyfile\`; \`bun install\` over the read-only node_modules finds it up to date or fails.
       Remaining surface: any OTHER writable file with several hard links (nlink>1) is shared with its other names (not scanned at launch).
       Anything else outside the home (/tmp/<name>) is unchanged.
       Not covered: another machine that proxies to the real server, a root-owned process outside the run, a socket created later in a NEW
       directory under /tmp, files outside the home and inside the carve-outs above (the worktree's own files, e.g. .husky, package.json
       scripts, .claude/settings*.json hooks, and the husky "prepare" step, which prints a harmless "could not write config" because .git/config is
       read-only, run when the owner next uses it), and group-granted access that does not go through a socket (supplementary groups cannot be dropped in an unprivileged namespace). Without a systemd scope the 2G memory
       cap is off (said at launch). --serve ports are forwarded to the host's 127.0.0.1. Where namespaces are unavailable it falls
       back to the CLI-only guard and says so; --no-netns asks for that.
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
  let noNetns = false
  const keepEnv: string[] = []
  let command: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { command = args.slice(i + 1); break }
    if (arg === '--rm') { remove = true; continue }
    if (arg === '--serve') { serve = true; continue }
    if (arg === '--no-netns') { noNetns = true; continue }
    if (arg === '--seed-real') { seedReal = true; continue }
    if (arg === '--seed-from') { seedFrom = args[++i] ?? ''; continue }
    if (arg === '--keep-env') {
      const name = args[++i] ?? ''
      const why = throwawayKeepRefusal(name)
      if (why) throw new Error(why)
      keepEnv.push(name)
      continue
    }
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
  return { name, ttl, portOffset, remove, command, serve, seedFrom, seedReal, cwd, keepEnv, noNetns }
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
    stopSlirp(state.slirpPid)
    rmSync(state.home, { recursive: true, force: true })
    removeRunTmp(state.tmp)
    removeCtlDir(state.ctl)
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
  removeCtlDir(state.ctl)
  stopSlirp(state.slirpPid)
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

/** Identifies an agentistics checkout without trusting the caller's spelling or current directory. */
export function isAgentisticsCheckout(dir: string): boolean {
  try {
    const real = realpathSync(dir)
    const env = gitEnv()
    const result = Bun.spawnSync(['git', '-C', real, 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore', env })
    if (result.exitCode !== 0) return false
    const root = realpathSync(result.stdout.toString().trim())
    return existsSync(join(root, 'packages/server/bin/cli.ts'))
  } catch { return false }
}

/** The explicit warning and summary line for the surprising no-command `--serve` default. */
export function serveBuildNotice(cwd: string | null, command: string[]): { warning: string; summary: string } | null {
  if (command.length || !cwd || !isAgentisticsCheckout(cwd)) return null
  return {
    warning: `agentop run --serve is serving the installed agentop v${CURRENT_VERSION}, not this checkout. To serve the checkout, pass -- bun packages/server/bin/cli.ts server (and build/serve the web with vite from the checkout).`,
    summary: `  servedBuild: installed agentop v${CURRENT_VERSION}`,
  }
}

/** `--serve` is long-lived: it must never sit under (or hold a descriptor of) the machine-wide heavy lock. */
export function serveLockRefusal(env: NodeJS.ProcessEnv, ancestors: string[], fds: number[]): string | null {
  if (insideHeavyLock(env, ancestors)) return 'agentop run --serve was started inside a heavy job; the server would stay tied to its lock. Run it from outside.'
  if (fds.length) return `agentop run --serve inherited the heavy lock (fd ${fds.join(', ')}); the server would hold it. Run it from outside.`
  return null
}

async function startRun(options: RunOptions): Promise<number> {
  const serveBuildNoticeResult = options.serve ? serveBuildNotice(options.cwd, options.command) : null
  if (options.serve) {
    const refusal = serveLockRefusal(process.env, ancestorCmdlines(), heavyLockFds('self'))
    if (refusal) { console.error(refusal); return 4 }
    if (options.seedFrom !== null && !seedSourceOk(options.seedFrom)) { console.error('--seed-from must be a staged seed under <dataDir>/flows/ambientes/<id>/semente/'); return 2 }
    if (options.cwd !== null && !serveCwdOk(options.cwd)) { console.error('--cwd must be a linked git worktree'); return 2 }
    if (serveBuildNoticeResult) console.error(serveBuildNoticeResult.warning)
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
  const netns = probeNetns(options.noNetns)
  const notice = netnsNotice(netns)
  if (notice) console.error(notice)
  const tmp = createRunTmp()
  state.tmp = tmp
  // N4: the slirp API socket (add_hostfwd on 0.0.0.0, ...) lives where the run cannot see it: inside the runtime dir the run replaces with an empty tmpfs.
  const ctl = netns.mode === 'netns' ? createCtlDir(process.getuid!()) : null
  if (ctl) state.ctl = ctl.dir
  let child: ReturnType<typeof spawn>
  let systemd = false
  let memoryCapOff: string | null = null
  let keptEnv: string[] = []
  const unit = `agentistics-throwaway-${options.name}.scope`
  try {
    const env = buildThrowawayEnv(home, options.name, apiPort, webPort, process.env, { tmp, heavyHeld: inside || heavyPrefix.length > 0, keep: options.keepEnv, serve: options.serve })
    keptEnv = keptEnvOf(env, process.env, options.keepEnv)
    const scope = process.platform === 'linux' && !!process.env.XDG_RUNTIME_DIR ? await systemdScopeWorks() : 'absent'
    systemd = scope === 'ok'
    const scopeLine = scopeNotice(scope)
    if (scopeLine) { console.error(scopeLine); memoryCapOff = scopeLine }
    const runCwds = [process.cwd(), ...(options.cwd ? [serveCwdOk(options.cwd) ?? options.cwd] : [])]
    const guards = netns.mode === 'netns' ? persistenceGuard(home, runCwds) : []
    const hard = netns.mode === 'netns' ? netnsHardening(realDataDir(), process.getuid!(), undefined, undefined, ctl && !ctl.covered ? [ctl.dir] : [], undefined, guards) : null
    if (hard) hard.hardening.readOnly = [...new Set([...(hard.hardening.readOnly ?? []), ...outsideNodeModules(runCwds, guards)])]
    const runArgv = hard ? netnsArgv(argv, process.getuid!(), process.getgid!(), blockedPorts(), hostAddresses(), hard.hide, hard.hardening) : argv
    const childArgs = systemd ? ['--user', '--scope', '--unit', unit.replace(/\.scope$/, ''), '-p', 'MemoryMax=2G', '-p', `RuntimeMaxSec=${parseTtl(options.ttl)}`, '--', ...runArgv] : runArgv
    child = spawn(systemd ? 'systemd-run' : runArgv[0]!, systemd ? childArgs : runArgv.slice(1), { env, stdio: 'inherit', detached: !systemd, ...(options.cwd ? { cwd: serveCwdOk(options.cwd)! } : {}) })
    state.pid = child.pid
    if (systemd) state.unit = unit
    writeFileSync(statePath(options.name), JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch (error) {
    removeRunTmp(tmp)
    removeCtlDir(ctl?.dir)
    throw error
  }
  console.log(`throwaway ${options.name}`)
  console.log(`  api:  http://localhost:${apiPort}`)
  console.log(`  web:  http://localhost:${webPort}`)
  console.log(`  home: ${home}`)
  console.log(`  stop: agentop run stop ${options.name}`)
  if (memoryCapOff) console.log(`  memory cap: OFF (no systemd scope; the ${options.ttl} TTL timer still applies)`)
  if (serveBuildNoticeResult) console.log(serveBuildNoticeResult.summary)
  if (keptEnv.length) console.log(`  kept env: ${keptEnv.join(', ')}`)

  // Started WITHOUT awaiting: a command that dies at once must still reach `childExit` below; cleanup waits for this task so no slirp is orphaned.
  const slirpTask: Promise<void> = netns.mode !== 'netns' ? Promise.resolve() : (async () => {
    const slirp = await startSlirp(child.pid!, join(ctl!.dir, 'slirp.sock'), () => child.exitCode === null && child.signalCode === null)
    if ('error' in slirp) { if (child.exitCode === null && child.signalCode === null) console.error(`agentop run: the run has its own loopback but no outside network (${slirp.error})`) }
    else {
      state.slirpPid = slirp.pid
      // N3: a host address created after launch (outside every blocked range) gets its reject rules within one poll.
      const known = new Set(hostAddresses())
      const watch = setInterval(() => { if (child.exitCode !== null || child.signalCode !== null) return clearInterval(watch); pollHostAddresses(child.pid!, known) }, 1000)
      watch.unref?.()
      child.once('exit', () => clearInterval(watch))
      writeFileSync(statePath(options.name), JSON.stringify(state, null, 2), { mode: 0o600 })
      if (options.serve) {
        const failed = await forwardPorts(slirp.socket, [apiPort, webPort])
        if (failed.length) console.error(`agentop run: could not forward port(s) ${failed.join(', ')} to the host; the served URL is reachable only from inside the run`)
      }
    }
  })().catch(error => { console.error(`agentop run: network setup failed (${error instanceof Error ? error.message : String(error)})`) })
  // One shared promise: a signal handler and the normal exit path both call this, and the second
  // caller must wait for the first one's removal instead of exiting the process under it.
  // The command sits behind `unshare --fork` (it ignores SIGTERM), so a signal goes to EVERYTHING in the run: the whole scope (systemd) or the whole process group.
  const signalRun = (sig: NodeJS.Signals) => {
    if (systemd) spawnSync('systemctl', ['--user', 'kill', '--signal', sig, unit], { stdio: 'ignore', timeout: 5000 })
    try { process.kill(systemd ? child.pid! : -child.pid!, sig) } catch { try { process.kill(child.pid!, sig) } catch {} }
  }
  let cleaning: Promise<void> | undefined
  const cleanup = () => (cleaning ??= slirpTask.then(() => stopState(state)))
  // The command's end is recorded in the log BEFORE any cleanup line, so whoever reads run.log (the ambiente flow) can name the exit code.
  const childExit = new Promise<number>(resolve => {
    child.once('exit', (status, sig) => { console.log(status !== null ? `exit ${status}` : `exit signal ${sig}`); resolve(status ?? (sig ? 1 : 0)) })
    child.once('error', () => { console.log('exit 1'); resolve(1) })
  })
  const signal = async (sig: NodeJS.Signals) => { signalRun(sig); await childExit; await cleanup(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)) }
  process.once('SIGINT', () => void signal('SIGINT'))
  process.once('SIGTERM', () => void signal('SIGTERM'))
  // The run is tied to whoever started it. A session's pane hangs up its process group when the
  // session is killed — the default SIGHUP action ended this launcher WITHOUT its cleanup, and the
  // run's systemd scope (a cgroup of its own) kept the command alive until its TTL (03/11: run-r*
  // scopes still active after their session ended). A parent that died outright reparents us: same.
  process.once('SIGHUP', () => void signal('SIGTERM'))
  const parentWatch = watchParent(process.ppid, () => process.ppid, () => void signal('SIGTERM'))
  const ttlTimer = setTimeout(() => signalRun('SIGTERM'), parseTtl(options.ttl) * 1000)
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

/** N5: the one line said when the memory cap could not be applied; null when there is nothing to say (scope ok, or no systemd at all). */
export function scopeNotice(scope: 'ok' | 'absent' | 'failed'): string | null {
  return scope === 'failed' ? 'agentop run: the systemd scope could not be created (probe failed or timed out): the 2G memory cap is OFF for this run; only the TTL timer bounds it.' : null
}

/** A scope can only be created when the user bus answers: inside a pid namespace (a nested run) systemd-run is installed but the bus refuses the peer. */
async function systemdScopeWorks(): Promise<'ok' | 'absent' | 'failed'> {
  if (!await commandExists('systemd-run')) return 'absent'
  const probe = spawn('systemd-run', ['--user', '--scope', '--quiet', '--', 'true'], { stdio: 'ignore' })
  // Bounded: with no reachable user manager (a run inside a run, whose runtime dir is an empty tmpfs) systemd-run can sit waiting for a bus.
  const timer = setTimeout(() => { try { probe.kill('SIGKILL') } catch {} }, 4000)
  return await new Promise(resolve => { probe.once('exit', code => { clearTimeout(timer); resolve(code === 0 ? 'ok' : 'failed') }); probe.once('error', () => { clearTimeout(timer); resolve('failed') }) })
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
