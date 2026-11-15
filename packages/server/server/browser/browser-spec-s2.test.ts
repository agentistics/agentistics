/**
 * NAVEGADOR S2 additions to browser-spec.ts: DNS-aware block rules, this machine's own addresses, the
 * status sanitisers (S1 QA reservation c), the host identity in the sweep (reservation a) and orphans no
 * record names (reservation b).
 */
import { describe, expect, test } from 'bun:test'
import {
  hostStillOwns, isIpLiteral, isReaper, looksLikeAgentopHost, needsResolve, planOrphanSweep, planUnrecordedOrphans,
  profileDirInCmdline, resolvedBlockReason, startTimeFromStat, statusTitle, statusUrl, urlBlockReason,
  type PidRecord,
} from './browser-spec'

const ctx = { agentisticsPorts: [47291, 47292], debugPorts: [9333], selfAddresses: ['192.168.1.20', 'fe80::1'] }

describe('block rules — this machine, by any name', () => {
  test('the LAN address of this machine is this machine on the guarded ports', () => {
    expect(urlBlockReason('http://192.168.1.20:47291/api/data', ctx)).toBe('agentistics-port')
    expect(urlBlockReason('http://[fe80::1]:47292/', ctx)).toBe('agentistics-port')
    expect(urlBlockReason('http://192.168.1.20:5173/', ctx)).toBeNull()
    expect(urlBlockReason('http://192.168.1.21:47291/', ctx)).toBeNull()
  })

  test('a neighbour debug port is refused on every loopback spelling; other localhost ports are allowed', () => {
    for (const h of ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '0x7f000001', '2130706433', 'a.localhost']) {
      expect(urlBlockReason(`http://${h}:9333/json`, ctx)).toBe('debug-port')
      expect(urlBlockReason(`http://${h}:47291/`, ctx)).toBe('agentistics-port')
      expect(urlBlockReason(`http://${h}:5173/`, ctx)).toBeNull()
    }
    expect(urlBlockReason('ws://127.0.0.1:47291/api/fleet/input', ctx)).toBe('agentistics-port')
    expect(urlBlockReason('file:///etc/passwd', ctx)).toBe('scheme')
  })

  test('a NAME on a guarded port must be resolved; anything else is decided without DNS', () => {
    expect(needsResolve('http://localtest.me:47291/', ctx)).toBe(true)
    expect(needsResolve('http://127.0.0.1.nip.io:9333/', ctx)).toBe(true)
    expect(needsResolve('http://localtest.me:5173/', ctx)).toBe(false)
    expect(needsResolve('http://localhost:47291/', ctx)).toBe(false) // already blocked without DNS
    expect(needsResolve('http://10.0.0.5:47291/', ctx)).toBe(false) // an IP literal is never resolved
    expect(needsResolve('https://example.com/', ctx)).toBe(false)
    expect(needsResolve('not a url', ctx)).toBe(false)
  })

  test('resolved to loopback or to one of our addresses → blocked; elsewhere → allowed', () => {
    expect(resolvedBlockReason('http://localtest.me:47291/', ['127.0.0.1'], ctx)).toBe('agentistics-port')
    expect(resolvedBlockReason('http://evil.test:47292/', ['93.1.2.3', '::1'], ctx)).toBe('agentistics-port')
    expect(resolvedBlockReason('http://lan.test:9333/', ['192.168.1.20'], ctx)).toBe('debug-port')
    expect(resolvedBlockReason('http://remote.test:47291/', ['93.1.2.3'], ctx)).toBeNull()
    expect(resolvedBlockReason('http://localtest.me:47291/', [], ctx)).toBeNull()
  })

  test('isIpLiteral', () => {
    for (const h of ['127.0.0.1', '[::1]', '::1', '0x7f000001', '2130706433', '10.1']) expect(isIpLiteral(h)).toBe(true)
    for (const h of ['localhost', 'a.b', 'nip.io', '1.example']) expect(isIpLiteral(h)).toBe(false)
  })
})

describe('status sanitisers (QA reservation c)', () => {
  test('a data: URL is reduced to its media type, never its content', () => {
    const huge = `data:text/html;base64,${'A'.repeat(500_000)}`
    expect(statusUrl(huge)).toBe('data:text/html')
    expect(statusUrl('data:,hello')).toBe('data:')
    expect(statusUrl('DATA:image/PNG;base64,xx')).toBe('data:image/png')
  })
  test('http(s): origin + path only — no credentials, query or fragment; capped', () => {
    expect(statusUrl('https://user:pw@shop.test:8443/login?token=abc#x')).toBe('https://shop.test:8443/login')
    expect(statusUrl(`https://a.test/${'p'.repeat(1000)}`).length).toBe(300)
    expect(statusUrl('about:blank')).toBe('about:blank')
    expect(statusUrl('blob:https://a.test/1234-uuid')).toBe('blob:https://a.test')
    expect(statusUrl('javascript:alert(1)')).toBe('javascript:')
    expect(statusUrl('')).toBe('')
  })
  test('a title loses control and bidi characters and is capped at 120', () => {
    expect(statusTitle('Bank\u202e\u0007 login\n\nnow')).toBe('Bank login now')
    expect(statusTitle('x'.repeat(500))).toHaveLength(120)
  })
})

