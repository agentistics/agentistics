/**
 * browser-spec.ts — PURE: everything about the browsers agentistics runs that can be decided without
 * touching the machine. The Chromium argv, the URL block rules, the ceilings, the thresholds, the
 * profile folder names, the memory and idle verdicts and the orphan-sweep plan.
 *
 * NAVEGADOR S1 (spec `leader/navegador/SPEC.md` §1.3–§1.4, revised after the S0 probes):
 *
 * - **The pipe, not a port.** `--remote-debugging-pipe` puts CDP on fds 3/4 of the child, so there is
 *   no TCP listener a page (or another user) could reach. The spawn that carries those fds is
 *   `node:child_process.spawn` — `Bun.spawn` accepts five stdio entries and then hands back bare fd
 *   NUMBERS with no stream (probe P1), which is unusable. Works in the compiled binary (P1).
 * - **`--headless` for the headless shell, `--headless=new` only for full Chrome.** The shell refuses
 *   the new flag (P1).
 * - **Memory is PSS, not RSS.** RSS counts every shared page once per process: four heavy tabs read
 *   1045 MB RSS against 475 MB PSS (P2). The thresholds below are PSS; where `smaps_rollup` cannot be
 *   read the watcher falls back to RSS with thresholds scaled by `RSS_FALLBACK_FACTOR` and SAYS so.
 * - **`MemoryMax` only bites with `MemorySwapMax=0`** — without it the 8 GB WSL swap absorbed a 1.9 GB
 *   hog under a 200 MB cap (P6).
 * - **Never `--remote-allow-origins`.** And `--no-sandbox` only when asked for, with `status` saying so.
 *
 * Nothing in here reads a file, a clock or the environment: every input is a parameter, so every rule
 * is a test.
 */

// ---------------------------------------------------------------------------------------------------
// Owners

/** Whose browser it is: one managed session (A1) or the person (B1, one per server). */
export type BrowserOwner = { kind: 'session'; managedId: string } | { kind: 'personal' }

/** The one string an owner is keyed by — in the host's map, in `pids.json`, in the profile folder. */
export function ownerKey(owner: BrowserOwner): string {
  return owner.kind === 'personal' ? 'personal' : `s-${owner.managedId}`
}

/** A managed id is used as a folder name, so it is held to the shape agentop mints and nothing else:
 *  a traversal (`../x`) or a separator would let a caller choose where a profile is created and,
 *  worse, what the sweep deletes. */
export function validManagedId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
}

/** Parse a key back into an owner; `null` for anything that is not one we mint. */
export function ownerFromKey(key: string): BrowserOwner | null {
  if (key === 'personal') return { kind: 'personal' }
  if (key.startsWith('s-') && validManagedId(key.slice(2))) return { kind: 'session', managedId: key.slice(2) }
  return null
}

// ---------------------------------------------------------------------------------------------------
// Ceilings and thresholds (spec §1.4, numbers measured in P2)

export const MAX_LIVE_BROWSERS = 3
export const MAX_SESSION_BROWSERS = 2
export const MAX_PERSONAL_BROWSERS = 1
export const MAX_TABS_SESSION = 4
export const MAX_TABS_PERSONAL = 8
/** Admission refuses a new Chromium below this much `MemAvailable`. */
export const MIN_AVAILABLE_BYTES = 1.5 * 1024 ** 3
/** A session browser nobody watches and idle longer than this may be closed to make room (LRU). */
export const EVICT_IDLE_MS = 2 * 60_000
/** Idle shutdown: session browser after 10 min without an action AND without a viewer; personal 20. */
export const IDLE_SESSION_MS = 10 * 60_000
export const IDLE_PERSONAL_MS = 20 * 60_000
export const WATCH_INTERVAL_MS = 10_000
/** PSS per browser: above TRIM the oldest inactive tab is closed; above KILL the browser is stopped. */
export const PSS_TRIM_BYTES = 900 * 1024 ** 2
export const PSS_KILL_BYTES = 1200 * 1024 ** 2
/** When only RSS can be read, the same verdicts at ×1.6 (P2: RSS ≈ 2.2× PSS on heavy pages; 1.6 keeps
 *  the fallback on the SAFE side of that ratio while not firing on four idle tabs). */
