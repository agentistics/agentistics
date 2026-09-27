/**
 * host-allow.ts — refuse a `localShell` request whose Host header does not name this machine.
 *
 * ## The attack this closes: DNS rebinding
 *
 * `agentop server` answers on 0.0.0.0 with no authentication on the `local` profile, and the
 * `localShell` routes (`/api/exec`, `/api/fleet/*`, `/api/shell/*`, …) are shell access under
 * other names. The browser's same-origin policy is what normally keeps a random web page away
 * from them — and DNS rebinding defeats exactly that: `evil.example` is served once from the
 * attacker's host, then its DNS record is flipped to 127.0.0.1, and the page's own same-origin
 * `fetch('/api/exec')` now lands HERE. To the browser nothing crossed an origin, so neither CORS
 * nor the CSRF check (which trusts `Sec-Fetch-Site: same-origin`) objects. The ONE thing the
 * attacker cannot change is the name the browser was pointed at, which it sends as `Host:
 * evil.example:47291`. So the check is on the Host: a name this machine does not answer to is
 * refused before any route runs.
 *
 * ## What this does NOT change
 *
 * Who can reach the machine. The bind stays 0.0.0.0 and a LAN peer addressing the machine by its
 * own IP still gets through — that is a separate decision about the bind, not this one. This closes
 * the path where a web page borrows the person's own browser to reach the machine by a name that is
 * not the machine's.
 *
 * ## The allowlist, and why each entry is on it
 *
 * - Loopback: `localhost`, all of 127.0.0.0/8 (the whole block routes to lo, not only .1), `::1`,
 *   and the IPv4-mapped `::ffff:127.x.x.x` in both spellings.
 * - The machine's own hostname and `<hostname>.local` (mDNS), as a person types them.
 * - Every address `os.networkInterfaces()` reports — the LAN IP someone opens from a phone, the
 *   tailnet 100.x, Docker bridges, IPv6 with the zone id stripped. A rebinding page cannot make the
 *   browser send one of THESE as its Host; the attacker's name is always its own.
 * - The origins in AGENTISTICS_ALLOWED_ORIGINS, EXACTLY (host + port, default port by scheme) — the
 *   escape hatch for a name this module cannot discover (a reverse proxy, a split deployment).
 * - The https origin `tailscale serve` proxies to our web port (`secure-origin.ts`). Its name is
 *   also accepted on our own ports, since it provably resolves to this machine on the tailnet.
 * - The machine's MagicDNS name, full (`alien-wsl.seahorse-cobia.ts.net`) and short (`alien-wsl`),
 *   read from `tailscale status --json` → `Self.DNSName`. It is NOT os.hostname(): under WSL the
 *   kernel's hostname is the Windows machine's (`BRAIAODE2`) while the tailnet knows the node by
 *   the name it was registered under, and that is the name a phone on the tailnet types. Like the
 *   hostname, it counts only on our own ports. A rebinding page cannot borrow it: the attacker's
 *   page is served under the attacker's name, and MagicDNS answers these names only inside the
 *   tailnet, to this node.
 *
 * A local NAME must also carry one of the server's OWN ports. A Host with no port means 80/443,
 * which this server never listens on directly — only a proxy in front of it does, and that proxy's
 * origin is what AGENTISTICS_ALLOWED_ORIGINS is for.
 *
 * ## Cost
 *
 * The allowlist is built at startup and refreshed on a timer, NEVER per request: `hostAllowed` is a
 * parse plus a few Set lookups. `os.networkInterfaces()`, `tailscale serve status` and `tailscale
 * status` belong to the refresh, where a failure keeps the previous answer instead of reaching the
 * request path.
 *
 * ## A request with no Host at all
 *
 * Is not this gate's to judge, and never reaches it: `badRequestTarget` answers it 400 on EVERY
 * route, before anything parses the request's URL. Bun builds `req.url` out of the Host, so without
 * one it is a bare path that `new URL()` throws on — which used to surface as a 500 from wherever
 * the first parse happened to be.
 */
import { hostname as osHostname, networkInterfaces } from 'node:os'
import { routeCapability } from './capability-guard'
import type { Capabilities } from './exposure'
import { PORT, WEB_PORT, ALLOWED_ORIGINS } from './config'
import { readSecureOrigin } from './secure-origin'

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export interface ParsedHost {
  /** Lowercased, trailing dot stripped; an IPv6 address canonical and WITHOUT brackets or zone. */
  host: string
  port: number | null
}

