import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { hostWhich } from './host-which'

/**
 * RUN.ISOLAMENTO-REDE: a REAL network block for everything a throwaway run starts, not only the agentop CLI.
 *
 * The run's command lives in its own user + network namespace, so 127.0.0.1 / [::1] inside it is the run's OWN (empty)
 * loopback: the real agentistics on :47291/:47292 simply is not there for ANY program (curl, Bun.connect, node:http).
 * The outside world (bun install, git fetch, DNS) is reached through slirp4netns, started by the launcher:
 *   - `--disable-host-loopback` refuses 10.0.2.2 (slirp's alias for the host's 127.0.0.1);
 *   - but the real server binds 0.0.0.0, so the host's OWN addresses (LAN, tailscale) would still reach it through the NAT.
 *     An nft rule INSIDE the namespace rejects tcp to 47291/47292 on every address and family. It is installed while the
 *     process still holds the namespace's root capabilities and the command then runs in a NESTED user namespace mapped to
 *     the real uid, which has no capability over the outer namespace's firewall: the command cannot remove the rule.
 *   - `--serve` keeps working: the server binds inside the namespace and the launcher forwards ONLY the run's own
 *     api/web ports to the host's 127.0.0.1 (`add_hostfwd`), never 47291/47292.
 * Ownership: the outer namespace maps the real uid to root, the nested one maps it back, so files written by the run are
 * owned by the real user on the host and `id` inside says the real uid.
 * Where it cannot work (macOS, a container without user namespaces, a missing binary) the run falls back to the old
 * behaviour (the CLI guard only) and says so in ONE line; `--no-netns` asks for that on purpose.
 */

export const NETNS_BLOCKED_PORTS: readonly number[] = [47291, 47292]
/** slirp4netns' guest address; the in-namespace server listens on 0.0.0.0, so the host forward targets it. */
export const SLIRP_GUEST_ADDR = '10.0.2.100'
const NEEDED_BINARIES = ['unshare', 'slirp4netns', 'nft', 'ip', 'sh'] as const

export type NetnsInputs = {
  noNetns: boolean
  platform: NodeJS.Platform
  /** Which of NEEDED_BINARIES the host has. */
  binaries: Readonly<Record<string, boolean>>
  /** Did a probe (a namespace in which `nft add table` works) succeed? null = not probed. */
  usernsWorks: boolean | null
}
export type NetnsDecision = { mode: 'netns' } | { mode: 'none'; reason: string; deliberate: boolean }

/** PURE. Isolate when it can work here; otherwise name the one reason it cannot. */
export function decideNetns(i: NetnsInputs): NetnsDecision {
  if (i.noNetns) return { mode: 'none', reason: '--no-netns was given', deliberate: true }
  if (i.platform !== 'linux') return { mode: 'none', reason: `network namespaces are Linux-only (this is ${i.platform})`, deliberate: false }
  const missing = NEEDED_BINARIES.filter(b => !i.binaries[b])
  if (missing.length) return { mode: 'none', reason: `${missing.join(', ')} not found`, deliberate: false }
  if (i.usernsWorks !== true) return { mode: 'none', reason: 'unprivileged user namespaces are not available here', deliberate: false }
  return { mode: 'netns' }
}

/** The one line a run prints when the network is NOT isolated (also when `--no-netns` asked for that); null when it is isolated. */
export function netnsNotice(d: NetnsDecision): string | null {
  if (d.mode === 'netns') return null
  return `agentop run: network NOT isolated (${d.reason}); only the agentop CLI refuses the real server on :${NETNS_BLOCKED_PORTS.join('/:')}, other programs in this run can still reach it.`
}

/**
 * PURE. The script run as the namespace's root: wait for slirp's tap0, bring lo up, install the firewall, then drop into a
 * nested user namespace mapped to the real uid and exec the command. No tap0 within ~10 s (slirp failed) is not fatal: the
 * run keeps its own loopback, which is the part that protects the real server.
 */
export function netnsInnerScript(uid: number, gid: number, ports: readonly number[] = NETNS_BLOCKED_PORTS): string {
  const set = ports.join(', ')
  return [
    'i=0',
    // `ip`, never /sys/class/net: sysfs was mounted by the OLD network namespace and keeps listing ITS interfaces.
    'while ! ip link show tap0 >/dev/null 2>&1 && [ "$i" -lt 200 ]; do i=$((i+1)); sleep 0.05; done',
    'ip link set lo up',
    `nft add table inet agrun && nft add chain inet agrun out '{ type filter hook output priority 0 ; policy accept ; }' && nft add rule inet agrun out tcp dport '{ ${set} }' reject with tcp reset || { echo "agentop run: could not install the network firewall; refusing to start" >&2; exit 126; }`,
    `exec unshare --user --map-user=${uid} --map-group=${gid} -- "$@"`,
  ].join('\n')
}
export const NETNS_MARKER = 'agr-netns'

/** PURE. The argv that runs `argv` inside the namespace. */
export function netnsArgv(argv: readonly string[], uid: number, gid: number, ports: readonly number[] = NETNS_BLOCKED_PORTS): string[] {
  return ['unshare', '--map-root-user', '--net', '--', 'sh', '-c', netnsInnerScript(uid, gid, ports), NETNS_MARKER, ...argv]
}