export const RSS_FALLBACK_FACTOR = 1.6
/** SIGTERM, then SIGKILL after this — always by the saved PID. */
export const KILL_GRACE_MS = 3_000
/** How long a spawn may take to answer `Browser.getVersion` before it is counted as failed. */
export const START_TIMEOUT_MS = 15_000
/** The second memory layer, `systemd-run --user --scope` (P6). */
export const SCOPE_MEMORY_MAX = '1200M'

// ---------------------------------------------------------------------------------------------------
// Executable kinds and argv

export type BrowserKind = 'headless-shell' | 'chromium' | 'chrome'

export interface ArgvInput {
  kind: BrowserKind
  profileDir: string
  /** Only when the sandbox demonstrably cannot start; `status` reports it. */
  noSandbox?: boolean
  width?: number
  height?: number
}

/** Flags every browser we start carries. Order is stable so the argv is a snapshot test. */
export function browserArgv(input: ArgvInput): string[] {
  const w = input.width ?? 1280
  const h = input.height ?? 800
  const argv = [
    input.kind === 'headless-shell' ? '--headless' : '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${input.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    `--window-size=${w},${h}`,
    '--js-flags=--max-old-space-size=384',
    '--renderer-process-limit=4',
  ]
  if (input.noSandbox) argv.push('--no-sandbox')
  argv.push('about:blank')
  return argv
}

/** Flags that must never appear — asserted by the tests against every argv this module builds. */
export const FORBIDDEN_FLAGS = ['--remote-allow-origins', '--remote-debugging-port', '--remote-debugging-address'] as const

/** Wrap a command in a transient systemd user scope with a hard memory ceiling (P6). The scope runs the
 *  command in place (same PID), so the saved PID stays the browser's. */
export function scopeWrap(bin: string, argv: string[], unitName: string): { bin: string; argv: string[] } {
  return {
    bin: 'systemd-run',
    argv: [
      '--user', '--scope', '--quiet', '--collect',
      `--unit=${unitName}`,
      '-p', `MemoryMax=${SCOPE_MEMORY_MAX}`,
      '-p', 'MemorySwapMax=0',
      '--', bin, ...argv,
    ],
  }
}

/** A systemd unit name for an owner, unique per spawn (systemd refuses a duplicate live unit). */
export function scopeUnitName(key: string, nonce: string): string {
  return `agentop-browser-${key.replace(/[^A-Za-z0-9_-]/g, '_')}-${nonce.replace(/[^A-Za-z0-9]/g, '')}`
}

// ---------------------------------------------------------------------------------------------------
// Profile folders

/** `<root>/sessions/<managedId>` or `<root>/personal`. `root` is `<data dir>/browser`. */
export function profileDirFor(root: string, owner: BrowserOwner): string {
  const r = root.replace(/\/+$/, '')
  if (owner.kind === 'personal') return `${r}/personal`
  if (!validManagedId(owner.managedId)) throw new Error('invalid managed id')
  return `${r}/sessions/${owner.managedId}`
}

/** Does `dir` sit exactly where `profileDirFor` would put a profile under `root`? The sweep deletes ONLY
 *  such folders — never something a symlink or a typo put elsewhere. */
export function isProfileDir(root: string, dir: string): boolean {
  const r = root.replace(/\/+$/, '')
  if (dir === `${r}/personal`) return true
  const prefix = `${r}/sessions/`
  return dir.startsWith(prefix) && validManagedId(dir.slice(prefix.length))
}

// ---------------------------------------------------------------------------------------------------
// URL block rules (spec §4) — enforced through Fetch interception from S2; the rule lives here.

