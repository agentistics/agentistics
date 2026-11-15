import { describe, expect, test } from 'bun:test'
import {
  FORBIDDEN_FLAGS, IDLE_PERSONAL_MS, IDLE_SESSION_MS, PSS_KILL_BYTES, PSS_TRIM_BYTES, RSS_FALLBACK_FACTOR,
  browserArgv, cmdlineMatches, descendants, idleExpired, isLoopbackHost, isProfileDir, memoryVerdict, ownerFromKey,
  ownerKey, parseSmapsRollup, planOrphanSweep, ppidFromStat, profileDirFor, scopeUnitName, scopeWrap, tabToTrim,
  urlBlockReason, validManagedId, type PidRecord,
} from './browser-spec'

const MB = 1024 ** 2

describe('argv', () => {
  test('headless shell gets --headless, full chrome gets --headless=new', () => {
    expect(browserArgv({ kind: 'headless-shell', profileDir: '/p' })[0]).toBe('--headless')
    expect(browserArgv({ kind: 'chrome', profileDir: '/p' })[0]).toBe('--headless=new')
    expect(browserArgv({ kind: 'chromium', profileDir: '/p' })[0]).toBe('--headless=new')
  })
  test('pipe, own profile, hardening flags, about:blank last; stable snapshot', () => {
    expect(browserArgv({ kind: 'headless-shell', profileDir: '/data/browser/sessions/abc' })).toEqual([
      '--headless', '--remote-debugging-pipe', '--user-data-dir=/data/browser/sessions/abc', '--no-first-run',
      '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--password-store=basic', '--use-mock-keychain', '--mute-audio',
      '--window-size=1280,800', '--js-flags=--max-old-space-size=384', '--renderer-process-limit=4', 'about:blank',
    ])
  })
  test('never a debugging port, never --remote-allow-origins; --no-sandbox only on request', () => {
    for (const kind of ['headless-shell', 'chromium', 'chrome'] as const) {
      for (const noSandbox of [false, true]) {
        const argv = browserArgv({ kind, profileDir: '/p', noSandbox })
        for (const f of FORBIDDEN_FLAGS) expect(argv.some(a => a.startsWith(f))).toBe(false)
        expect(argv.includes('--no-sandbox')).toBe(noSandbox)
      }
    }
  })
  test('the scope carries MemoryMax AND MemorySwapMax=0 (P6) and runs the browser in place', () => {
    const w = scopeWrap('/bin/chrome', ['--headless'], 'agentop-browser-x')
    expect(w.bin).toBe('systemd-run')
    expect(w.argv).toContain('MemoryMax=1200M')
    expect(w.argv).toContain('MemorySwapMax=0')
    expect(w.argv).toContain('--scope')
    expect(w.argv.slice(w.argv.indexOf('--') + 1)).toEqual(['/bin/chrome', '--headless'])
  })
  test('scope unit names are systemd-safe', () => {
    expect(scopeUnitName('s-a.b/c', 'ab:12')).toBe('agentop-browser-s-a_b_c-ab12')
  })
})

describe('owners and profile folders', () => {
  test('keys round-trip', () => {
    expect(ownerKey({ kind: 'personal' })).toBe('personal')
    expect(ownerKey({ kind: 'session', managedId: 'a1b2' })).toBe('s-a1b2')
    expect(ownerFromKey('s-a1b2')).toEqual({ kind: 'session', managedId: 'a1b2' })
    expect(ownerFromKey('s-../x')).toBeNull()
    expect(ownerFromKey('nope')).toBeNull()
  })
  test('a managed id can never escape the profile root', () => {
    for (const bad of ['', '../x', 'a/b', '..', '.hidden', 'a\0b', 'x'.repeat(65)]) expect(validManagedId(bad)).toBe(false)
    expect(() => profileDirFor('/r', { kind: 'session', managedId: '../etc' })).toThrow()
    expect(profileDirFor('/r/', { kind: 'session', managedId: 'agentop-3f5f' })).toBe('/r/sessions/agentop-3f5f')
    expect(profileDirFor('/r', { kind: 'personal' })).toBe('/r/personal')
  })
  test('isProfileDir accepts only folders profileDirFor would make', () => {
    expect(isProfileDir('/r', '/r/personal')).toBe(true)
    expect(isProfileDir('/r', '/r/sessions/abc')).toBe(true)
    expect(isProfileDir('/r', '/r/sessions/abc/def')).toBe(false)
    expect(isProfileDir('/r', '/r/sessions/..')).toBe(false)
    expect(isProfileDir('/r', '/r')).toBe(false)
    expect(isProfileDir('/r', '/home/me/.config/google-chrome')).toBe(false)
  })
})

