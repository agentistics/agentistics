/**
 * DOCKER.AMBIENTES S2 — the egress proxy's decision (SPEC-r3 §3.6). PURE.
 *
 * Every container is `--network none`. The ONLY way out is the download step's unix socket to a proxy the
 * launcher runs on the host, and this decides each request: only `CONNECT host:443`; the host in the allow-list
 * (itself inside agentop's maximum list); and EVERY address the host resolved to public and none of the host's
 * own. Plain HTTP is refused; a redirect is a new CONNECT and is decided again. 47291/47292 can never be reached:
 * they are on loopback/LAN addresses (refused by range) and on a port other than 443 (refused by port).
 */
import { isIP } from 'node:net'

/** The most any profile may allow: package registries the catalogue managers use. */
export const EGRESS_MAX_ALLOW: readonly string[] = [
  'registry.npmjs.org', 'registry.yarnpkg.com', 'npm.pkg.github.com', 'codeload.github.com', 'objects.githubusercontent.com',
]

export type EgressDecision = { allow: true; host: string; port: 443; ip: string } | { allow: false; reason: string }

const v4ToInt = (ip: string): number => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
const inV4 = (ip: string, cidr: string): boolean => {
  const [base, bits] = cidr.split('/') as [string, string]
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask)
}
const V4_PRIVATE = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4']

/** Expand an IPv6 text to 8 groups (lower-case, no zone). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    if (isIP(v4[1]!) !== 4) return null
    const n = v4ToInt(v4[1]!)
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  if (s.split('::').length > 2) return null
  const [head, rest] = s.includes('::') ? s.split('::') as [string, string] : [s, undefined]
  const h = head ? head.split(':').map(x => parseInt(x, 16)) : []
  const r = rest ? rest.split(':').map(x => parseInt(x, 16)) : []
  const fill = rest !== undefined ? 8 - h.length - r.length : 0
  const g = [...h, ...Array(Math.max(0, fill)).fill(0), ...r]
  return g.length === 8 && g.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null
}

/** Is this address one the egress must never connect to (private, loopback, link-local, multicast, mapped, …)? */
export function isForbiddenAddress(ip: string, hostOwn: readonly string[] = []): boolean {
  const norm = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostOwn.some(h => h.toLowerCase() === norm)) return true
  const fam = isIP(norm)
  if (fam === 4) return V4_PRIVATE.some(c => inV4(norm, c))
  if (fam !== 6) return true // not an address at all: refuse
  const g = v6Groups(norm)
  if (!g) return true
  if (g.every(x => x === 0)) return true // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true // multicast
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return true // ::ffff:a.b.c.d mapped / ::a.b.c.d compatible
  if (g[0] === 0x2002 || (g[0] === 0x2001 && g[1] === 0)) return true // 6to4 / Teredo embed v4
  if (g[0] === 0x64 && g[1] === 0xff9b) return true // NAT64 embeds v4
  return false
}

export interface EgressRequest {
  /** The first request line the container sent, e.g. `CONNECT registry.npmjs.org:443 HTTP/1.1`. */
  requestLine: string
  /** The profile/grant allow-list (already intersected with `EGRESS_MAX_ALLOW` by the caller or here). */
  allow: readonly string[]
  /** What DNS answered for the host (resolved ON THE HOST). */
  resolved: readonly string[]
  /** Every address of every host interface and bridge gateway, read at the moment of the decision. */
  hostAddresses: readonly string[]
}

/** Parse the target of a request line. Exposed so the proxy resolves exactly the host the decision judged. */
export function connectTarget(requestLine: string): { host: string; port: number } | { error: string } {
  const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(requestLine.trim())
  if (!m) return { error: 'not an HTTP request line' }
  if (m[1] !== 'CONNECT') return { error: `${m[1]} refused: only CONNECT (TLS) leaves the environment; plain HTTP is refused` }
  const t = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/.exec(m[2]!)
  if (!t) return { error: `target ${m[2]} is not host:port` }
  return { host: t[1]!.toLowerCase().replace(/\.+$/, ''), port: Number(t[2]) }
}

export function egressDecision(r: EgressRequest): EgressDecision {
  const t = connectTarget(r.requestLine)
  if ('error' in t) return { allow: false, reason: t.error }
  if (t.port !== 443) return { allow: false, reason: `port ${t.port} refused: only 443` }
  if (isIP(t.host.replace(/^\[|\]$/g, '')) || /^\d+$/.test(t.host)) return { allow: false, reason: `${t.host}: an address, not a name; only allowed registry names` }
  const allowed = r.allow.filter(h => EGRESS_MAX_ALLOW.includes(h.toLowerCase()))
  if (!allowed.includes(t.host)) return { allow: false, reason: `${t.host} is not in the allow-list (${allowed.join(', ') || 'empty'})` }
  if (!r.resolved.length) return { allow: false, reason: `${t.host} did not resolve` }
  const bad = r.resolved.find(ip => isForbiddenAddress(ip, r.hostAddresses))
  if (bad) return { allow: false, reason: `${t.host} resolves to ${bad}, a private or host address` }
  return { allow: true, host: t.host, port: 443, ip: r.resolved[0]! }
}