export const BLOCKED_SCHEMES = ['file:', 'chrome:', 'chrome-extension:', 'devtools:', 'view-source:', 'chrome-untrusted:'] as const

export type BlockReason = 'scheme' | 'agentistics-port' | 'debug-port' | 'invalid'

export interface BlockContext {
  /** The ports agentistics itself serves on (the REAL `PORT`/`WEB_PORT`, not only the defaults). */
  agentisticsPorts: readonly number[]
  /** Debugging ports of our other browsers (port mode only; empty in pipe mode). */
  debugPorts?: readonly number[]
  /** This machine's own interface addresses (a LAN IP reaches a server bound to 0.0.0.0 exactly as
   *  127.0.0.1 does). Lowercased, no brackets. */
  selfAddresses?: readonly string[]
}

/** Is `host` a bare IP literal (v4 dotted, single-number, hex, or v6)? Such a host is never resolved. */
export function isIpLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h.includes(':') || /^\d+(\.\d+){0,3}$/.test(h) || /^0x[0-9a-f]+$/.test(h)
}

/** Expand an IPv6 literal (no brackets; dotted tail allowed) to its 8 groups, or `null` when it is not one. */
function ipv6Groups(h: string): number[] | null {
  if (!h.includes(':')) return null
  let s = h
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number)
    if (o.some(n => n > 255)) return null
    s = s.slice(0, dotted.index) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (x: string) => (x === '' ? [] : x.split(':'))
  const head = part(halves[0]!)
  const tail = halves.length === 2 ? part(halves[1]!) : []
  if (halves.length === 1 && head.length !== 8) return null
  if (halves.length === 2 && head.length + tail.length > 7) return null
  const all = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head
  const out = all.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return out.some(Number.isNaN) ? null : out
}

/**
 * The IPv4 address an IPv6 literal CARRIES, or `null`: IPv4-mapped (`::ffff:a.b.c.d` / `::ffff:XXXX:XXXX`),
 * IPv4-compatible (`::a.b.c.d`), SIIT (`::ffff:0:a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002:XXXX:XXXX::`).
 * The URL parser rewrites every spelling to hex groups, so a rule that matches only the dotted form misses
 * them all: `[::ffff:ac17:ffa5]` IS 172.23.255.165 and `[::ffff:0:0]` IS 0.0.0.0, and both reach this machine.
 */
export function embeddedIpv4(hostname: string): string | null {
  const g = ipv6Groups(hostname.toLowerCase().replace(/^\[|\]$/g, ''))
  if (!g) return null
  const v4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
  const zeros = (from: number, to: number) => g.slice(from, to).every(x => x === 0)
  if (zeros(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!) // mapped
  if (zeros(0, 6) && (g[6]! !== 0 || g[7]! > 1)) return v4(g[6]!, g[7]!) // compatible (::1 and :: are not)
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!) // SIIT
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(g[6]!, g[7]!) // NAT64
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!) // 6to4
  return null
}

function hostIsThisMachine(hostname: string, ctx: BlockContext): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const self = ctx.selfAddresses ?? []
  if (isLoopbackHost(h) || self.includes(h)) return true
  const v4 = embeddedIpv4(h)
  return v4 !== null && (isLoopbackHost(v4) || self.includes(v4))
}

function portOf(u: URL): number | undefined {
  return u.port ? Number(u.port) : DEFAULT_PORT[u.protocol.toLowerCase()]
}

function guardedPortReason(port: number | undefined, ctx: BlockContext): BlockReason | null {
  if (port === undefined) return null
  if (ctx.agentisticsPorts.includes(port)) return 'agentistics-port'
  if ((ctx.debugPorts ?? []).includes(port)) return 'debug-port'
  return null
}

/**
 * A NAME (not an IP literal, not loopback) on a guarded port must be RESOLVED before it may load:
 * `localtest.me` / `127.0.0.1.nip.io` resolve to 127.0.0.1 and would otherwise walk past the hostname
 * rule. Only guarded ports pay a lookup — every other URL is decided by `urlBlockReason` alone.
 */
