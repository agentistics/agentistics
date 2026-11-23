import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, pruneStaleRuns, stateRoot, statePath, stopState } from './cli-run'
import { scopeNotice } from './cli-run'
import { BLOCKED_V4_RANGES, createCtlDir, decideNetns, hostBlockRules, newHostAddrs, pollHostAddresses, removeCtlDir, socketDirs, hiddenDirs, hostAddresses, inRanges, netnsHardening, socketCandidates, hostfwdRequests, NETNS_BLOCKED_PORTS, NETNS_MARKER, netnsArgv, netnsInnerScript, netnsNotice, slirpArgv, stopSlirp, type NetnsInputs } from './run-netns'

const OK: NetnsInputs = { noNetns: false, platform: 'linux', binaries: { unshare: true, setpriv: true, slirp4netns: true, nft: true, ip: true, sh: true }, usernsWorks: true }

describe('RUN.ISOLAMENTO-REDE: the launcher decision', () => {
  test('a capable Linux host isolates', () => expect(decideNetns(OK)).toEqual({ mode: 'netns' }))
  test('--no-netns opts out, deliberately, even on a capable host', () => {
    const d = decideNetns({ ...OK, noNetns: true })
    expect(d.mode).toBe('none')
    expect(d.mode === 'none' && d.deliberate).toBe(true)
  })
  test('macOS (any non-Linux) falls back and names the platform', () => {
    const d = decideNetns({ ...OK, platform: 'darwin' })
    expect(d.mode === 'none' && d.reason).toMatch(/Linux-only.*darwin/)
  })
  test.each(['unshare', 'setpriv', 'slirp4netns', 'nft', 'ip', 'sh'])('a missing %s falls back and names it', bin => {
    const d = decideNetns({ ...OK, binaries: { ...OK.binaries, [bin]: false } })
    expect(d.mode === 'none' && d.reason).toContain(bin)
  })
  test('user namespaces that did not work (or were never probed) fall back', () => {
    for (const usernsWorks of [false, null]) {
      const d = decideNetns({ ...OK, usernsWorks })
      expect(d.mode === 'none' && d.reason).toMatch(/user namespaces/)
    }
  })
  test('the fallback prints ONE line saying the network is not isolated and why; isolation prints nothing', () => {
    expect(netnsNotice({ mode: 'netns' })).toBeNull()
    const line = netnsNotice(decideNetns({ ...OK, platform: 'darwin' }))!
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toMatch(/NOT isolated/)
    expect(line).toMatch(/darwin/)
  })
  test('--no-netns parses and defaults to off', () => {
    expect((parseArgs(['--rm', '--no-netns', '--', 'true']) as { noNetns: boolean }).noNetns).toBe(true)
    expect((parseArgs(['--rm', '--', 'true']) as { noNetns: boolean }).noNetns).toBe(false)
  })
})