describe('block rules', () => {
  const ctx = { agentisticsPorts: [47291, 47292], debugPorts: [9333] }
  test('dangerous schemes are refused', () => {
    for (const u of ['file:///etc/passwd', 'chrome://settings', 'chrome-extension://abc/x', 'devtools://devtools/x', 'view-source:https://a.b', 'chrome-untrusted://x']) {
      expect(urlBlockReason(u, ctx)).toBe('scheme')
    }
  })
  test('agentistics own ports refused on every loopback spelling', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '0.0.0.0', 'app.localhost', 'LOCALHOST', '[::ffff:127.0.0.1]', '2130706433', '0x7f000001']) {
      expect(urlBlockReason(`http://${host}:47291/api/data`, ctx)).toBe('agentistics-port')
      expect(urlBlockReason(`ws://${host}:47292/api/stream-mux`, ctx)).toBe('agentistics-port')
    }
  })
  test('the REAL ports are what count, not the defaults', () => {
    expect(urlBlockReason('http://localhost:47291/', { agentisticsPorts: [5000, 5001] })).toBeNull()
    expect(urlBlockReason('http://localhost:5001/', { agentisticsPorts: [5000, 5001] })).toBe('agentistics-port')
  })
  test('default ports are applied (http :80 when agentistics serves :80)', () => {
    expect(urlBlockReason('http://localhost/', { agentisticsPorts: [80] })).toBe('agentistics-port')
  })
  test('another browser debug port is refused', () => {
    expect(urlBlockReason('http://127.0.0.1:9333/json', ctx)).toBe('debug-port')
  })
  test('localhost on any other port and the public web are allowed', () => {
    expect(urlBlockReason('http://localhost:5173/login', ctx)).toBeNull()
    expect(urlBlockReason('https://example.com/', ctx)).toBeNull()
    expect(urlBlockReason('http://10.0.0.5:47291/', ctx)).toBeNull()
    expect(urlBlockReason('about:blank', ctx)).toBeNull()
  })
  test('garbage is invalid, not allowed', () => {
    expect(urlBlockReason('not a url', ctx)).toBe('invalid')
  })
  test('loopback detection', () => {
    expect(isLoopbackHost('example.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('128.0.0.1')).toBe(false)
  })
})

describe('idle', () => {
  const s = { kind: 'session', managedId: 'a' } as const
  const p = { kind: 'personal' } as const
  test('session: 10 min with nobody watching', () => {
    expect(idleExpired({ owner: s, viewers: 0, lastActivityMs: 0, now: IDLE_SESSION_MS - 1 })).toBe(false)
    expect(idleExpired({ owner: s, viewers: 0, lastActivityMs: 0, now: IDLE_SESSION_MS })).toBe(true)
  })
  test('personal: 20 min', () => {
    expect(idleExpired({ owner: p, viewers: 0, lastActivityMs: 0, now: IDLE_SESSION_MS })).toBe(false)
    expect(idleExpired({ owner: p, viewers: 0, lastActivityMs: 0, now: IDLE_PERSONAL_MS })).toBe(true)
  })
  test('never while somebody watches', () => {
    expect(idleExpired({ owner: s, viewers: 1, lastActivityMs: 0, now: 10 * IDLE_PERSONAL_MS })).toBe(false)
  })
})

describe('memory', () => {
  test('PSS thresholds 900 MB / 1.2 GB', () => {
    expect(memoryVerdict({ pss: 899 * MB, rss: 5000 * MB }).action).toBe('ok')
    expect(memoryVerdict({ pss: PSS_TRIM_BYTES, rss: null }).action).toBe('trim')
    expect(memoryVerdict({ pss: PSS_KILL_BYTES, rss: null })).toEqual({ action: 'kill', basis: 'pss', bytes: PSS_KILL_BYTES })
  })
  test('four heavy tabs (P2: 1045 MB RSS, 475 MB PSS) is fine', () => {
    expect(memoryVerdict({ pss: 475 * MB, rss: 1045 * MB }).action).toBe('ok')
  })
  test('RSS fallback is scaled and says so', () => {
    expect(memoryVerdict({ pss: null, rss: 1045 * MB })).toEqual({ action: 'ok', basis: 'rss', bytes: 1045 * MB })
    expect(memoryVerdict({ pss: null, rss: PSS_TRIM_BYTES * RSS_FALLBACK_FACTOR }).action).toBe('trim')
    expect(memoryVerdict({ pss: null, rss: PSS_KILL_BYTES * RSS_FALLBACK_FACTOR }).action).toBe('kill')
    expect(memoryVerdict({ pss: null, rss: null })).toEqual({ action: 'ok', basis: 'none', bytes: null })
  })
  test('trim closes the oldest inactive tab, never the active one', () => {
    const tabs = [{ targetId: 'a', lastActiveMs: 1 }, { targetId: 'b', lastActiveMs: 5 }, { targetId: 'c', lastActiveMs: 3 }]
    expect(tabToTrim(tabs, 'a')).toBe('c')
    expect(tabToTrim(tabs, 'c')).toBe('a')
    expect(tabToTrim([{ targetId: 'a', lastActiveMs: 1 }], 'a')).toBeNull()
  })
})