export function needsResolve(raw: string, ctx: BlockContext): boolean {
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (!u.hostname || isIpLiteral(u.hostname) || hostIsThisMachine(u.hostname, ctx)) return false
  return guardedPortReason(portOf(u), ctx) !== null
}

/** After resolving `needsResolve`'s name: block when ANY address is this machine. */
export function resolvedBlockReason(raw: string, addresses: readonly string[], ctx: BlockContext): BlockReason | null {
  let u: URL
  try { u = new URL(raw) } catch { return 'invalid' }
  if (!addresses.some(a => hostIsThisMachine(a, ctx))) return null
  return guardedPortReason(portOf(u), ctx)
}

/** True for any name that resolves to this machine without DNS. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::' || h === '0.0.0.0' || h === '0') return true
  const v4 = embeddedIpv4(h)
  if (v4 !== null) return isLoopbackHost(v4)
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  // Decimal / hex single-number forms of 127/8 (`2130706433`, `0x7f000001`) — browsers accept them.
  if (/^\d+$/.test(h)) { const n = Number(h); return n >= 0x7f000000 && n <= 0x7fffffff }
  if (/^0x[0-9a-f]+$/.test(h)) { const n = parseInt(h, 16); return n >= 0x7f000000 && n <= 0x7fffffff }
  return false
}

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 }

/** Why a URL may not be loaded, or `null` when it may. `localhost:<any other port>` is ALLOWED: testing
 *  the person's own dev server is the main use case. */
export function urlBlockReason(raw: string, ctx: BlockContext): BlockReason | null {
  let u: URL
  try { u = new URL(raw) } catch { return 'invalid' }
  const scheme = u.protocol.toLowerCase()
  if ((BLOCKED_SCHEMES as readonly string[]).includes(scheme)) return 'scheme'
  if (!hostIsThisMachine(u.hostname, ctx)) return null
  return guardedPortReason(portOf(u), ctx)
}

// ---------------------------------------------------------------------------------------------------
// What `status` may say about a page (S1 QA reservation c)

/**
 * A tab URL as `status` reports it: `protocol//host/path` (no credentials, query or fragment — a URL can
 * carry a token), a `data:` URL reduced to its media type (a data URL can be megabytes and IS content),
 * `blob:` to its origin, any other scheme to the scheme alone. Capped at 300.
 */
export function statusUrl(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return ''
  const lower = raw.slice(0, 16).toLowerCase()
  if (lower.startsWith('data:')) {
    const mime = /^data:([a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60})/i.exec(raw)?.[1]
    return mime ? `data:${mime.toLowerCase()}` : 'data:'
  }
  if (lower === 'about:blank' || lower.startsWith('about:blank')) return 'about:blank'
  let u: URL
  try { u = new URL(raw) } catch { return '' }
  if (u.protocol === 'blob:') {
    try { return `blob:${new URL(u.pathname).origin}` } catch { return 'blob:' }
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300)
  return u.protocol
}

/** A page title as `status` reports it: control and bidi-override characters removed, whitespace
 *  collapsed, capped at 120 (a page chooses its own title; it must not be able to forge lines or
 *  reorder what is drawn around it). */
export function statusTitle(raw: string): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean
}

/**
 * An action label as `status` / the stream report it (S10 r3 F2b): `navigate`/`back`/`forward`/`reload` record
 * the page URL as their label, and a URL can carry a token (`?token=…`, `#access_token=…`). Every http(s) URL
 * inside the label is reduced to `protocol//host/path` (`statusUrl`) and the rest is cleaned like a title.
 */
