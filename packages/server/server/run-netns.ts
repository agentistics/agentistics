import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection, isIP } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
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

export type NetnsHardening = {
  /** Directories made read-only (a bind of themselves): the real store must not be writable from inside. */
  readOnly?: readonly string[]
  /** Socket files covered by /dev/null (connect then fails): container engines, agents. */
  blind?: readonly string[]
  /** Environment variables removed before the command runs (they point at the user bus / agents that are hidden). */
  unsetEnv?: readonly string[]
}

/**
 * Ranges rejected as a WHOLE (not a snapshot of the addresses that exist at launch): a docker bridge, a VPN or a compose network
 * created AFTER the launch lands in one of these, and a forwarder bound there would reach the real server through the NAT.
 */
export const BLOCKED_V4_RANGES: readonly string[] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']
export const BLOCKED_V6_RANGES: readonly string[] = ['fc00::/7', 'fe80::/10']

const v4ToInt = (a: string): number => a.split('.').reduce((n, o) => n * 256 + Number(o), 0)
function v6ToBig(a: string): bigint {
  const [head, tail = ''] = a.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const parts = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return parts.reduce((n, p) => (n << 16n) + BigInt(parseInt(p || '0', 16)), 0n)
}
/** PURE. Is `addr` inside one of the CIDR `ranges` (same family)? */
export function inRanges(addr: string, ranges: readonly string[]): boolean {
  const fam = isIP(addr)
  for (const r of ranges) {
    const [base, bitsText] = r.split('/') as [string, string]
    if (isIP(base) !== fam) continue
    const bits = Number(bitsText)
    if (fam === 4) { const sh = 32 - bits; if (v4ToInt(addr) >>> sh === v4ToInt(base) >>> sh) return true }
    else if (fam === 6) { const sh = BigInt(128 - bits); if (v6ToBig(addr) >> sh === v6ToBig(base) >> sh) return true }
  }
  return false
}

/**
 * PURE. The script run as the namespace's root: wait for slirp's tap0, bring lo up, install the firewall, then drop into a
 * nested user namespace mapped to the real uid and exec the command. No tap0 within ~10 s (slirp failed) is not fatal: the
 * run keeps its own loopback, which is the part that protects the real server.
 */