describe('the sweep and the host identity (QA reservation a)', () => {
  const root = '/data/browser'
  const rec = (o: Partial<PidRecord>): PidRecord => ({ key: 's-a', pid: 700, profileDir: `${root}/sessions/a`, hostPid: 600, startedAt: 1, ...o })
  const base = { selfPid: 1 }

  test('a recycled host pid (alive, different start time) no longer protects the record', () => {
    const r = rec({ hostStart: 111 })
    const alive = () => true
    expect(hostStillOwns(r, { ...base, alive, cmdline: () => 'bun\0index.ts', startTime: () => 111 })).toBe(true)
    expect(hostStillOwns(r, { ...base, alive, cmdline: () => 'bun\0index.ts', startTime: () => 999 })).toBe(false)
    expect(hostStillOwns(r, { ...base, alive, cmdline: () => 'bun', startTime: () => null })).toBe(false)
  })

  test('an older record without hostStart needs an agentop-looking cmdline (a `sleep` does not)', () => {
    const r = rec({})
    const alive = () => true
    expect(hostStillOwns(r, { ...base, alive, cmdline: () => 'sleep\x00600' })).toBe(false)
    expect(hostStillOwns(r, { ...base, alive, cmdline: () => '/usr/local/bin/agentop\x00server' })).toBe(true)
    expect(looksLikeAgentopHost('/home/u/.bun/bin/bun\x00run\x00x')).toBe(true)
    expect(looksLikeAgentopHost('bunny')).toBe(false)
  })

  test('planOrphanSweep: a recycled host pid → the folder is removed and the browser (if ours) is killed', () => {
    const r = rec({ hostStart: 5 })
    const plan = planOrphanSweep({
      root, records: [r], dirs: [r.profileDir], selfPid: 1,
      alive: () => true,
      cmdline: (pid) => pid === 600 ? 'sleep\x00600' : `chrome\x00--user-data-dir=${r.profileDir}`,
      startTime: (pid) => pid === 600 ? 77 : 1,
    })
    expect(plan.keptForOtherHost).toEqual([])
    expect(plan.kill).toEqual([{ pid: 700, key: 's-a' }])
    expect(plan.removeDirs).toEqual([r.profileDir])
  })

  test('startTimeFromStat reads field 22 even when comm has spaces and parentheses', () => {
    const stat = '1234 (my (weird) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10'
    expect(startTimeFromStat(stat)).toBe(987654)
    expect(startTimeFromStat('garbage')).toBeNull()
  })
})

describe('orphans no record names (QA reservation b)', () => {
  const root = '/data/browser'
  const dir = `${root}/sessions/abc`
  const main = (pid: number, ppid: number, d = dir) => ({ pid, ppid, cmd: `chrome\x00--headless\x00--user-data-dir=${d}\x00about:blank` })

  test('a main browser re-parented to a reaper is killed; its helpers are not separately targeted', () => {
    const procs = [
      { pid: 1, ppid: 0, cmd: '/sbin/init' },
      main(800, 1),
      { pid: 801, ppid: 800, cmd: `chrome\x00--type=renderer\x00--user-data-dir=${dir}` },
    ]
    expect(planUnrecordedOrphans({ root, procs, selfPid: 5, protectedDirs: new Set() }).kill).toEqual([{ pid: 800, dir }])
  })

  test('a parent that is gone counts as orphaned; a live non-reaper parent (another host) is left alone', () => {
    expect(planUnrecordedOrphans({ root, procs: [main(800, 4444)], selfPid: 5, protectedDirs: new Set() }).kill).toHaveLength(1)
    const other = [{ pid: 4444, ppid: 1, cmd: 'bun\x00index.ts' }, main(800, 4444)]
    expect(planUnrecordedOrphans({ root, procs: other, selfPid: 5, protectedDirs: new Set() }).kill).toEqual([])
  })

  test('our own children, protected folders, foreign profiles and look-alike paths are never touched', () => {
    const procs = [
      { pid: 1, ppid: 0, cmd: 'systemd' },
      main(810, 5),
      main(820, 1, `${root}/personal`),
      { pid: 830, ppid: 1, cmd: 'chrome\x00--user-data-dir=/home/u/.config/google-chrome' },
      { pid: 840, ppid: 1, cmd: `chrome\x00--user-data-dir=${root}/sessions/../../etc` },
      { pid: 850, ppid: 1, cmd: `chrome\x00--user-data-dir=${dir}x/y` },
    ]
    const plan = planUnrecordedOrphans({ root, procs, selfPid: 5, protectedDirs: new Set([`${root}/personal`]) })
    expect(plan.kill).toEqual([])
  })

  test('profileDirInCmdline and isReaper', () => {
    expect(profileDirInCmdline(`google-chrome --user-data-dir=${dir} --x`, root)).toBe(dir)
    expect(profileDirInCmdline(`x --user-data-dir=${dir}`, '/other')).toBeNull()
    expect(isReaper(1, null)).toBe(true)
    expect(isReaper(77, '/lib/systemd/systemd\x00--user')).toBe(true)
    expect(isReaper(77, 'bun\x00index.ts')).toBe(false)
  })
})