export function statusLabel(raw: string): string {
  if (typeof raw !== 'string') return ''
  return statusTitle(raw.replace(/https?:\/\/[^\s"'<>]+/gi, (u) => statusUrl(u) || ''))
}

// ---------------------------------------------------------------------------------------------------
// Idle verdict

export interface IdleInput {
  owner: BrowserOwner
  viewers: number
  /** Last model action, person interaction, or the moment the last viewer left — whichever is latest. */
  lastActivityMs: number
  now: number
}

/** Should this browser be shut down for idleness? Never while somebody watches. */
export function idleExpired(i: IdleInput): boolean {
  if (i.viewers > 0) return false
  const limit = i.owner.kind === 'personal' ? IDLE_PERSONAL_MS : IDLE_SESSION_MS
  return i.now - i.lastActivityMs >= limit
}

// ---------------------------------------------------------------------------------------------------
// Memory verdict

export interface MemoryReading {
  /** PSS of the whole process tree in bytes, or `null` when `smaps_rollup` could not be read. */
  pss: number | null
  /** RSS of the tree in bytes (always readable on Linux for our own processes). */
  rss: number | null
}

export type MemoryVerdict = { action: 'ok' | 'trim' | 'kill'; basis: 'pss' | 'rss' | 'none'; bytes: number | null }

export function memoryVerdict(r: MemoryReading): MemoryVerdict {
  if (r.pss !== null) {
    const action = r.pss >= PSS_KILL_BYTES ? 'kill' : r.pss >= PSS_TRIM_BYTES ? 'trim' : 'ok'
    return { action, basis: 'pss', bytes: r.pss }
  }
  if (r.rss !== null) {
    const action = r.rss >= PSS_KILL_BYTES * RSS_FALLBACK_FACTOR ? 'kill'
      : r.rss >= PSS_TRIM_BYTES * RSS_FALLBACK_FACTOR ? 'trim' : 'ok'
    return { action, basis: 'rss', bytes: r.rss }
  }
  return { action: 'ok', basis: 'none', bytes: null }
}

/** A page target the PAGE itself created (`window.open`, a link with target=_blank) is not asked for by
 *  `tab_new`, so the ceiling is enforced where it appears: a NEW page target when the owner is already at
 *  its ceiling is closed. A target already counted (an info update) never is. */
export function mustCloseNewTarget(alreadyKnown: boolean, tabCount: number, maxTabs: number): boolean {
  return !alreadyKnown && tabCount >= maxTabs
}

export interface TabAge { targetId: string; lastActiveMs: number }

/** The tab a `trim` closes: the least recently active one that is NOT the active tab. `null` when the
 *  active tab is the only one — trimming never closes what somebody is looking at. */
export function tabToTrim(tabs: readonly TabAge[], activeTargetId: string | null): string | null {
  const candidates = tabs.filter(t => t.targetId !== activeTargetId)
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => a.lastActiveMs - b.lastActiveMs || a.targetId.localeCompare(b.targetId))[0]!.targetId
}

// ---------------------------------------------------------------------------------------------------
// Process tree arithmetic (pure over /proc text)

/** ppid from the text of `/proc/<pid>/stat` (the comm field may contain spaces and parentheses). */
export function ppidFromStat(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const rest = stat.slice(close + 2).split(' ')
  const ppid = Number(rest[1])
  return Number.isFinite(ppid) ? ppid : null
}

/** Root plus every descendant, from a pid → ppid map. Cycle-safe. */
export function descendants(root: number, ppidOf: ReadonlyMap<number, number>): number[] {
  const kids = new Map<number, number[]>()
  for (const [pid, ppid] of ppidOf) {
    const list = kids.get(ppid) ?? []
    list.push(pid)
    kids.set(ppid, list)
  }
  const out: number[] = []
  const seen = new Set<number>()
  const stack = [root]
  while (stack.length) {
    const p = stack.pop()!
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
    for (const k of kids.get(p) ?? []) stack.push(k)
  }
  return out
}

/** Field 22 (`starttime`, clock ticks since boot) of `/proc/<pid>/stat` — with the pid, an identity a
 *  recycled pid cannot share. */
export function startTimeFromStat(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const v = Number(stat.slice(close + 2).split(' ')[19])
  return Number.isFinite(v) && v >= 0 ? v : null
}

/** `Pss:` and `Rss:` (bytes) out of `/proc/<pid>/smaps_rollup`. */
export function parseSmapsRollup(text: string): { pss: number | null; rss: number | null } {
  const kb = (k: string) => { const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text); return m ? Number(m[1]) * 1024 : null }
  return { pss: kb('Pss'), rss: kb('Rss') }
}

// ---------------------------------------------------------------------------------------------------
// The PID record (`<data dir>/browser/pids.json`) and the orphan sweep

export interface PidRecord {
  key: string
  pid: number
  profileDir: string
  /** The agentop process that started it — a record of a host that is still alive is not ours to sweep. */
  hostPid: number
  /** The host's own `starttime` (`startTimeFromStat`) when the record was written. With it, a live
   *  process that merely REUSED the host's pid is told apart from the host (S1 QA reservation a). */
  hostStart?: number
  startedAt: number
}

/** For a record written before `hostStart` existed: does this live pid's cmdline look like an agentop
 *  server at all? A `sleep` that recycled the pid does not. */
export function looksLikeAgentopHost(cmdline: string | null): boolean {
  if (!cmdline) return false
  return /(^|[\0 /])(agentop|bun)([\0 ]|$)/.test(cmdline) || /agentistics/.test(cmdline)
}

export interface SweepInput {
  root: string
  records: readonly PidRecord[]
  /** Every entry found under `<root>/sessions/` plus `<root>/personal` when present (absolute paths). */
  dirs: readonly string[]
  selfPid: number
  /** Profile folders THIS host is running a browser in right now — never swept, whatever the records say. */
  ownLiveDirs?: ReadonlySet<string>
  /** Is this pid alive? */
  alive: (pid: number) => boolean
  /** The NUL-joined cmdline of a live pid, or null. Identity check: a recycled pid will not carry our
   *  `--user-data-dir`. */
  cmdline: (pid: number) => string | null
  /** `starttime` of a live pid (`startTimeFromStat`), or null when unreadable. */
  startTime?: (pid: number) => number | null
}

export interface SweepPlan {
  /** Saved PIDs to stop (proved ours by their own cmdline). */
  kill: { pid: number; key: string }[]
  /** Profile folders to delete. */
  removeDirs: string[]
  /** Records to drop from `pids.json`. */
  dropKeys: string[]
  /** Records left alone because another live agentop owns them. */
  keptForOtherHost: string[]
}

/** Is this live process really the browser we recorded? Its argv must name the recorded profile as a
 *  whole argument. Chrome REWRITES its own process title, so its `/proc/<pid>/cmdline` is one
 *  space-joined string rather than NUL-separated argv (measured on google-chrome 146) — the flag is
 *  therefore matched with a NUL or space boundary on both sides, never as a bare substring (which
 *  would let `/sessions/a` match `/sessions/ab`). */
export function cmdlineMatches(cmdline: string | null, profileDir: string): boolean {
  if (!cmdline) return false
  const flag = `--user-data-dir=${profileDir}`
  let i = cmdline.indexOf(flag)
  while (i >= 0) {
    const before = i === 0 ? '\0' : cmdline[i - 1]!
    const after = cmdline[i + flag.length] ?? '\0'
    if ((before === '\0' || before === ' ') && (after === '\0' || after === ' ')) return true
    i = cmdline.indexOf(flag, i + 1)
  }
  return false
}

/**
 * Is the agentop that wrote this record still the one alive at `hostPid`? A live pid is not enough —
 * pids are recycled, and a `sleep` holding the old host's pid used to keep an orphan folder (and, in
 * port mode, a loose Chromium) forever. With `hostStart` the identity is exact (pid + start time);
 * an older record without it needs a cmdline that looks like an agentop host.
 */
export function hostStillOwns(rec: PidRecord, input: Pick<SweepInput, 'selfPid' | 'alive' | 'cmdline' | 'startTime'>): boolean {
  if (rec.hostPid === input.selfPid || !input.alive(rec.hostPid)) return false
  if (rec.hostStart !== undefined) {
    const now = input.startTime?.(rec.hostPid) ?? null
    return now !== null && now === rec.hostStart
  }
  return looksLikeAgentopHost(input.cmdline(rec.hostPid))
}

/** The profile folder a cmdline names (`--user-data-dir=<dir>` as a whole argument, NUL or space
 *  boundary), when that folder is one of OURS under `root`; otherwise null. */
export function profileDirInCmdline(cmdline: string | null, root: string): string | null {
  if (!cmdline) return null
  const re = /(?:^|[\0 ])--user-data-dir=([^\0 ]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmdline))) if (isProfileDir(root, m[1]!)) return m[1]!
  return null
}

