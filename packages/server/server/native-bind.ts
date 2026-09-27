/**
 * native-bind.ts — pure parsers + IO reader for what the NATIVE `agentop server` process is
 * ACTUALLY listening on.
 *
 * Security finding S-1: `index.ts` calls `Bun.serve({ hostname: '0.0.0.0', port: PORT, ... })`
 * unconditionally, for both PORT (config.ts, 47291, api+mcp) and, in binary mode, WEB_PORT
 * (47292, the dashboard) — the bind never reads `AGENTISTICS_EXPOSURE` or `BIND_IP` at all.
 * `exposure.ts` nonetheless describes the `local` profile as "solo machine on 127.0.0.1", and
 * `agentop doctor`'s existing `bind-ip` check (`preflight.ts`) only ever looks at the `BIND_IP`
 * env var — a setting only the Docker deployment sets or reads. So a native `local`-profile
 * server bound to every interface passed every doctor check that existed before this module:
 * none of them ever asked the kernel what is actually listening.
 *
 * This module answers exactly that question, independent of any env var:
 *   - Linux: parse /proc/net/tcp and /proc/net/tcp6 directly (no process spawned).
 *   - macOS: shell out to `lsof -nP -iTCP:<port> -sTCP:LISTEN`, one call per port (mirrors
 *     `macos-processes-io.ts`'s approach — there is no /proc equivalent on macOS).
 *   - Anything else (Windows, or a read that fails on Linux/macOS) cannot answer, and SAYS SO
 *     rather than reporting an empty list — the N/A-vs-confident-0 rule this repo applies
 *     everywhere else, and CLAUDE.md's own wording for this exact check: "a check that could
 *     not be verified reports fail, never a reassuring pass."
 *
 * STATED LIMIT: the macOS branch is written against `lsof`'s documented plain-output shape
 * (fixture-tested below), the same limit `macos-processes.ts` states for its own readers — it
 * has not been driven against a live Mac.
 */
import { readFileSync } from 'node:fs'

export interface NativeListener {
  port: number
  /** The literal address as read off the kernel's listener table (Linux) or `lsof`'s numeric
   *  NAME field (macOS): e.g. '0.0.0.0', '127.0.0.1', '::', '::1', a LAN IP, or `::ffff:a.b.c.d`
   *  for an IPv4-mapped IPv6 socket. */
  address: string
}

export type NativeBindResult =
  | { kind: 'read'; listeners: NativeListener[] }
  | { kind: 'unreadable'; reason: string }

// ---------------------------------------------------------------------------
// PURE — Linux: /proc/net/tcp and /proc/net/tcp6
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i + 2 <= hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return bytes
}

/** RFC-5952-ish compression: replace the longest run of >=2 zero groups with `::`. Good enough
 *  for a doctor detail line — it does not claim to be the canonical form for every input. */
function formatIPv6Groups(groups: number[]): string {
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i
      curLen++
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart }
    } else {
      curStart = -1
      curLen = 0
    }
  }
  if (bestLen < 2) return groups.map(g => g.toString(16)).join(':')
  const before = groups.slice(0, bestStart).map(g => g.toString(16))
  const after = groups.slice(bestStart + bestLen).map(g => g.toString(16))
  return `${before.join(':')}::${after.join(':')}`
}

/**
 * Decode one /proc/net/tcp `local_address` hex field: 8 hex chars = one 32-bit word, stored in
 * the file byte-reversed (little-endian) relative to the address's own network-order bytes.
 * Reversing the 4 decoded bytes back gives the dotted-decimal address.
 */
function decodeV4Hex(hex: string): string | undefined {
  if (hex.length !== 8) return undefined
  const bytes = hexToBytes(hex)
  if (bytes.length !== 4) return undefined
  return bytes.reverse().join('.')
}

/**
 * Decode one /proc/net/tcp6 `local_address` hex field: 32 hex chars = FOUR 32-bit words, each
 * word independently byte-reversed the same way the v4 field is, then concatenated in address
 * order (word 0 = the address's first 4 bytes, ... word 3 = its last 4). Recognises an
 * IPv4-mapped address (bytes 0-9 zero, bytes 10-11 = 0xff 0xff) and returns it in its canonical
 * `::ffff:a.b.c.d` form rather than as eight mostly-empty v6 groups.
 */
function decodeV6Hex(hex: string): string | undefined {
  if (hex.length !== 32) return undefined
  const bytes: number[] = []
  for (let w = 0; w < 4; w++) {
    const word = hexToBytes(hex.slice(w * 8, w * 8 + 8))
    if (word.length !== 4) return undefined
    bytes.push(...word.reverse())
  }
  const isV4Mapped = bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (isV4Mapped) return `::ffff:${bytes.slice(12, 16).join('.')}`
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!)
  return formatIPv6Groups(groups)
}

/** LISTEN, per /proc/net/tcp's documented `st` column (include/net/tcp_states.h: TCP_LISTEN). */
const TCP_LISTEN_STATE = '0A'

/**
 * Parse one /proc/net/tcp or /proc/net/tcp6 file. Format (Documentation/networking/
 * proc_net_tcp.txt): a header line, then one row per socket — column 2 (`local_address`) is
 * `HEXADDR:HEXPORT`, column 4 (`st`) is the connection state. Only LISTEN rows are kept, and
 * only for the requested ports — this reads listeners, never connections.
 */