describe('/proc arithmetic', () => {
  test('ppid survives a comm with spaces and parens', () => {
    expect(ppidFromStat('123 (chrome (x) y) S 77 123 123 0')).toBe(77)
    expect(ppidFromStat('garbage')).toBeNull()
  })
  test('descendants walks the tree, cycle-safe', () => {
    const m = new Map([[2, 1], [3, 2], [4, 2], [5, 9], [6, 6]])
    expect(descendants(1, m).sort()).toEqual([1, 2, 3, 4])
    expect(descendants(6, m)).toEqual([6])
  })
  test('smaps_rollup parse', () => {
    expect(parseSmapsRollup('Rss:   2048 kB\nPss:    1024 kB\n')).toEqual({ rss: 2048 * 1024, pss: 1024 * 1024 })
    expect(parseSmapsRollup('')).toEqual({ rss: null, pss: null })
  })
})

describe('orphan sweep', () => {
  const root = '/d/browser'
  const rec = (key: string, pid: number, hostPid: number, dir = `${root}/sessions/${key.slice(2)}`): PidRecord =>
    ({ key, pid, profileDir: dir, hostPid, startedAt: 0 })
  const cmd = (dir: string) => ['/chrome', '--headless', `--user-data-dir=${dir}`, 'about:blank'].join('\0')

  test('a dead host\'s live browser is killed by its saved PID and its folder removed', () => {
    const r = rec('s-a', 500, 400)
    const plan = planOrphanSweep({
      root, records: [r], dirs: [r.profileDir], selfPid: 1,
      alive: (pid) => pid === 500, cmdline: (pid) => (pid === 500 ? cmd(r.profileDir) : null),
    })
    expect(plan.kill).toEqual([{ pid: 500, key: 's-a' }])
    expect(plan.removeDirs).toEqual([r.profileDir])
    expect(plan.dropKeys).toEqual(['s-a'])
  })
  test('a RECYCLED pid (cmdline does not name our profile) is never killed', () => {
    const r = rec('s-a', 500, 400)
    const plan = planOrphanSweep({
      root, records: [r], dirs: [], selfPid: 1,
      alive: () => true, cmdline: (pid) => (pid === 500 ? '/usr/bin/vim\0notes.txt' : null),
    })
    // host 400 "alive" with empty cmdline? cmdline(400) is null → treated as not a live host
    expect(plan.kill).toEqual([])
    expect(plan.removeDirs).toEqual([r.profileDir])
  })
  test('a prefix of our profile path is not a match', () => {
    expect(cmdlineMatches(cmd('/d/browser/sessions/ab'), '/d/browser/sessions/a')).toBe(false)
    expect(cmdlineMatches(cmd('/d/browser/sessions/a'), '/d/browser/sessions/a')).toBe(true)
  })
  test('Chrome\'s rewritten (space-joined) process title still matches, with boundaries', () => {
    const title = '/opt/google/chrome/chrome --headless=new --remote-debugging-pipe --user-data-dir=/d/browser/sessions/a --no-first-run about:blank\0'
    expect(cmdlineMatches(title, '/d/browser/sessions/a')).toBe(true)
    expect(cmdlineMatches(title, '/d/browser/sessions')).toBe(false)
    expect(cmdlineMatches('x--user-data-dir=/d/browser/sessions/a', '/d/browser/sessions/a')).toBe(false)
  })
  test('records of ANOTHER live agentop are left alone, folder included', () => {
    const r = rec('s-a', 500, 400)
    const plan = planOrphanSweep({
      root, records: [r], dirs: [r.profileDir], selfPid: 1,
      alive: () => true, cmdline: (pid) => (pid === 400 ? '/agentop\0server' : cmd(r.profileDir)),
    })
    expect(plan.kill).toEqual([])
    expect(plan.removeDirs).toEqual([])
    expect(plan.keptForOtherHost).toEqual(['s-a'])
  })
  test('this host\'s own live browsers are protected', () => {
    const r = rec('s-a', 500, 1)
    const plan = planOrphanSweep({
      root, records: [r], dirs: [r.profileDir], selfPid: 1, ownLiveDirs: new Set([r.profileDir]),
      alive: () => true, cmdline: () => cmd(r.profileDir),
    })
    expect(plan).toEqual({ kill: [], removeDirs: [], dropKeys: [], keptForOtherHost: [] })
  })
  test('unrecorded folders are removed; foreign paths never', () => {
    const plan = planOrphanSweep({
      root, records: [rec('s-x', 9, 400, '/home/me/.config/google-chrome')],
      dirs: [`${root}/sessions/stale`, `${root}/personal`, `${root}/sessions/../../etc`], selfPid: 1,
      alive: () => false, cmdline: () => null,
    })
    expect(plan.removeDirs.sort()).toEqual([`${root}/personal`, `${root}/sessions/stale`])
    expect(plan.dropKeys).toEqual(['s-x'])
  })
})