/** A process that reaps orphans (what a browser is re-parented to when its host died). */
export function isReaper(pid: number, cmdline: string | null): boolean {
  if (pid === 1) return true
  const argv0 = (cmdline ?? '').split(/[\0 ]/)[0] ?? ''
  const base = argv0.slice(argv0.lastIndexOf('/') + 1)
  return ['systemd', 'init', 'tini', 'dumb-init', 'catatonit', 'docker-init', 'Relay'].includes(base) || argv0 === '/init'
}

export interface UnrecordedProc { pid: number; ppid: number; cmd: string | null }

/**
 * S1 QA reservation b — orphans that `pids.json` does not name (the file was deleted or corrupted):
 * every live MAIN browser process whose own argv names one of our profile folders and whose parent is
 * gone or is a reaper (its host died). A process whose parent also names that folder is a helper of
 * it (renderer, GPU, zygote) and dies with it. Protected folders (this host's live ones, another live
 * host's records) and our own children are never touched. The cmdline IS the identity here: a process
 * that does not carry our `--user-data-dir` is never considered.
 */
export function planUnrecordedOrphans(input: {
  root: string
  procs: readonly UnrecordedProc[]
  selfPid: number
  protectedDirs: ReadonlySet<string>
  /** Pids already planned for a kill by the record path. */
  alreadyKilling?: ReadonlySet<number>
}): { kill: { pid: number; dir: string }[] } {
  const byPid = new Map(input.procs.map(p => [p.pid, p]))
  const kill: { pid: number; dir: string }[] = []
  for (const p of input.procs) {
    const dir = profileDirInCmdline(p.cmd, input.root)
    if (!dir || input.protectedDirs.has(dir) || input.alreadyKilling?.has(p.pid)) continue
    if (p.ppid === input.selfPid) continue
    const parent = byPid.get(p.ppid)
    if (parent && profileDirInCmdline(parent.cmd, input.root) === dir) continue // a helper
    const orphaned = !parent || isReaper(parent.pid, parent.cmd)
    if (orphaned) kill.push({ pid: p.pid, dir })
  }
  return { kill }
}

export function planOrphanSweep(input: SweepInput): SweepPlan {
  const plan: SweepPlan = { kill: [], removeDirs: [], dropKeys: [], keptForOtherHost: [] }
  const protectedDirs = new Set<string>(input.ownLiveDirs ?? [])
  for (const rec of input.records) {
    if (protectedDirs.has(rec.profileDir) && rec.hostPid === input.selfPid) continue
    if (hostStillOwns(rec, input)) {
      plan.keptForOtherHost.push(rec.key)
      protectedDirs.add(rec.profileDir)
      continue
    }
    if (input.alive(rec.pid) && cmdlineMatches(input.cmdline(rec.pid), rec.profileDir)) {
      plan.kill.push({ pid: rec.pid, key: rec.key })
    }
    plan.dropKeys.push(rec.key)
    if (isProfileDir(input.root, rec.profileDir)) plan.removeDirs.push(rec.profileDir)
  }
  for (const d of input.dirs) {
    if (!isProfileDir(input.root, d) || protectedDirs.has(d) || plan.removeDirs.includes(d)) continue
    plan.removeDirs.push(d)
  }
  return plan
}