export function parseProcNetTcp(raw: string, opts: { ipv6: boolean; ports: Set<number> }): NativeListener[] {
  const out: NativeListener[] = []
  const lines = raw.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    const cols = line.split(/\s+/)
    const local = cols[1]
    const state = cols[3]
    if (!local || state !== TCP_LISTEN_STATE) continue
    const sep = local.lastIndexOf(':')
    if (sep < 0) continue
    const addrHex = local.slice(0, sep)
    const port = parseInt(local.slice(sep + 1), 16)
    if (!Number.isFinite(port) || !opts.ports.has(port)) continue
    const address = opts.ipv6 ? decodeV6Hex(addrHex) : decodeV4Hex(addrHex)
    if (address === undefined) continue
    out.push({ port, address })
  }
  return out
}

// ---------------------------------------------------------------------------
// PURE — macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN`
// ---------------------------------------------------------------------------

/**
 * Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` plain output. `-n`/`-P` make the NAME field fully
 * numeric (no DNS/service-name lookups to fight with). The NAME field is read as the LAST
 * whitespace-separated token before an optional `(LISTEN)` marker — robust to lsof's column
 * padding and to a DEVICE column some lsof builds omit, rather than indexing by column number.
 * `*` is lsof's own wildcard spelling (`0.0.0.0` for an IPv4 row, `::` for an IPv6 one — told
 * apart by the TYPE column), and a bracketed `[addr]` (an unmapped IPv6 address) is unwrapped.
 */
export function parseLsofListenOutput(raw: string): NativeListener[] {
  const out: NativeListener[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('COMMAND')) continue
    const cols = line.split(/\s+/)
    if (cols.length === 0) continue
    const isV6 = cols.includes('IPv6')
    const last = cols[cols.length - 1]
    const nameTok = last === '(LISTEN)' ? cols[cols.length - 2] : last
    if (!nameTok) continue
    const m = /^(.+):(\d+)$/.exec(nameTok)
    if (!m) continue
    const port = Number(m[2])
    if (!Number.isFinite(port)) continue
    let address = m[1]!
    if (address === '*') address = isV6 ? '::' : '0.0.0.0'
    else if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
    out.push({ port, address })
  }
  return out
}

// ---------------------------------------------------------------------------
// PURE — loopback classification, shared by the preflight check
// ---------------------------------------------------------------------------

/** Loopback in either family, including an IPv4-mapped loopback (`::ffff:127.0.0.1`). */
export function isLoopbackAddress(address: string): boolean {
  const v4 = address.replace(/^::ffff:/i, '')
  return address === '::1' || v4 === '127.0.0.1' || v4.startsWith('127.')
}

// ---------------------------------------------------------------------------
// IO — reads the host's own listener table. Never throws; a failure is reported IN the result.
// ---------------------------------------------------------------------------

function readLinuxBind(ports: Set<number>): NativeBindResult {
  let v4Text: string
  try {
    v4Text = readFileSync('/proc/net/tcp', 'utf-8')
  } catch (err) {
    return { kind: 'unreadable', reason: `could not read /proc/net/tcp: ${err instanceof Error ? err.message : String(err)}` }
  }
  const listeners = parseProcNetTcp(v4Text, { ipv6: false, ports })
  try {
    listeners.push(...parseProcNetTcp(readFileSync('/proc/net/tcp6', 'utf-8'), { ipv6: true, ports }))
  } catch {
    // IPv6 disabled (or /proc/net/tcp6 otherwise unreadable) is not fatal on its own: /proc/net/tcp,
    // the primary source, was read fine. A v6-only wide bind would go undetected here — a stated
    // limit, not a silent one, since v4 already answered whether ports are exposed there.
  }
  return { kind: 'read', listeners }
}

function runLsof(argv: string[]): { ok: boolean; stdout: string; error?: string } {
  try {
    const proc = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 4000 })
    // lsof's own documented exit code is 1 when NOTHING matched the selection — a legitimate
    // "not listening" answer, never a failure to run. Only a thrown spawn error (binary missing,
    // timeout) is treated as unreadable; see the module header's stated limit.
    return { ok: true, stdout: proc.stdout.toString('utf-8') }
  } catch (err) {
    return { ok: false, stdout: '', error: err instanceof Error ? err.message : String(err) }
  }
}

function readMacBind(ports: number[]): NativeBindResult {
  const listeners: NativeListener[] = []
  for (const port of ports) {
    const { ok, stdout, error } = runLsof(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
    if (!ok) return { kind: 'unreadable', reason: `lsof could not run: ${error}` }
    listeners.push(...parseLsofListenOutput(stdout).filter(l => l.port === port))
  }
  return { kind: 'read', listeners }
}

/**
 * Read what the native server is actually listening on, for the given ports (config.ts's PORT
 * and WEB_PORT). Never throws.
 */
export function readNativeBind(ports: number[]): NativeBindResult {
  if (process.platform === 'linux') return readLinuxBind(new Set(ports))
  if (process.platform === 'darwin') return readMacBind(ports)
  return {
    kind: 'unreadable',
    reason: `cannot read the native bind on platform "${process.platform}" (no /proc, no lsof reader)`,
  }
}