describe('RUN.ISOLAMENTO-REDE: the namespace argv and its script', () => {
  const argv = netnsArgv(['bun', 'test', 'a b'], 1000, 1001)
  test('new user (root-mapped), net, mount and pid namespaces (the real server\'s pid and sockets are not visible), then the command verbatim', () => {
    expect(argv.slice(0, 14)).toEqual(['unshare', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--mount-proc', '--', 'env', '--default-signal=INT,TERM,QUIT,HUP', 'setpriv', '--pdeathsig', 'SIGKILL', 'sh'])
    expect(argv.slice(-3)).toEqual(['bun', 'test', 'a b'])
    expect(argv).toContain(NETNS_MARKER)
  })
  const script = netnsInnerScript(1000, 1001)
  test('the real uid/gid are mapped back in a NESTED user namespace, so files stay owned by the user', () => {
    expect(script).toContain('env --default-signal=INT,TERM,QUIT,HUP unshare --user --map-user=1000 --map-group=1001 -- "$@"')
  })
  test('the firewall rejects BOTH real agentop ports and is installed before the command runs', () => {
    expect(NETNS_BLOCKED_PORTS).toEqual([47291, 47292])
    expect(script).toMatch(/tcp dport '\{ 47291, 47292 \}' reject with tcp reset/)
    expect(script.indexOf('nft add rule')).toBeLessThan(script.indexOf('unshare --user'))
  })
  test('a firewall that cannot be installed REFUSES to start the command instead of leaking', () => {
    expect(script).toMatch(/exit 126/)
  })
  test('the wait for tap0 asks `ip`, not /sys (sysfs still lists the OLD namespace and the wait would always time out)', () => {
    expect(script).toContain('ip link show tap0')
    expect(script).not.toContain('/sys/class/net')
  })
  test('loopback is brought up, after the wait for slirp tap0', () => {
    expect(script.indexOf('tap0')).toBeLessThan(script.indexOf('ip link set lo up'))
  })
  test('extra ports (a test seam) join the rule', () => expect(netnsInnerScript(1, 1, [47291, 47292, 50123])).toContain('47291, 47292, 50123'))
})

describe('RUN.ISOLAMENTO-REDE: slirp4netns and the --serve forwards', () => {
  test('the host loopback (10.0.2.2) is refused and the namespace of the given pid is configured', () => {
    const a = slirpArgv(4242, '/tmp/agr-x/s.sock')
    expect(a).toContain('--disable-host-loopback')
    expect(a).toContain('--configure')
    expect(a.slice(-2)).toEqual(['4242', 'tap0'])
  })
  test('only the run\'s own ports are forwarded, to the host loopback; never 47291/47292', () => {
    const reqs = hostfwdRequests([48100, 48101, 47291, 47292])
    expect(reqs.map(r => r.arguments.host_port)).toEqual([48100, 48101])
    for (const r of reqs) {
      expect(r.execute).toBe('add_hostfwd')
      expect(r.arguments.host_addr).toBe('127.0.0.1')
      expect(r.arguments.guest_port).toBe(r.arguments.host_port)
    }
    expect(hostfwdRequests([47291])).toEqual([])
  })
})

describe('RUN.ISOLAMENTO-REDE: the test seam can only ADD blocked ports', () => {
  test('extras are appended after the real ports, junk is ignored, the real ports can never be dropped', async () => {
    const { blockedPorts } = await import('./run-netns')
    expect(blockedPorts({})).toEqual([47291, 47292])
    expect(blockedPorts({ AGENTISTICS_RUN_NETNS_EXTRA_PORTS: '50123, x,0,99999,47291' })).toEqual([47291, 47292, 50123])
  })
})

describe('RUN.ISOLAMENTO-REDE r2: blocking BY DESTINATION (B1), hiding the real sockets (R1), no orphan slirp (R2)', () => {
  const addrs = ['172.23.255.165', '100.109.247.39', '10.255.255.254', 'fd7a:115c:a1e0::1501:f729', 'fe80::1']
  const script = netnsInnerScript(1000, 1001, NETNS_BLOCKED_PORTS, addrs, ['/h/.agentistics/run', "/tmp/tmux-1000"])
  test('whole private ranges AND the enumerated public host addresses are rejected on any port, per family, for NEW connections only', () => {
    // 172.23/100.109/10.255 are covered by their RANGE (an interval set refuses an overlapping single address); fe80::1 and fd7a are v6 ranges
    expect(script).toMatch(/ip daddr '\{ 0\.0\.0\.0\/8, 10\.0\.0\.0\/8, 100\.64\.0\.0\/10, 169\.254\.0\.0\/16, 172\.16\.0\.0\/12, 192\.0\.0\.0\/24, 192\.168\.0\.0\/16, 198\.18\.0\.0\/15, 224\.0\.0\.0\/4, 240\.0\.0\.0\/4 \}' ct state new meta l4proto tcp reject with tcp reset/)
    expect(script).toMatch(/ip6 daddr '\{ fc00::\/7, fe80::\/10, ff00::\/8 \}' ct state new meta l4proto tcp reject with tcp reset/)
    expect(script).toContain('udp dport != 53 reject')
    expect(script).toMatch(/l4proto != '\{ tcp, udp \}' drop/)
  })
  test('R1: an address created AFTER launch (docker bridge, compose net, VPN) falls in a blocked range even though it was never enumerated', () => {
    for (const a of ['172.31.250.1', '172.16.0.1', '172.17.0.1', '10.99.1.1', '192.168.200.5', '198.18.250.1', '198.19.255.255', '240.0.0.1', '192.0.0.8', '100.64.0.9', '100.127.255.1', '169.254.1.1', '10.0.2.2', '10.0.2.3'])
      expect(inRanges(a, BLOCKED_V4_RANGES)).toBe(true)
    for (const a of ['8.8.8.8', '172.15.255.255', '172.32.0.1', '192.167.1.1', '100.63.255.255', '100.128.0.1', '11.0.0.1']) expect(inRanges(a, BLOCKED_V4_RANGES)).toBe(false)
    expect(inRanges('fd7a:115c:a1e0::1', ['fc00::/7'])).toBe(true)
    expect(inRanges('fdff::1', ['fc00::/7'])).toBe(true)
    expect(inRanges('fe80::1', ['fe80::/10'])).toBe(true)
    expect(inRanges('febf::1', ['fe80::/10'])).toBe(true)
    expect(inRanges('fec0::1', ['fe80::/10'])).toBe(false)
    expect(inRanges('2001:db8::1', ['fc00::/7', 'fe80::/10'])).toBe(false)
  })
  test('a PUBLIC host address (not in any range) is still enumerated, and one a range covers is not repeated (nft refuses overlapping intervals)', () => {
    const s = netnsInnerScript(1, 1, NETNS_BLOCKED_PORTS, ['203.0.113.7', '172.23.0.5', '2001:db8::5'])
    expect(s).toMatch(/ip daddr '\{ [^}]*240\.0\.0\.0\/4, 203\.0\.113\.7 \}'/)
    expect(s).not.toContain('172.23.0.5')
    expect(s).toMatch(/ip6 daddr '\{ fc00::\/7, fe80::\/10, ff00::\/8, 2001:db8::5 \}'/)
  })
  test('the run\'s own slirp address is the one exception, and it comes before the reject rules', () => {
    expect(script.indexOf('ip daddr 10.0.2.100 accept')).toBeGreaterThan(-1)
    expect(script.indexOf('ip daddr 10.0.2.100 accept')).toBeLessThan(script.indexOf('reject with tcp reset'))
  })
  test('the 47291/47292 rule stays as a second layer, and every rule precedes the exec', () => {
    expect(script).toMatch(/tcp dport '\{ 47291, 47292 \}' reject with tcp reset/)
    expect(script.lastIndexOf('nft add rule')).toBeLessThan(script.indexOf('unshare --user'))
  })
  test('the table is `inet`, so one rule set covers v4 and v6', () => expect(script).toContain('nft add table inet agrun'))
  test('junk that is not an IP never reaches the shell script', () => {
    const s = netnsInnerScript(1, 1, NETNS_BLOCKED_PORTS, ['1.2.3.4; rm -rf /', '$(id)'])
    expect(s).not.toContain('rm -rf')
    expect(s).not.toContain('$(id)')
  })
  test('the hidden directories get an empty tmpfs, quoted, before the command runs; a failure refuses to start', () => {
    expect(script).toContain("mount -t tmpfs -o mode=0700 tmpfs '/h/.agentistics/run'")
    expect(script).toContain("mount -t tmpfs -o mode=0700 tmpfs '/tmp/tmux-1000'")
    expect(script.indexOf('mount -t tmpfs')).toBeLessThan(script.indexOf('unshare --user'))
    expect(script).toMatch(/\|\| \{ echo .*exit 126/)
  })
  test('hostAddresses lists this machine\'s own non-loopback addresses', () => {
    const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
    const got = hostAddresses()
    if (lan) expect(got).toContain(lan)
    expect(got).not.toContain('127.0.0.1')
    expect(got.every(a => isIP(a) !== 0)).toBe(true)
  })
  test('hiddenDirs keeps only the ones that exist', () => {
    const base = mkdtempSync(join(tmpdir(), 'hd-'))
    mkdirSync(join(base, 'run'))
    try { expect(hiddenDirs(base, 999999)).toEqual([join(base, 'run')]) } finally { rmSync(base, { recursive: true, force: true }) }
  })
  test('hiddenDirs names run/, structured/ AND the tmux dir when each exists (QA2/QA5: dropping any one must fail here)', () => {
    const base = mkdtempSync(join(tmpdir(), 'hd-'))
    const uid = 4200000 + (process.pid % 90000)
    const tmux = `/tmp/tmux-${uid}`
    mkdirSync(join(base, 'run')); mkdirSync(join(base, 'structured')); mkdirSync(tmux)
    try { expect(hiddenDirs(base, uid)).toEqual([join(base, 'run'), join(base, 'structured'), tmux]) }
    finally { rmSync(base, { recursive: true, force: true }); rmSync(tmux, { recursive: true, force: true }) }
  })
  test('hostAddresses includes the default gateway(s) (QA1: the Windows side of WSL can proxy to the real server)', () => {
    const text = Bun.spawnSync(['ip', 'route', 'show', 'default']).stdout.toString()
    const gws = [...text.matchAll(/\bvia\s+(\S+)/g)].map(m => m[1]!).filter(a => isIP(a) !== 0)
    const got = hostAddresses()
    for (const g of gws) expect(got).toContain(g)
  })
  test('B1: the whole user runtime dir (user D-Bus, systemd manager, cc-socks, gpg) becomes an empty tmpfs, and DBUS_SESSION_BUS_ADDRESS is unset before the command', () => {
    const rt = mkdtempSync(join(tmpdir(), 'rt-'))
    try {
      const { hide, hardening } = netnsHardening('/nonexistent-data-dir', process.getuid!(), '/nonexistent-home', { XDG_RUNTIME_DIR: rt })
      expect(hide).toContain(rt)
      const s = netnsInnerScript(1000, 1000, NETNS_BLOCKED_PORTS, [], hide, hardening)
      expect(s).toContain(`mount -t tmpfs -o mode=0700 tmpfs '${rt}'`)
      expect(s).toMatch(/unset [^\n]*DBUS_SESSION_BUS_ADDRESS/)
      expect(s.indexOf('unset ')).toBeLessThan(s.indexOf('unshare --user'))
    } finally { rmSync(rt, { recursive: true, force: true }) }
  })
  test('B2/R2: container-engine, system-bus and agent sockets are covered by /dev/null (connect then fails) and agent env vars are unset', () => {
    const { hardening } = netnsHardening('/nonexistent-data-dir', process.getuid!(), '/nonexistent-home', { XDG_RUNTIME_DIR: '/nonexistent-rt' })
    const s = netnsInnerScript(1000, 1000, NETNS_BLOCKED_PORTS, [], [], { blind: ['/run/docker.sock', '/run/dbus/system_bus_socket'], unsetEnv: hardening.unsetEnv })
    expect(s).toContain("mount --bind /dev/null '/run/docker.sock'")
    expect(s).toContain("mount --bind /dev/null '/run/dbus/system_bus_socket'")
    for (const v of ['SSH_AUTH_SOCK', 'DOCKER_HOST', 'DBUS_SESSION_BUS_ADDRESS']) expect(hardening.unsetEnv).toContain(v)
  })
  test('socketCandidates finds a real unix socket at the engine paths / agent dirs / the data dir, and nothing that is not a socket', () => {
    const base = mkdtempSync(join(tmpdir(), 'sc-'))
    mkdirSync(join(base, 'data', 'sub'), { recursive: true }); mkdirSync(join(base, 'home', '.gnupg'), { recursive: true })
    const sockA = join(base, 'data', 'sub', 'x.sock'), sockB = join(base, 'home', '.gnupg', 'S.gpg-agent'), sockC = join(base, 'agent.sock')
    const srv = [sockA, sockB, sockC].map(p => Bun.listen({ unix: p, socket: { open() {}, data() {}, close() {}, error() {} } }))
    writeFileSync(join(base, 'data', 'plain.sock'), 'not a socket')
    try {
      const got = socketCandidates(process.getuid!(), join(base, 'home'), join(base, 'data'), { SSH_AUTH_SOCK: sockC, XDG_RUNTIME_DIR: '/nonexistent-rt' })
      expect(got).toContain(sockA); expect(got).toContain(sockB); expect(got).toContain(sockC)
      expect(got).not.toContain(join(base, 'data', 'plain.sock'))
    } finally { for (const s of srv) s.stop(true); rmSync(base, { recursive: true, force: true }) }
  })
  test('R2: the real store dir is bound read-only BEFORE the hidden tmpfs go on top of its children', () => {
    const s = netnsInnerScript(1, 1, NETNS_BLOCKED_PORTS, [], ["/d/run"], { readOnly: ['/d'] })
    expect(s).toContain("mount --bind '/d' '/d' && mount -o remount,bind,ro '/d'")
    expect(s.indexOf("remount,bind,ro '/d'")).toBeLessThan(s.indexOf("tmpfs '/d/run'"))
  })
  test('netnsHardening covers the data dir read-only and does not bind a socket that a hidden dir already covers', () => {
    const base = mkdtempSync(join(tmpdir(), 'nh-'))
    mkdirSync(join(base, 'run'))
    const sock = join(base, 'run', 'runtime.sock')
    const srv = Bun.listen({ unix: sock, socket: { open() {}, data() {}, close() {}, error() {} } })
    try {
      const { hide, hardening } = netnsHardening(base, process.getuid!(), join(base, 'nohome'), { XDG_RUNTIME_DIR: '/nonexistent-rt' })
      expect(hardening.readOnly).toEqual([realpathSync(base)])
      expect(hide).toContain(realpathSync(join(base, 'run')))
      expect(hardening.blind).not.toContain(realpathSync(sock))
    } finally { srv.stop(true); rmSync(base, { recursive: true, force: true }) }
  })
  test('slirp dies with its launcher (--exit-fd on the pipe it is given as fd 3)', () => {
    const a = slirpArgv(1, '/s')
    expect(a.slice(a.indexOf('--exit-fd'), a.indexOf('--exit-fd') + 2)).toEqual(['--exit-fd', '3'])
  })

  const fakeSlirp = (): number => {
    const p = Bun.spawn(['bash', '-c', 'exec -a slirp4netns sleep 60'], { stdout: 'ignore', stderr: 'ignore' })
    return p.pid
  }
  const dead = async (pid: number) => { for (let i = 0; i < 50; i++) { try { if (/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return true } catch { return true } await Bun.sleep(40) }; return false }
  test('stopSlirp signals a slirp4netns and never a recycled pid (M6)', async () => {
    const other = Bun.spawn(['sleep', '60'], { stdout: 'ignore' })
    const slirp = fakeSlirp()
    await Bun.sleep(150)
    try {
      stopSlirp(other.pid)
      await Bun.sleep(200)
      expect(() => process.kill(other.pid, 0)).not.toThrow()
      stopSlirp(slirp)
      expect(await dead(slirp)).toBe(true)
    } finally { other.kill(); try { process.kill(slirp, 'SIGKILL') } catch {} }
  })
  test('pruning a dead run stops its slirp (R2.1), and stopState does too (M3)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prune-'))
    const oldHome = process.env.HOME
    process.env.HOME = root
    try {
      for (const mode of ['prune', 'stop'] as const) {
        const slirp = fakeSlirp()
        await Bun.sleep(150)
        const home = join(stateRoot(), `h-${mode}`)
        mkdirSync(home, { recursive: true })
        const state = { name: `r2-${mode}`, home, apiPort: 59010, webPort: 59011, startedAt: new Date().toISOString(), command: ['true'], pid: 2 ** 22 - 3, slirpPid: slirp }
        mkdirSync(stateRoot(), { recursive: true })
        writeFileSync(statePath(state.name), JSON.stringify(state))
        if (mode === 'prune') pruneStaleRuns(); else await stopState(state)
        expect(await dead(slirp)).toBe(true)
        try { process.kill(slirp, 'SIGKILL') } catch {}
      }
    } finally { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }) }
  })
})