/** A registered name or IPv4 literal: letters, digits, dot, hyphen, underscore. Nothing else. */
const NAME_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/
const PORT_RE = /^\d{1,5}$/
/** What may sit between the brackets before canonicalisation: hex, colons, a dotted IPv4 tail. */
const IPV6_RE = /^[0-9a-f:.]+$/

function parsePort(raw: string): number | null | undefined {
  if (!PORT_RE.test(raw)) return undefined
  const n = Number(raw)
  return n >= 1 && n <= 65535 ? n : undefined
}

/**
 * The canonical text of an IPv6 literal — the form a browser writes into a URL and hence into a
 * Host header — or null when it is not one. The zone id (`%eth0`, or `%25eth0` as RFC 6874 spells
 * it inside a URL) is dropped: it names an interface on the SENDER, not a different address.
 */
export function canonicalIpv6(raw: string): string | null {
  const bare = raw.toLowerCase().split('%')[0]!
  if (!bare.includes(':') || !IPV6_RE.test(bare)) return null
  try {
    const h = new URL(`http://[${bare}]/`).hostname
    return h.slice(1, -1)
  } catch {
    return null
  }
}

/**
 * `{ host, port }` from a raw Host header, or null for anything that is not a plain authority.
 * Userinfo, paths, queries, whitespace, an unbracketed IPv6 and an out-of-range port are all junk:
 * a browser never sends them, so a request carrying one is not one this gate needs to understand.
 */
export function parseHostHeader(raw: string | null): ParsedHost | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.length > 1024) return null

  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    if (close < 0) return null
    const inner = s.slice(1, close)
    const zoneless = inner.split('%')[0]!
    if (inner.includes('%') && !/^%(25)?[a-z0-9._~-]+$/.test(inner.slice(zoneless.length))) return null
    const host = canonicalIpv6(zoneless)
    if (!host) return null
    const rest = s.slice(close + 1)
    if (rest === '') return { host, port: null }
    if (!rest.startsWith(':')) return null
    const port = parsePort(rest.slice(1))
    return port === undefined ? null : { host, port }
  }

  const colon = s.indexOf(':')
  if (colon !== s.lastIndexOf(':')) return null // an IPv6 literal must be bracketed
  let name = colon < 0 ? s : s.slice(0, colon)
  let port: number | null = null
  if (colon >= 0) {
    const p = parsePort(s.slice(colon + 1))
    if (p === undefined) return null
    port = p
  }
  if (name.endsWith('.')) name = name.slice(0, -1)
  if (!name || !NAME_RE.test(name)) return null
  return { host: name, port }
}

// ---------------------------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------------------------

export interface HostAllowlist {
  /** Local names and addresses (normalised as `parseHostHeader` returns them). Need an own port. */
  readonly names: ReadonlySet<string>
  /** The ports this server itself listens on. */
  readonly ports: ReadonlySet<number>
  /** Exact `host port` pairs from configured/discovered origins. Pass whatever the port. */
  readonly origins: ReadonlySet<string>
}

export interface HostAllowlistInput {
  hostname: string | null
  interfaceAddresses: readonly string[]
  ports: readonly number[]
  allowedOrigins: readonly string[]
  secureOrigin: string | null
  /** From `magicDnsNames` — the tailnet's names for this node. Absent/empty when tailscale is not. */
  magicDnsNames?: readonly string[]
}

const originKey = (host: string, port: number): string => `${host} ${port}`

