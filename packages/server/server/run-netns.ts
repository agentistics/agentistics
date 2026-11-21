import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { hostWhich } from './host-which'

/**
 * RUN.ISOLAMENTO-REDE: a REAL network block for everything a throwaway run starts, not only the agentop CLI.
 *
 * The run's command lives in its own user + network namespace, so 127.0.0.1 / [::1] inside it is the run's OWN (empty)
 * loopback: the real agentistics on :47291/:47292 simply is not there for ANY program (curl, Bun.connect, node:http).
 * The outside world (bun install, git fetch, DNS) is reached through slirp4netns, started by the launcher:
 *   - `--disable-host-loopback` refuses 10.0.2.2 (slirp's alias for the host's 127.0.0.1);
 *   - but the real server binds 0.0.0.0, and ANY host address (LAN, tailscale, docker bridges, the default gateway) or any
 *     local proxy (`tailscale serve :8443 -> 127.0.0.1:47292`, socat, a Windows portproxy) would still reach it through the NAT.
 *     So the firewall blocks by DESTINATION: new connections to EVERY address of the host itself are rejected (tcp reset /
 *     icmp unreachable, udp/53 left open for DNS), whatever the port, plus tcp to 47291/47292 anywhere as a second layer.
 *     The rules are installed while the
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
const NEEDED_BINARIES = ['unshare', 'setpriv', 'slirp4netns', 'nft', 'ip', 'sh'] as const

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
export function netnsInnerScript(uid: number, gid: number, ports: readonly number[] = NETNS_BLOCKED_PORTS, hostAddrs: readonly string[] = [], hide: readonly string[] = []): string {
  const set = ports.join(', ')
  const v4 = [...new Set([SLIRP_GATEWAY, ...hostAddrs.filter(a => isIP(a) === 4)])]
  const v6 = [...new Set(hostAddrs.filter(a => isIP(a) === 6))]
  const steps = ['nft add table inet agrun', `nft add chain inet agrun out '{ type filter hook output priority 0 ; policy accept ; }'`]
  // BY DESTINATION: any NEW connection to an address of the host itself (the real server answers on all of them and any
  // local proxy forwards to it) is rejected whatever the port. `ct state new` keeps the replies of `--serve` working.
  for (const [fam, list] of [['ip', v4], ['ip6', v6]] as const) {
    if (!list.length) continue
    const l = `{ ${list.join(', ')} }`
    steps.push(`nft add rule inet agrun out ${fam} daddr '${l}' ct state new meta l4proto tcp reject with tcp reset`)
    steps.push(`nft add rule inet agrun out ${fam} daddr '${l}' ct state new meta l4proto udp udp dport != 53 reject`)
    steps.push(`nft add rule inet agrun out ${fam} daddr '${l}' ct state new meta l4proto != '{ tcp, udp }' drop`)
  }
  // Second layer: the real ports on ANY destination.
  steps.push(`nft add rule inet agrun out tcp dport '{ ${set} }' reject with tcp reset`)
  // Mount namespace (ours): the real server's unix sockets and tmux sockets are covered by empty tmpfs mounts.
  for (const d of hide) steps.push(`mount -t tmpfs -o mode=0700 tmpfs ${shq(d)}`)
  return [
    'i=0',
    'p=',  // a TERM during the setup (before the command exists) must end the run
    'trap \'if [ -n "$p" ]; then kill -TERM "$p" 2>/dev/null; else exit 143; fi\' TERM INT HUP',
    // `ip`, never /sys/class/net: sysfs was mounted by the OLD network namespace and keeps listing ITS interfaces.
    'while ! ip link show tap0 >/dev/null 2>&1 && [ "$i" -lt 200 ]; do i=$((i+1)); sleep 0.05; done',
    'ip link set lo up',
    `${steps.join(' && ')} || { echo "agentop run: could not install the network firewall; refusing to start" >&2; exit 126; }`,
    // `unshare --fork` leaves SIGINT/SIGTERM IGNORED in its child (and an async job ignores INT/QUIT), so the command is started through
    // `env --default-signal`. pid 1 of the run's pid namespace also ignores every signal it has no handler for, so the command must NOT be pid 1:
    // this shell stays pid 1, forwards TERM/INT/HUP to it (TTL, `run stop`, a hung-up session) and returns its status.
    'exec 3<&0',
    `env --default-signal=INT,TERM,QUIT,HUP unshare --user --map-user=${uid} --map-group=${gid} -- "$@" <&3 3<&- &`,
    'p=$!',
    'wait "$p"; rc=$?',
    'while kill -0 "$p" 2>/dev/null; do wait "$p"; rc=$?; done',
    'exit "$rc"',
  ].join('\n')
}
export const NETNS_MARKER = 'agr-netns'
/** slirp's alias for the host's loopback; also its default gateway. */
export const SLIRP_GATEWAY = '10.0.2.2'

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * IO. Every address the host itself answers on (all interfaces, v4 and v6, link-local included) plus its default gateways
 * (the Windows side of WSL can proxy to the real server too). `10.0.2.2` is added by the script itself.
 */