export function netnsInnerScript(uid: number, gid: number, ports: readonly number[] = NETNS_BLOCKED_PORTS, hostAddrs: readonly string[] = [], hide: readonly string[] = [], hardening: NetnsHardening = {}): string {
  const set = ports.join(', ')
  // Whole private / link-local ranges first; an enumerated host address only when no range already covers it (nft refuses overlapping intervals).
  const v4 = [...BLOCKED_V4_RANGES, ...new Set(hostAddrs.filter(a => isIP(a) === 4 && !inRanges(a, BLOCKED_V4_RANGES)))]
  const v6 = [...BLOCKED_V6_RANGES, ...new Set(hostAddrs.filter(a => isIP(a) === 6 && !inRanges(a, BLOCKED_V6_RANGES)))]
  const steps = ['nft add table inet agrun', `nft add chain inet agrun out '{ type filter hook output priority 0 ; policy accept ; }'`,
    // the run's own slirp address (its --serve server answering itself) is not "the host"
    `nft add rule inet agrun out ip daddr ${SLIRP_GUEST_ADDR} accept`]
  for (const [fam, list] of [['ip', v4], ['ip6', v6]] as const) {
    const l = `{ ${list.join(', ')} }`
    steps.push(`nft add rule inet agrun out ${fam} daddr '${l}' ct state new meta l4proto tcp reject with tcp reset`)
    steps.push(`nft add rule inet agrun out ${fam} daddr '${l}' ct state new meta l4proto udp udp dport != 53 reject`)
    steps.push(`nft add rule inet agrun out ${fam} daddr '${l}' ct state new meta l4proto != '{ tcp, udp }' drop`)
  }
  steps.push(`nft add rule inet agrun out tcp dport '{ ${set} }' reject with tcp reset`)
  // The real store read-only FIRST (a non-recursive bind would otherwise cover the tmpfs mounted below it).
  for (const d of hardening.readOnly ?? []) steps.push(`mount --bind ${shq(d)} ${shq(d)}`, `mount -o remount,bind,ro ${shq(d)}`)
  for (const d of hide) steps.push(`mount -t tmpfs -o mode=0700 tmpfs ${shq(d)}`)
  for (const f of hardening.blind ?? []) steps.push(`mount --bind /dev/null ${shq(f)}`)
  const unset = (hardening.unsetEnv ?? []).filter(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
  return [
    'i=0',
    'p=',  // a TERM during the setup (before the command exists) must end the run
    'trap \'if [ -n "$p" ]; then kill -TERM "$p" 2>/dev/null; else exit 143; fi\' TERM INT HUP',
    'while ! ip link show tap0 >/dev/null 2>&1 && [ "$i" -lt 200 ]; do i=$((i+1)); sleep 0.05; done',
    'ip link set lo up',
    `${steps.join(' && ')} || { echo "agentop run: could not install the network firewall; refusing to start" >&2; exit 126; }`,
    ...(unset.length ? [`unset ${unset.join(' ')}`] : []),
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

/** The hidden-directory list for the user's runtime dir: the whole `/run/user/<uid>` (user D-Bus, systemd manager, cc-socks, gpg) is replaced by an empty tmpfs. */
export function runtimeDirOf(uid: number, env: Record<string, string | undefined> = process.env): string | null {
  const d = env.XDG_RUNTIME_DIR || `/run/user/${uid}`
  try { return statSync(d).isDirectory() ? d : null } catch { return null }
}

/** Socket paths that are only ever a way OUT of the run: container engines (root on the host), the system bus, agents. */
export function socketCandidates(uid: number, home: string, dataDir: string, env: Record<string, string | undefined> = process.env): string[] {
  const out = ['/run/docker.sock', '/var/run/docker.sock', '/run/containerd/containerd.sock', '/run/podman/podman.sock', '/run/crio/crio.sock', '/run/dbus/system_bus_socket', '/run/systemd/private']
  const ls = (d: string): string[] => { try { return readdirSync(d).map(n => join(d, n)) } catch { return [] } }
  if (env.SSH_AUTH_SOCK) out.push(env.SSH_AUTH_SOCK)
  for (const d of ls('/tmp').filter(n => /\/ssh-[^/]+$/.test(n))) out.push(...ls(d).filter(n => /\/agent\./.test(n)))
  out.push(...ls(join(home, '.gnupg')).filter(n => /\/S\./.test(n)), ...ls(join(home, '.ssh', 'agent')))
  // any unix socket the real store keeps one or two levels down (the server's own, an agent's)
  for (const a of ls(dataDir)) { if (a.endsWith('.sock')) out.push(a); else for (const b of ls(a)) if (b.endsWith('.sock')) out.push(b) }
  // not under the tmpfs'd runtime dir (already empty there)
  const rt = runtimeDirOf(uid, env)
  return out.filter(f => { try { return statSync(f).isSocket() && !(rt && (f === rt || f.startsWith(rt + '/'))) } catch { return false } })
}

/** IO. Everything the inner script must cover besides the network: see NetnsHardening. Resolved to real paths, de-duplicated. */
export function netnsHardening(realDataDir: string, uid: number, home: string = homedir(), env: Record<string, string | undefined> = process.env): { hide: string[]; hardening: NetnsHardening } {
  const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }
  const hide = [...new Set([...hiddenDirs(realDataDir, uid), ...(runtimeDirOf(uid, env) ? [runtimeDirOf(uid, env)!] : [])].map(real))]
  const covered = (f: string): boolean => hide.some(h => f === h || f.startsWith(h + '/'))
  const blind = [...new Set(socketCandidates(uid, home, realDataDir, env).map(real))].filter(f => !covered(f))
  const readOnly = (() => { try { return statSync(realDataDir).isDirectory() ? [real(realDataDir)] : [] } catch { return [] } })()
  return { hide, hardening: { readOnly, blind, unsetEnv: ['DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'DOCKER_HOST'] } }
}

/**
 * PURE. The argv that runs `argv` inside the namespaces (user, net, mount, pid). `setpriv --pdeathsig` instead of `unshare --kill-child`:
 * util-linux 2.37's --kill-child leaves SIGTERM/SIGINT IGNORED in the child (measured: SigIgn 0x4002), so nothing in the run could be stopped.
 */
export function netnsArgv(argv: readonly string[], uid: number, gid: number, ports: readonly number[] = NETNS_BLOCKED_PORTS, hostAddrs: readonly string[] = [], hide: readonly string[] = [], hardening: NetnsHardening = {}): string[] {
  return ['unshare', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--mount-proc', '--', 'env', '--default-signal=INT,TERM,QUIT,HUP', 'setpriv', '--pdeathsig', 'SIGKILL', 'sh', '-c', netnsInnerScript(uid, gid, ports, hostAddrs, hide, hardening), NETNS_MARKER, ...argv]
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