/** An origin as a `{host, port}` with the scheme's default port filled in, or null if unusable. */
function parseOrigin(origin: string): ParsedHost & { port: number } | null {
  let url: URL
  try { url = new URL(origin) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const parsed = parseHostHeader(url.host)
  if (!parsed) return null
  return { host: parsed.host, port: parsed.port ?? (url.protocol === 'https:' ? 443 : 80) }
}

/** Normalise one name/address the way `parseHostHeader` would present it, or null. */
function normaliseLocal(raw: string): string | null {
  const v6 = canonicalIpv6(raw)
  if (v6) return v6
  const parsed = parseHostHeader(raw)
  return parsed && parsed.port === null ? parsed.host : null
}

export function buildHostAllowlist(input: HostAllowlistInput): HostAllowlist {
  const names = new Set<string>(['localhost', '::1'])
  if (input.hostname) {
    const h = normaliseLocal(input.hostname)
    if (h) {
      names.add(h)
      if (!h.endsWith('.local')) names.add(`${h}.local`)
    }
  }
  for (const addr of input.interfaceAddresses) {
    const a = normaliseLocal(addr)
    if (a) names.add(a)
  }
  for (const n of input.magicDnsNames ?? []) {
    const m = normaliseLocal(n)
    if (m) names.add(m)
  }

  const origins = new Set<string>()
  for (const o of input.allowedOrigins) {
    const p = parseOrigin(o)
    if (p) origins.add(originKey(p.host, p.port))
  }
  if (input.secureOrigin) {
    const p = parseOrigin(input.secureOrigin)
    if (p) {
      origins.add(originKey(p.host, p.port))
      // The tailnet name resolves to this machine, so reaching it directly on our own ports
      // (http://<name>.ts.net:47292) is the same machine by the same name.
      names.add(p.host)
    }
  }

  return { names, ports: new Set(input.ports), origins }
}

/**
 * The ports that are this server's own. In dev (`!serveStatic`) the page is served by Vite, on
 * VITE_PORT or 47292 — a browser on the Vite page sends that port in its Host.
 */
export function ownPorts(input: { port: number; webPort: number; serveStatic: boolean; vitePort: string | undefined }): number[] {
  const ports = new Set<number>([input.port, input.webPort])
  if (!input.serveStatic) {
    const v = parsePort(input.vitePort ?? '47292')
    if (v !== undefined && v !== null) ports.add(v)
  }
  return [...ports]
}

/**
 * The names the tailnet resolves to this node, from the output of `tailscale status --json`:
 * `Self.DNSName` as-is (trailing dot stripped, lowercased) and its first label, which MagicDNS also
 * answers inside the tailnet. `[]` for anything else — no Self, no DNSName, a value that is not a
 * plain host name. Someone else's format, so every step is checked.
 */
export function magicDnsNames(status: unknown): string[] {
  if (!status || typeof status !== 'object') return []
  const self = (status as { Self?: unknown }).Self
  if (!self || typeof self !== 'object') return []
  const raw = (self as { DNSName?: unknown }).DNSName
  if (typeof raw !== 'string') return []
  const full = parseHostHeader(raw)
  if (!full || full.port !== null || full.host.includes(':')) return []
  const short = full.host.split('.')[0]!
  return short === full.host ? [full.host] : [full.host, short]
}

// ---------------------------------------------------------------------------------------------
// A request with no usable Host
// ---------------------------------------------------------------------------------------------

/**
 * A ready 400 when the request's URL cannot be built — no Host, an empty one, or one that makes
 * the URL unparseable — or null when `new URL(rawUrl)` is safe to call.
 *
 * `rawUrl` is `req.url` as Bun hands it over: `http://<Host><path>` normally, but the BARE PATH
 * (`/api/fleet`) when the Host is absent or empty (measured, both HTTP/1.0 and HTTP/1.1). Every
 * browser and every HTTP/1.1 client sends a Host, so this is a hand-written request, and it gets a
 * sentence rather than the 500 a throwing parse used to produce. Applies to every route: without a
 * URL there is no route to decide by. Nothing from the request is echoed back.
 */
export function badRequestTarget(rawUrl: string, hostHeader: string | null): Response | null {
  const respond = (error: string, message: string): Response =>
    new Response(JSON.stringify({ error, message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  if (!hostHeader || !hostHeader.trim()) {
    return respond(
      'missing_host',
      'This request carried no Host header, so the server cannot tell which site it was meant for. ' +
        'Every browser and HTTP/1.1 client sends one; send it.',
    )
  }
  try {
    new URL(rawUrl)
    return null
  } catch {
    return respond(
      'bad_request_target',
      "This request's Host header and path do not form a URL the server can read, so it cannot be routed. " +
        'Send a plain host name (and port) in the Host header.',
    )
  }
}

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

export type HostVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'foreign-host' | 'foreign-port'; host: string | null }

/** How much of a hostile header is echoed back. */
const ECHO_MAX = 256
const echo = (raw: string): string => (raw.length > ECHO_MAX ? raw.slice(0, ECHO_MAX) : raw)

const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
/** `::ffff:7f00:1` — the canonical spelling of `::ffff:127.0.0.1`. The high byte 0x7f is 127. */
const MAPPED_V4_HEX = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/

function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  const m = LOOPBACK_V4.exec(host)
  if (m) return m.slice(1).every(o => Number(o) <= 255)
  if (MAPPED_V4_HEX.test(host)) return true
  if (host.startsWith('::ffff:')) return isLoopback(host.slice(7))
  return false
}

export function hostAllowed(hostHeader: string | null, allowlist: HostAllowlist): HostVerdict {
  if (!hostHeader) return { ok: false, reason: 'missing', host: null }
  const parsed = parseHostHeader(hostHeader)
  if (!parsed) return { ok: false, reason: 'malformed', host: echo(hostHeader) }
  const { host, port } = parsed

  // An exact origin somebody allowed (or tailscale serve proves) passes whatever the port.
  if (port === null) {
    if (allowlist.origins.has(originKey(host, 80)) || allowlist.origins.has(originKey(host, 443))) return { ok: true }
  } else if (allowlist.origins.has(originKey(host, port))) {
    return { ok: true }
  }

  if (!isLoopback(host) && !allowlist.names.has(host)) {
    return { ok: false, reason: 'foreign-host', host: echo(hostHeader) }
  }
  if (port === null || !allowlist.ports.has(port)) {
    return { ok: false, reason: 'foreign-port', host: echo(hostHeader) }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

function refusalMessage(verdict: Exclude<HostVerdict, { ok: true }>, raw: string | null): string {
  if (verdict.reason === 'missing') {
    return 'The request carried no Host header, so this machine cannot tell which name it was reached by and refuses this route.'
  }
  if (verdict.reason === 'malformed') {
    return `The request's Host header "${verdict.host}" could not be read as a host name, so this machine refuses this route.`
  }
  const parsed = parseHostHeader(raw)
  const authority = parsed
    ? `${parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host}${parsed.port === null ? '' : `:${parsed.port}`}`
    : verdict.host
  return (
    `This machine does not answer to the host "${verdict.host}" for this route. ` +
    `If you reach it by that name on purpose, add its origin to AGENTISTICS_ALLOWED_ORIGINS ` +
    `(for example http://${authority}) and restart agentop server.`
  )
}

/**
 * A ready 421 when a `localShell` route was reached by a name that is not this machine's, or null
 * when the request may proceed.
 *
 * Applies ONLY while `localShell` is ON. When it is off the capability guard has already answered
 * 403 (it runs first), and a central or a public profile must keep answering exactly as it did —
 * this gate exists for the profile where that 403 is not there to protect anything.
 *
 * 421 Misdirected Request is the status for "this server is not authoritative for the name you
 * asked for", which is precisely the situation. The caller spreads CORS_HEADERS over it.
 */
export function hostGate(
  pathname: string,
  hostHeader: string | null,
  allowlist: HostAllowlist,
  caps: Capabilities,
): Response | null {
  if (routeCapability(pathname) !== 'localShell') return null
  if (!caps.localShell) return null
  const verdict = hostAllowed(hostHeader, allowlist)
  if (verdict.ok) return null
  return new Response(
    JSON.stringify({ error: 'misdirected_host', host: verdict.host, message: refusalMessage(verdict, hostHeader) }),
    { status: 421, headers: { 'Content-Type': 'application/json' } },
  )
}

// ---------------------------------------------------------------------------------------------
// The runtime holder — impure. Built at startup and on a timer, never per request.
// ---------------------------------------------------------------------------------------------

const REFRESH_MS = 60_000

let current: HostAllowlist | null = null
let lastSecureOrigin: string | null = null
let lastMagicDns: string[] = []
/** Set once the "MagicDNS names are not allowlisted" line has been logged; re-armed by a success. */
let magicDnsWarned = false
let refreshTimer: ReturnType<typeof setInterval> | null = null

/** Every address the OS reports, or null when the read itself failed. */
function interfaceAddresses(): string[] | null {
  try {
    const out: string[] = []
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) out.push(info.address)
    }
    return out
  } catch {
    return null
  }
}

function safeHostname(): string | null {
  try { return osHostname() } catch { return null }
}

/**
 * Rebuild from the machine as it is now. A read that FAILS keeps the previous interface list: a
 * transient error must not narrow the allowlist to loopback and lock the person out of the LAN
 * address their phone is open on.
 */
function rebuildSync(): HostAllowlist {
  const addrs = interfaceAddresses() ?? lastInterfaces
  lastInterfaces = addrs
  current = buildHostAllowlist({
    hostname: safeHostname(),
    interfaceAddresses: addrs,
    ports: ownPorts({
      port: PORT,
      webPort: WEB_PORT,
      serveStatic: process.env.SERVE_STATIC === '1',
      vitePort: process.env.VITE_PORT,
    }),
    allowedOrigins: ALLOWED_ORIGINS,
    secureOrigin: lastSecureOrigin,
    magicDnsNames: lastMagicDns,
  })
  return current
}
let lastInterfaces: string[] = []

const TAILSCALE_TIMEOUT_MS = 2_000

/**
 * `tailscale status --json` → the MagicDNS names, or the reason there are none. Spawned the way
 * `readSecureOrigin` spawns `tailscale serve status` (same binary, same 2 s bound), and killed when
 * the bound is hit so a wedged daemon does not leave a process per minute behind.
 */
async function readMagicDns(): Promise<{ names: string[] } | { why: string }> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['tailscale', 'status', '--json'], { stdout: 'pipe', stderr: 'ignore' })
  } catch {
    return { why: 'the tailscale command is not installed' }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { proc.kill() } catch { /* already gone */ } }, TAILSCALE_TIMEOUT_MS)
  try {
    const out = await new Response(proc.stdout as ReadableStream).text()
    const code = await proc.exited
    if (timedOut) return { why: `tailscale status did not answer within ${TAILSCALE_TIMEOUT_MS / 1000} s` }
    if (code !== 0) return { why: `tailscale status exited with code ${code} (is tailscaled running and logged in?)` }
    let parsed: unknown
    try { parsed = JSON.parse(out) } catch { return { why: 'tailscale status --json printed something that is not JSON' } }
    const names = magicDnsNames(parsed)
    return names.length > 0 ? { names } : { why: 'tailscale status reports no MagicDNS name for this node (Self.DNSName)' }
  } catch {
    return { why: 'tailscale status could not be read' }
  } finally {
    clearTimeout(timer)
  }
}