/**
 * Test seam: `AGENTISTICS_RUN_NETNS_EXTRA_PORTS=50123,50124` blocks those ports too (a test cannot bind the real 47291/47292).
 * It can only ADD ports to the rule, never remove one.
 */
export function blockedPorts(env: Record<string, string | undefined> = process.env): number[] {
  const extra = (env.AGENTISTICS_RUN_NETNS_EXTRA_PORTS ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0 && n < 65536)
  return [...new Set([...NETNS_BLOCKED_PORTS, ...extra])]
}

/** PURE. slirp4netns attached to the namespace of `pid`. */
export function slirpArgv(pid: number, apiSocket: string): string[] {
  return ['--configure', '--disable-host-loopback', '--enable-sandbox', '--enable-seccomp', '--api-socket', apiSocket, String(pid), 'tap0']
}

/** PURE. The host forwards `--serve` needs: the run's own ports only; a real agentop port is never forwarded. */
export function hostfwdRequests(ports: readonly number[]): { execute: 'add_hostfwd'; arguments: Record<string, string | number> }[] {
  return ports.filter(p => !NETNS_BLOCKED_PORTS.includes(p)).map(p => ({
    execute: 'add_hostfwd' as const,
    arguments: { proto: 'tcp', host_addr: '127.0.0.1', host_port: p, guest_addr: SLIRP_GUEST_ADDR, guest_port: p },
  }))
}

/** Probes this host (cheap: a few `which` and one `unshare true`). */
export function probeNetns(noNetns: boolean): NetnsDecision {
  const binaries = Object.fromEntries(NEEDED_BINARIES.map(b => [b, !!hostWhich(b)]))
  let usernsWorks: boolean | null = null
  if (!noNetns && process.platform === 'linux' && binaries.unshare) {
    try { usernsWorks = spawnSync('unshare', ['--map-root-user', '--net', '--', 'nft', 'add', 'table', 'inet', 'agprobe'], { stdio: 'ignore', timeout: 5000 }).status === 0 } catch { usernsWorks = false }
  }
  return decideNetns({ noNetns, platform: process.platform, binaries, usernsWorks })
}

const nsOf = (pid: number): string | null => { try { return readlinkSync(`/proc/${pid}/ns/net`) } catch { return null } }
const cmdlineOf = (pid: number): string => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return '' } }

/** Waits until `pid` has exec'd the inner script (so its namespace and uid map exist) and sits in a namespace other than ours. */
export async function waitForNetns(pid: number, alive: () => boolean = () => true, timeoutMs = 8000): Promise<boolean> {
  const mine = nsOf(process.pid)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && alive()) {
    const theirs = nsOf(pid)
    if (theirs && theirs !== mine && cmdlineOf(pid).includes(NETNS_MARKER)) return true
    await Bun.sleep(20)
  }
  return false
}

export type SlirpHandle = { pid: number; socket: string; child: ChildProcess }

/** Starts slirp4netns for the namespace of `pid`. Returns null (and why) when it did not come up. */
export async function startSlirp(pid: number, socket: string, alive: () => boolean = () => true): Promise<SlirpHandle | { error: string }> {
  if (!await waitForNetns(pid, alive)) return { error: alive() ? 'the run did not enter its network namespace' : 'the command ended before its network came up' }
  const child = spawn('slirp4netns', slirpArgv(pid, socket), { stdio: 'ignore' })
  if (!child.pid) return { error: 'slirp4netns did not start' }
  let died = false
  child.once('exit', () => { died = true })
  child.once('error', () => { died = true })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (died) return { error: 'slirp4netns exited at startup' }
    if (existsSync(socket)) return { pid: child.pid, socket, child }
    await Bun.sleep(20)
  }
  try { process.kill(child.pid, 'SIGTERM') } catch {}
  return { error: 'slirp4netns did not open its API socket' }
}

/** One request on slirp's API socket; resolves with its raw answer. */
export function slirpApi(socket: string, request: object, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket)
    let out = ''
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('slirp api timeout')) }, timeoutMs)
    // slirp answers one JSON document per request and keeps the connection open: the first complete document is the answer.
    const done = () => { clearTimeout(timer); conn.destroy(); resolve(out) }
    conn.on('data', d => { out += d.toString(); try { JSON.parse(out); done() } catch { /* more to come */ } })
    conn.on('end', done)
    conn.on('error', e => { clearTimeout(timer); reject(e) })
    conn.on('connect', () => conn.write(JSON.stringify(request)))
  })
}

/** Forwards the run's own ports to the host's 127.0.0.1. Returns the ports that could not be forwarded. */
export async function forwardPorts(socket: string, ports: readonly number[]): Promise<number[]> {
  const failed: number[] = []
  for (const req of hostfwdRequests(ports)) {
    try {
      const answer = await slirpApi(socket, req)
      if (!/"return"/.test(answer)) failed.push(Number(req.arguments.host_port))
    } catch { failed.push(Number(req.arguments.host_port)) }
  }
  return failed
}

/** Kills the slirp this run started; only when the pid still is a slirp4netns (a recycled pid is never signalled). */
export function stopSlirp(pid: number | undefined): void {
  if (!pid || !cmdlineOf(pid).includes('slirp4netns')) return
  try { process.kill(pid, 'SIGTERM') } catch {}
}