describe('RUN.ISOLAMENTO-REDE r4: WSL interop (N1), socket DIRECTORIES (N2), new host addresses (N3), the slirp API (N4), the memory-cap notice (N5)', () => {
  test('N1: /run is replaced by an empty tmpfs (the interop socket, docker, dbus and the runtime dir go with it) before the command; WSL_INTEROP is unset; Windows dirs are hidden', () => {
    const base = mkdtempSync(join(tmpdir(), 'n1-'))
    mkdirSync(join(base, 'home'))
    try {
      const { hide, hardening } = netnsHardening('/nonexistent-data-dir', process.getuid!(), join(base, 'home'), { XDG_RUNTIME_DIR: '/nonexistent-rt' })
      expect(hardening.freshRun).toBe(true)
      expect(hardening.unsetEnv).toContain('WSL_INTEROP')
      const s = netnsInnerScript(1000, 1000, NETNS_BLOCKED_PORTS, [], hide, hardening)
      expect(s).toContain('mount -t tmpfs -o mode=0755 tmpfs /run')
      expect(s.indexOf('mount -t tmpfs -o mode=0755 tmpfs /run')).toBeLessThan(s.indexOf('unshare --user'))
      expect(s).toMatch(/unset [^\n]*WSL_INTEROP/)
      expect(s).toContain('umount -l "$T"')
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
  test('N1: the Windows system directories of every mounted drive are in the hidden list', () => {
    const mnt = mkdtempSync(join(tmpdir(), 'mnt-'))
    mkdirSync(join(mnt, 'c', 'Windows'), { recursive: true })
    try { expect(socketDirs(1000, '/nonexistent-home', '/nonexistent-tmp', mnt)).toContain(join(mnt, 'c', 'Windows')) } finally { rmSync(mnt, { recursive: true, force: true }) }
  })
  test('N1: a hidden directory under /run gets its mount point recreated after the replacement; resolver state is bound back', () => {
    const s = netnsInnerScript(1, 1, NETNS_BLOCKED_PORTS, [], ['/run/user/1000'], { freshRun: true, keepUnderRun: ['/run/systemd/resolve'] })
    expect(s).toContain("mkdir -p '/run/systemd/resolve' && mount --rbind \"$T\"'/systemd/resolve' '/run/systemd/resolve'")
    expect(s.indexOf("mkdir -p '/run/user/1000'")).toBeGreaterThan(s.indexOf('tmpfs /run'))
    expect(s.indexOf("mkdir -p '/run/user/1000'")).toBeLessThan(s.indexOf("tmpfs '/run/user/1000'"))
    expect(netnsInnerScript(1, 1, NETNS_BLOCKED_PORTS, [], [], { freshRun: true, keepUnderRun: ['/run/../etc'] })).not.toContain('/run/../etc')
  })
  test('N2: every /tmp/ssh-* directory (not only the agent in SSH_AUTH_SOCK), X/ICE, ~/.gnupg and ~/.ssh/agent are hidden as DIRECTORIES', () => {
    const base = mkdtempSync(join(tmpdir(), 'n2-'))
    const tmpRoot = join(base, 'tmp'), home = join(base, 'home')
    for (const d of [join(tmpRoot, 'ssh-AbCdEf'), join(tmpRoot, '.X11-unix'), join(tmpRoot, 'plain'), join(home, '.gnupg'), join(home, '.ssh', 'agent')]) mkdirSync(d, { recursive: true })
    try {
      const got = socketDirs(1000, home, tmpRoot, '/nonexistent-mnt')
      expect(got.sort()).toEqual([join(tmpRoot, 'ssh-AbCdEf'), join(tmpRoot, '.X11-unix'), join(home, '.gnupg'), join(home, '.ssh', 'agent')].sort())
      // mutant guard: with no SSH_AUTH_SOCK at all, the ssh-* directory is still hidden by netnsHardening
      const { hide } = netnsHardening('/nonexistent-data-dir', 1000, home, { XDG_RUNTIME_DIR: '/nonexistent-rt' }, [], tmpRoot)
      expect(hide).toContain(realpathSync(join(tmpRoot, 'ssh-AbCdEf')))
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
  test('N3: whole special-use ranges (benchmark 198.18/15, 240/4, multicast) are rejected, so a bridge there created later cannot be a way through', () => {
    for (const a of ['198.18.250.1', '198.19.0.1', '224.0.0.5', '240.0.0.1', '0.1.2.3']) expect(inRanges(a, BLOCKED_V4_RANGES)).toBe(true)
  })
  test('N3: a new host address outside every range gets reject rules for tcp/udp/other, per family, for NEW connections', () => {
    const r = hostBlockRules(['203.0.113.9', '2001:db8::9'])
    expect(r).toHaveLength(6)
    expect(r[0]).toBe('add rule inet agrun out ip daddr { 203.0.113.9 } ct state new meta l4proto tcp reject with tcp reset')
    expect(r.some(x => x.includes('ip6 daddr { 2001:db8::9 }') && x.includes('udp dport != 53 reject'))).toBe(true)
    expect(hostBlockRules(['not-an-ip; reboot'])).toEqual([])
  })
  test('N3: newHostAddrs skips loopback, ranges already blocked and addresses already ruled', () => {
    expect(newHostAddrs(['127.0.0.1', '::1', '10.1.1.1', '198.18.0.9', '203.0.113.9', '203.0.113.10', 'junk'], new Set(['203.0.113.10']))).toEqual(['203.0.113.9'])
  })
  test('N3: pollHostAddresses rules a NEW address once, inside the run\'s namespaces (nsenter -U -n), and retries one that failed', () => {
    const known = new Set<string>(['198.51.100.1'])
    let addrs = ['198.51.100.1']
    const calls: string[][] = []
    let ok = true
    const run = (argv: string[]) => { calls.push(argv); return ok }
    expect(pollHostAddresses(4242, known, () => addrs, run)).toEqual([])
    addrs = ['198.51.100.1', '203.0.113.9']
    ok = false
    expect(pollHostAddresses(4242, known, () => addrs, run)).toEqual([]); expect(known.has('203.0.113.9')).toBe(false)
    ok = true; calls.length = 0
    expect(pollHostAddresses(4242, known, () => addrs, run)).toEqual(['203.0.113.9'])
    expect(calls).toHaveLength(3)
    expect(calls[0]!.slice(0, 8)).toEqual(['nsenter', '-U', '--preserve-credentials', '-n', '-t', '4242', '--', 'nft'])
    expect(calls[0]!.join(' ')).toContain('daddr { 203.0.113.9 } ct state new meta l4proto tcp reject with tcp reset')
    calls.length = 0
    expect(pollHostAddresses(4242, known, () => addrs, run)).toEqual([]); expect(calls).toEqual([])
  })
  test('N4: the slirp API socket directory is inside the runtime dir (replaced by an empty tmpfs in the run) when there is one, and removal is guarded', () => {
    const rt = mkdtempSync(join(tmpdir(), 'rt-'))
    try {
      const { dir, covered } = createCtlDir(process.getuid!(), { XDG_RUNTIME_DIR: rt })
      expect(covered).toBe(true); expect(dir.startsWith(rt + '/agr-ctl-')).toBe(true)
      removeCtlDir('/etc'); removeCtlDir(join(rt, 'not-ctl')); removeCtlDir(`${rt}/../agr-ctl-x`)
      expect(existsSync(dir)).toBe(true)
      removeCtlDir(dir); expect(existsSync(dir)).toBe(false)
      const none = createCtlDir(process.getuid!(), { XDG_RUNTIME_DIR: '/nonexistent-rt' })
      expect(none.covered).toBe(false); expect(none.dir.startsWith('/tmp/agr-ctl-')).toBe(true); removeCtlDir(none.dir)
    } finally { rmSync(rt, { recursive: true, force: true }) }
  })
  test('N5: a scope that could not be created says the memory cap is off; nothing is said when there is no systemd or the scope works', () => {
    expect(scopeNotice('failed')).toMatch(/memory cap is OFF/)
    expect(scopeNotice('ok')).toBeNull(); expect(scopeNotice('absent')).toBeNull()
  })
})