async function refresh(): Promise<void> {
  rebuildSync()
  try {
    // A failure keeps the previous names, for the same reason a failed interface read does, and
    // says so ONCE per outage rather than on every tick of the timer.
    const dns = await readMagicDns()
    if ('names' in dns) {
      magicDnsWarned = false
      if (dns.names.join(' ') !== lastMagicDns.join(' ')) {
        lastMagicDns = dns.names
        rebuildSync()
      }
    } else if (!magicDnsWarned) {
      magicDnsWarned = true
      const kept = lastMagicDns.length > 0 ? ` Keeping the last known names (${lastMagicDns.join(', ')}).` : ''
      console.warn(`[host-allow] MagicDNS names are not allowlisted: ${dns.why}. Reach this machine by its IP or hostname, or add the origin to AGENTISTICS_ALLOWED_ORIGINS.${kept}`)
    }
  } catch { /* keep the previous value */ }
  try {
    // readSecureOrigin spawns `tailscale serve status --json` (memoized for a minute, bounded to
    // 2 s) and answers null for every failure. Only a REAL answer replaces the last one, so a
    // tailscale hiccup does not lock out the https origin somebody is using right now.
    const origin = await readSecureOrigin(WEB_PORT)
    if (origin !== null && origin !== lastSecureOrigin) {
      lastSecureOrigin = origin
      rebuildSync()
    }
  } catch { /* keep the previous value */ }
}

/**
 * The allowlist in force. Before the first refresh it is built synchronously from loopback +
 * hostname + interfaces + ALLOWED_ORIGINS (no secure origin yet), so the very first request is
 * never judged against an empty list — nor waved through by a missing one.
 */
export function currentHostAllowlist(): HostAllowlist {
  return current ?? rebuildSync()
}

/** Build now and every minute after. Idempotent; the timer never holds the process open. */
export function startHostAllowlistRefresh(): void {
  if (refreshTimer) return
  rebuildSync()
  const tick = () => { refresh().catch(err => console.error('[host-allow] refresh failed:', err)) }
  tick()
  refreshTimer = setInterval(tick, REFRESH_MS)
  refreshTimer.unref?.()
}