export function hostAddresses(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) { const a = i.address.split('%')[0]!; if (isIP(a)) out.add(a) }
  for (const args of [['route', 'show', 'default'], ['-6', 'route', 'show', 'default']]) {
    try {
      const text = spawnSync('ip', args, { encoding: 'utf8', timeout: 3000 }).stdout ?? ''
      for (const m of text.matchAll(/\bvia\s+(\S+)/g)) if (isIP(m[1]!)) out.add(m[1]!)
    } catch {}
  }
  out.delete('127.0.0.1'); out.delete('::1') // inside the namespace the loopback is the run's own
  return [...out]
}

/** Directories of the REAL data dir (and the real tmux dir) the run must not see: unix sockets of the real server. */
export function hiddenDirs(realDataDir: string, uid: number): string[] {
  return [join(realDataDir, 'run'), join(realDataDir, 'structured'), `/tmp/tmux-${uid}`].filter(d => { try { return statSync(d).isDirectory() } catch { return false } })
}

/**
 * PURE. The argv that runs `argv` inside the namespaces (user, net, mount, pid). `setpriv --pdeathsig` instead of `unshare --kill-child`:
 * util-linux 2.37's --kill-child leaves SIGTERM/SIGINT IGNORED in the child (measured: SigIgn 0x4002), so nothing in the run could be stopped.
 */
export function netnsArgv(argv: readonly string[], uid: number, gid: number, ports: readonly number[] = NETNS_BLOCKED_PORTS, hostAddrs: readonly string[] = [], hide: readonly string[] = []): string[] {
  return ['unshare', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--mount-proc', '--', 'env', '--default-signal=INT,TERM,QUIT,HUP', 'setpriv', '--pdeathsig', 'SIGKILL', 'sh', '-c', netnsInnerScript(uid, gid, ports, hostAddrs, hide), NETNS_MARKER, ...argv]
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
  return ['--configure', '--disable-host-loopback', '--enable-sandbox', '--enable-seccomp', '--exit-fd', '3', '--api-socket', apiSocket, String(pid), 'tap0']
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
    try { usernsWorks = spawnSync('unshare', ['--map-root-user', '--net', '--', 'sh', '-c', 'nft add table inet agprobe && env --default-signal=TERM true && setpriv --pdeathsig SIGKILL true'], { stdio: 'ignore', timeout: 5000 }).status === 0 } catch { usernsWorks = false }
  }
  return decideNetns({ noNetns, platform: process.platform, binaries, usernsWorks })
}

const nsOf = (pid: number): string | null => { try { return readlinkSync(`/proc/${pid}/ns/net`) } catch { return null } }
const readFileOr = (p: string): string => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const cmdlineOf = (pid: number): string => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return '' } }

/** Waits until `pid` has exec'd the inner script (so its namespace and uid map exist) and sits in a namespace other than ours. */
export async function waitForNetns(pid: number, alive: () => boolean = () => true, timeoutMs = 8000): Promise<boolean> {
  const mine = nsOf(process.pid)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && alive()) {
    const theirs = nsOf(pid)
    if (theirs && theirs !== mine && cmdlineOf(pid).includes(NETNS_MARKER) && readFileOr(`/proc/${pid}/uid_map`).trim()) return true
    await Bun.sleep(20)
  }
  return false
}

export type SlirpHandle = { pid: number; socket: string; child: ChildProcess }

/** Starts slirp4netns for the namespace of `pid`. Returns null (and why) when it did not come up. */
export async function startSlirp(pid: number, socket: string, alive: () => boolean = () => true): Promise<SlirpHandle | { error: string }> {
  if (!await waitForNetns(pid, alive)) return { error: alive() ? 'the run did not enter its network namespace' : 'the command ended before its network came up' }
  const child = spawn('slirp4netns', slirpArgv(pid, socket), { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
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
