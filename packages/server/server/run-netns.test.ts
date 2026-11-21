import { describe, expect, test } from 'bun:test'
import { parseArgs } from './cli-run'
import { decideNetns, hostfwdRequests, NETNS_BLOCKED_PORTS, NETNS_MARKER, netnsArgv, netnsInnerScript, netnsNotice, slirpArgv, type NetnsInputs } from './run-netns'

const OK: NetnsInputs = { noNetns: false, platform: 'linux', binaries: { unshare: true, slirp4netns: true, nft: true, ip: true, sh: true }, usernsWorks: true }

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
  test.each(['unshare', 'slirp4netns', 'nft', 'ip', 'sh'])('a missing %s falls back and names it', bin => {
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
  test('a new user namespace mapped to root plus a new network namespace, then the command verbatim', () => {
    expect(argv.slice(0, 4)).toEqual(['unshare', '--map-root-user', '--net', '--'])
    expect(argv.slice(-3)).toEqual(['bun', 'test', 'a b'])
    expect(argv).toContain(NETNS_MARKER)
  })
  const script = netnsInnerScript(1000, 1001)
  test('the real uid/gid are mapped back in a NESTED user namespace, so files stay owned by the user', () => {
    expect(script).toContain('exec unshare --user --map-user=1000 --map-group=1001 -- "$@"')
  })
  test('the firewall rejects BOTH real agentop ports and is installed before the command runs', () => {
    expect(NETNS_BLOCKED_PORTS).toEqual([47291, 47292])
    expect(script).toMatch(/tcp dport '\{ 47291, 47292 \}' reject with tcp reset/)
    expect(script.indexOf('nft add rule')).toBeLessThan(script.indexOf('exec unshare'))
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
