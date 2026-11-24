/**
 * BrowserHost driven by FAKE browsers (a PassThrough pair that speaks just enough CDP). The real
 * Chromium end-to-end lives in browser-host.integration.test.ts (opt-in, inside `agentop run --rm`).
 * The profile root is a real temp folder, so "the folder is gone" is checked on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { BrowserHost, type BrowserHostDeps, type ProcReader, type SpawnedBrowser } from './browser-host'
import { IDLE_SESSION_MS, PSS_KILL_BYTES, PSS_TRIM_BYTES } from './browser-spec'

const GB = 1024 ** 3

interface Fake { page: { url: string; title: string }; pid: number; argv: string[]; signals: string[]; exited: boolean; exit: () => void; closed: string[]; methods: string[]; emit: (ev: object) => void }

function makeEnv(opts: { mem?: number | null; dead?: (n: number) => boolean; sandboxFails?: boolean; scope?: boolean; escapeScope?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'browser-host-test-'))
  let clock = 1_000_000
  let nextPid = 5000
  const fakes: Fake[] = []
  const killed: Array<{ pid: number; sig: string }> = []
  const smaps = new Map<number, string>()
  const proc: ProcReader = {
    ppids: () => new Map(fakes.filter(f => !f.exited).map(f => [f.pid, 1])),
    smapsRollup: (pid) => smaps.get(pid) ?? null,
    cmdline: (pid) => {
      const f = fakes.find(x => x.pid === pid && !x.exited)
      if (f) return [ 'chrome', ...f.argv ].join('\0')
      return foreign.get(pid) ?? null
    },
    cgroup: (pid) => {
      const f = fakes.find(x => x.pid === pid)
      if (!f) return null
      const unit = f.argv.find(a => a.startsWith('--unit='))?.slice(7)
      return opts.escapeScope || !unit ? '0::/user.slice/app.slice/app-com.google.Chrome-1.scope\n' : `0::/user.slice/app.slice/${unit}.scope\n`
    },
  }
  const foreign = new Map<number, string>()
  const foreignAlive = new Set<number>()
  const deps: BrowserHostDeps = {
    root,
    bin: () => ({ found: true, path: '/fake/chrome-headless-shell', kind: 'headless-shell', source: 'env' }),
    memAvailable: async () => (opts.mem === undefined ? 8 * GB : opts.mem),
    now: () => clock,
    spawn: (_bin, argv) => {
      const n = fakes.length
      const out = new PassThrough()
      const inp = new PassThrough()
      let resolveExit!: () => void
      const exited = new Promise<void>((r) => { resolveExit = r })
      const fake: Fake = {
        page: { url: 'about:blank', title: '' }, pid: nextPid++, argv, signals: [], exited: false, closed: [], methods: [], emit: (ev) => { inp.write(JSON.stringify(ev) + '\0') },
        exit: () => { if (fake.exited) return; fake.exited = true; inp.end(); resolveExit() },
      }
      fakes.push(fake)
      const dead = opts.dead?.(n) || (opts.sandboxFails && !argv.includes('--no-sandbox'))
      if (dead) { setTimeout(() => fake.exit(), 5) }
      let targets = [{ targetId: 'T0', type: 'page', url: 'about:blank', title: '' }]
      let buf = ''
      out.on('data', (d: Buffer) => {
        buf += d.toString()
        let i: number
        while ((i = buf.indexOf('\0')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
          if (dead) continue
          fake.methods.push(msg.method + (msg.sessionId ? `@${msg.sessionId}` : ''))
          let result: any = {}
          if (msg.method === 'Target.getTargets') result = { targetInfos: targets }
          if (msg.method === 'Runtime.evaluate') result = { result: { value: fake.page } }
          if (msg.method === 'Target.createTarget') { const t = { targetId: `T${targets.length}`, type: 'page', url: msg.params.url, title: '' }; targets = [...targets, t]; result = { targetId: t.targetId } }
          if (msg.method === 'Target.closeTarget') { fake.closed.push(msg.params.targetId); targets = targets.filter(t => t.targetId !== msg.params.targetId); inp.write(JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: msg.params.targetId } }) + '\0') }
          inp.write(JSON.stringify({ id: msg.id, result }) + '\0')
        }
      })
      const sb: SpawnedBrowser = { pid: fake.pid, exited, hasExited: () => fake.exited, cdpOut: out, cdpIn: inp }
      return sb
    },
    kill: (pid, sig) => {
      if (sig === 0) {
        if (fakes.some(f => f.pid === pid && !f.exited) || foreignAlive.has(pid)) return
        const e: any = new Error('ESRCH'); e.code = 'ESRCH'; throw e
      }
      killed.push({ pid, sig: String(sig) })
      const f = fakes.find(x => x.pid === pid)
      if (f) { f.signals.push(String(sig)); f.exit(); return }
      if (foreignAlive.has(pid)) { foreignAlive.delete(pid); return }
      const e: any = new Error('ESRCH'); e.code = 'ESRCH'; throw e
    },
    proc,
    scopeWorks: () => opts.scope === true,
    agentisticsPorts: [47291, 47292],
    selfPid: 4242,
  }
  return {
    root, deps, fakes, killed, smaps, foreign, foreignAlive,
    advance: (ms: number) => { clock += ms },
    host: () => new BrowserHost(deps),
  }
}

const S = (id: string) => ({ kind: 'session', managedId: id } as const)
const records = (root: string) => { try { return JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8')) } catch { return [] } }

let env: ReturnType<typeof makeEnv>
afterEach(() => { rmSync(env.root, { recursive: true, force: true }) })

describe('start and stop by the saved PID', () => {
  beforeEach(() => { env = makeEnv() })
  test('start creates the profile and records the pid; stop SIGTERMs THAT pid and deletes the folder', async () => {
    const h = env.host()
    const r = await h.start(S('aaa'))
    expect(r).toMatchObject({ ok: true, key: 's-aaa', reused: false })
    const dir = join(env.root, 'sessions', 'aaa')
    expect(existsSync(dir)).toBe(true)
    expect(records(env.root)).toEqual([expect.objectContaining({ key: 's-aaa', pid: env.fakes[0]!.pid, profileDir: dir, hostPid: 4242 })])
    expect(env.fakes[0]!.argv).toContain(`--user-data-dir=${dir}`)
    await h.stop('s-aaa', 'requested')
    expect(env.killed).toEqual([{ pid: env.fakes[0]!.pid, sig: 'SIGTERM' }])
    expect(existsSync(dir)).toBe(false)
    expect(records(env.root)).toEqual([])
    expect((await h.status()).recentStops[0]).toMatchObject({ key: 's-aaa', reason: 'requested' })
  })
  test('S10 r3 F2b: status never carries a query string in lastAction.label', async () => {
    const h = env.host()
    await h.start(S('aaa'))
    h.actionHost('s-aaa')!.noteAction({ kind: 'navigate', label: 'https://shop.example/cart?token=abc#access_token=zzz', at: 1 })
    const live = (await h.status()).live.find(e => e.key === 's-aaa')!
    expect(live.lastAction?.label).toBe('https://shop.example/cart')
    expect(JSON.stringify(live)).not.toContain('token=')
  })
  test('S10 r3 F6: a tab the page navigated itself takes the page title once the frame stops loading (not the URL Chromium keeps)', async () => {
    const h = env.host()
    await h.start(S('aaa'))
    const fake = env.fakes[0]!
    fake.emit({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: { targetId: 'T0', type: 'page', url: 'http://x.example/docs', title: 'x.example/docs' }, waitingForDebugger: false } })
    await new Promise(r => setTimeout(r, 30))
    // a followed link: Chromium reports the URL as the title and never announces the real one
    fake.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'T0', type: 'page', url: 'http://x.example/loja', title: 'x.example/loja' } } })
    fake.page = { url: 'http://x.example/loja', title: 'Loja exemplo' }
    fake.emit({ method: 'Page.frameStoppedLoading', sessionId: 'S1', params: { frameId: 'T0' } })
    await new Promise(r => setTimeout(r, 60))
    const tab = (await h.status()).live.find(e => e.key === 's-aaa')!.tabs.find(x => x.targetId === 'T0')!
    expect(tab.title).toBe('Loja exemplo')
  })
  test('the same owner twice (even concurrently) is ONE browser', async () => {
    const h = env.host()
    const [a, b] = await Promise.all([h.start(S('x')), h.start(S('x'))])
    expect(env.fakes.length).toBe(1)
    expect(a.ok && b.ok && a.pid === b.pid).toBe(true)
    expect([a, b].filter(r => r.ok && r.reused).length).toBe(1)
    await h.stopAll()
  })
  test('a stale folder at the profile path is replaced by a fresh one', async () => {
    const dir = join(env.root, 'sessions', 'old')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Cookies'), 'secret')
    const h = env.host()
    await h.start(S('old'))
    expect(existsSync(join(dir, 'Cookies'))).toBe(false)
    await h.stopAll()
  })
  test('an invalid session id is refused before anything touches the disk', async () => {
    const h = env.host()
    expect(await h.start(S('../../etc'))).toMatchObject({ ok: false, reason: 'invalid-owner' })
    expect(env.fakes.length).toBe(0)
  })
})

describe('ceilings', () => {
  beforeEach(() => { env = makeEnv() })
  test('2 session + 1 personal; a third session is refused in words', async () => {
    const h = env.host()
    expect((await h.start(S('a'))).ok).toBe(true)
    expect((await h.start(S('b'))).ok).toBe(true)
    expect((await h.start({ kind: 'personal' })).ok).toBe(true)
    const third = await h.start(S('c'))
    expect(third).toMatchObject({ ok: false, reason: 'session-ceiling' })
    if (!third.ok) expect(third.sentence).toContain('busy')
    expect(env.fakes.length).toBe(3)
    await h.stopAll()
  })
  test('FIVE concurrent session starts: exactly two browsers', async () => {
    const h = env.host()
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => h.start(S(id))))
    expect(results.filter(r => r.ok).length).toBe(2)
    expect(env.fakes.length).toBe(2)
    expect((await h.status()).live.length).toBe(2)
    await h.stopAll()
  })
  test('an idle unwatched session browser is evicted to make room; a watched one never', async () => {
    const h = env.host()
    await h.start(S('a'))
    await h.start(S('b'))
    h.addViewer('s-b')
    env.advance(3 * 60_000)
    const r = await h.start(S('c'))
    expect(r).toMatchObject({ ok: true, evicted: 's-a' })
    expect(env.fakes[0]!.signals).toEqual(['SIGTERM'])
    expect(existsSync(join(env.root, 'sessions', 'a'))).toBe(false)
    expect((await h.status()).live.map(b => b.key).sort()).toEqual(['s-b', 's-c'])
    await h.stopAll()
  })
})

describe('admission by memory', () => {
  test('below 1.5 GB nothing is spawned', async () => {
    env = makeEnv({ mem: 1.4 * GB })
    const r = await env.host().start(S('a'))
    expect(r).toMatchObject({ ok: false, reason: 'low-memory' })
    expect(env.fakes.length).toBe(0)
    expect(existsSync(join(env.root, 'sessions', 'a'))).toBe(false)
  })
})

describe('the watcher', () => {
  beforeEach(() => { env = makeEnv() })
  test('idle 10 min with nobody watching → stopped; watched → kept', async () => {
    const h = env.host()
    await h.start(S('a'))
    await h.start(S('b'))
    h.addViewer('s-b')
    env.advance(IDLE_SESSION_MS)
    await h.tick()
    expect((await h.status()).live.map(b => b.key)).toEqual(['s-b'])
    expect((await h.status()).recentStops[0]).toMatchObject({ key: 's-a', reason: 'idle' })
    await h.stopAll()
  })
  test('an action resets the idle clock', async () => {
    const h = env.host()
    await h.start(S('a'))
    env.advance(IDLE_SESSION_MS - 1000)
    h.touch('s-a')
    env.advance(5000)
    await h.tick()
    expect((await h.status()).live.length).toBe(1)
    await h.stopAll()
  })
  test('PSS over 1.2 GB stops the browser', async () => {
    const h = env.host()
    await h.start(S('a'))
    env.smaps.set(env.fakes[0]!.pid, `Rss: ${PSS_KILL_BYTES / 1024 + 10} kB\nPss: ${PSS_KILL_BYTES / 1024} kB\n`)
    await h.tick()
    expect((await h.status()).live.length).toBe(0)
    expect((await h.status()).recentStops[0]).toMatchObject({ reason: 'memory' })
  })
  test('PSS over 900 MB closes the oldest inactive tab, never the active one', async () => {
    const h = env.host()
    await h.start(S('a'))
    await h.openTab('s-a', 'about:blank') // T1 becomes active; T0 is the old one
    env.smaps.set(env.fakes[0]!.pid, `Rss: 1 kB\nPss: ${PSS_TRIM_BYTES / 1024} kB\n`)
    await h.tick()
    expect(env.fakes[0]!.closed).toEqual(['T0'])
    expect((await h.status()).live.length).toBe(1)
    await h.stopAll()
  })
  test('high RSS with low PSS (shared pages) is NOT a reason to act', async () => {
    const h = env.host()
    await h.start(S('a'))
    env.smaps.set(env.fakes[0]!.pid, `Rss: ${2 * 1024 * 1024} kB\nPss: ${400 * 1024} kB\n`)
    await h.tick()
    expect((await h.status()).live[0]!.memory).toEqual({ basis: 'pss', bytes: 400 * 1024 * 1024, action: 'ok' })
    await h.stopAll()
  })
  test('a session that ended takes its browser with it', async () => {
    env.deps.sessionLive = (id) => (id === 'gone' ? false : undefined)
    const h = env.host()
    await h.start(S('gone'))
    await h.start(S('unknown'))
    await h.tick()
    expect((await h.status()).live.map(b => b.key)).toEqual(['s-unknown'])
    await h.stopAll()
  })
  test('a browser that dies on its own is cleaned up (folder + record)', async () => {
    const h = env.host()
    await h.start(S('a'))
    env.fakes[0]!.exit()
    await Bun.sleep(20)
    expect((await h.status()).live.length).toBe(0)
    expect(existsSync(join(env.root, 'sessions', 'a'))).toBe(false)
    expect(records(env.root)).toEqual([])
  })
})

describe('failures leave nothing behind', () => {
  test('a browser that never answers: no record, no folder, slot freed', async () => {
    env = makeEnv({ dead: () => true })
    const h = env.host()
    const r = await h.start(S('a'))
    expect(r).toMatchObject({ ok: false, reason: 'start-failed' })
    expect(existsSync(join(env.root, 'sessions', 'a'))).toBe(false)
    expect(records(env.root)).toEqual([])
    expect((await h.status()).live).toEqual([])
  })
  test('the sandboxed attempt dies → one retry with --no-sandbox, reported per browser', async () => {
    env = makeEnv({ sandboxFails: true })
    const h = env.host()
    const r = await h.start(S('a'))
    expect(r.ok).toBe(true)
    expect(env.fakes.length).toBe(2)
    expect(env.fakes[1]!.argv).toContain('--no-sandbox')
    expect((await h.status()).live[0]!.sandbox).toBe(false)
    await h.stopAll()
  })
  test('stopAll during a start never leaves a live orphan', async () => {
    env = makeEnv()
    const h = env.host()
    const p = h.start(S('a'))
    await Bun.sleep(0)
    await h.stopAll()
    await p
    await Bun.sleep(20)
    expect(env.fakes.every(f => f.exited)).toBe(true)
    expect((await h.status()).live).toEqual([])
    expect(existsSync(join(env.root, 'sessions', 'a'))).toBe(false)
  })
})

describe('the systemd memory scope is checked, never assumed', () => {
  test('held: the browser runs in our scope with MemoryMax + MemorySwapMax=0', async () => {
    env = makeEnv({ scope: true })
    const h = env.host()
    await h.start(S('a'))
    expect(env.fakes[0]!.argv).toContain('MemorySwapMax=0')
    expect((await h.status()).live[0]).toMatchObject({ scope: true, scopeEscaped: false })
    await h.stopAll()
  })
  test('escaped (full Chrome moves itself into its own scope): reported, not claimed', async () => {
    env = makeEnv({ scope: true, escapeScope: true })
    const h = env.host()
    await h.start(S('a'))
    expect((await h.status()).live[0]).toMatchObject({ scope: false, scopeEscaped: true })
    await h.stopAll()
  })
})

describe('orphan sweep', () => {
  test('kills a dead host\'s browser by saved PID (identity checked) and removes stray folders', async () => {
    env = makeEnv()
    const orphanDir = join(env.root, 'sessions', 'orphan')
    const strayDir = join(env.root, 'sessions', 'stray')
    const recycledDir = join(env.root, 'sessions', 'recycled')
    for (const d of [orphanDir, strayDir, recycledDir]) mkdirSync(d, { recursive: true })
    env.foreignAlive.add(7001); env.foreign.set(7001, ['chrome', `--user-data-dir=${orphanDir}`].join('\0'))
    env.foreignAlive.add(7002); env.foreign.set(7002, '/usr/bin/vim\0x')
    writeFileSync(join(env.root, 'pids.json'), JSON.stringify([
      { key: 's-orphan', pid: 7001, profileDir: orphanDir, hostPid: 999999, startedAt: 0 },
      { key: 's-recycled', pid: 7002, profileDir: recycledDir, hostPid: 999999, startedAt: 0 },
    ]))
    const h = env.host()
    const plan = await h.sweep()
    expect(plan.kill).toEqual([{ pid: 7001, key: 's-orphan' }])
    expect(env.killed).toEqual([{ pid: 7001, sig: 'SIGKILL' }])
    expect(env.foreignAlive.has(7002)).toBe(true) // the recycled pid was not touched
    for (const d of [orphanDir, strayDir, recycledDir]) expect(existsSync(d)).toBe(false)
    expect(records(env.root)).toEqual([])
    expect((await h.status()).lastSweep).toMatchObject({ killed: 1, removedDirs: 3 })
  })
  test('a sweep while browsers live never touches them', async () => {
    env = makeEnv()
    const h = env.host()
    await h.start(S('live'))
    const plan = await h.sweep()
    expect(plan.kill).toEqual([])
    expect(existsSync(join(env.root, 'sessions', 'live'))).toBe(true)
    expect(records(env.root).length).toBe(1)
    await h.stopAll()
  })
})

describe('navigate refuses blocked URLs before touching the browser', () => {
  test('agentistics ports and file: are refused', async () => {
    env = makeEnv()
    const h = env.host()
    await h.start(S('a'))
    expect(await h.navigate('s-a', 'http://127.0.0.1:47291/api/data')).toEqual({ ok: false, reason: 'blocked:agentistics-port' })
    expect(await h.navigate('s-a', 'file:///etc/passwd')).toEqual({ ok: false, reason: 'blocked:scheme' })
    expect(await h.openTab('s-a', 'chrome://settings')).toEqual({ ok: false, reason: 'blocked:scheme' })
    await h.stopAll()
  })
  test('tab ceiling for a session browser is 4', async () => {
    env = makeEnv()
    const h = env.host()
    await h.start(S('a'))
    for (let i = 0; i < 3; i++) expect((await h.openTab('s-a')).ok).toBe(true)
    expect(await h.openTab('s-a')).toEqual({ ok: false, reason: 'tab-ceiling' })
    await h.stopAll()
  })
})

describe('S2 fix 3: a popup past the tab ceiling is RESUMED before it is closed', () => {
  // Measured on a real Chromium (S2fix3-diag-1.log): a target auto-attached PAUSED (waitForDebuggerOnStart)
  // and closed before it ran left its opener's window.open waiting on it, so every later action on the
  // opener timed out. The popup must run once (nothing intercepted can load: Fetch is on) and only then go.
  test('runIfWaitingForDebugger on the popup session comes before closeTarget', async () => {
    env = makeEnv()
    const h = env.host()
    await h.start(S('a'))
    for (let i = 0; i < 3; i++) await h.openTab('s-a') // T0..T3 = 4 tabs, the session ceiling
    const f = env.fakes[0]!
    f.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'POP', type: 'page', url: '' } } })
    f.emit({ method: 'Target.attachedToTarget', params: { sessionId: 'S-POP', waitingForDebugger: true, targetInfo: { targetId: 'POP', type: 'page', url: '' } } })
    await new Promise(r => setTimeout(r, 150))
    const resume = f.methods.indexOf('Runtime.runIfWaitingForDebugger@S-POP')
    const close = f.closed.includes('POP') ? f.methods.findIndex(m => m === 'Target.closeTarget') : -1
    expect(resume).toBeGreaterThanOrEqual(0)
    expect(f.closed).toContain('POP')
    // The close that happened was the one after the resume (the only closeTarget of this test).
    expect(close).toBeGreaterThan(resume)
    await h.stopAll()
  })
  test('a popup that never attaches is still closed (safety timer)', async () => {
    env = makeEnv()
    const h = env.host()
    await h.start(S('a'))
    for (let i = 0; i < 3; i++) await h.openTab('s-a')
    const f = env.fakes[0]!
    f.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'GHOST', type: 'page', url: '' } } })
    await new Promise(r => setTimeout(r, 1800))
    expect(f.closed).toContain('GHOST')
    await h.stopAll()
  })
})

describe('S2: the S1 QA reservations, on the host', () => {
  test('(b) a live browser no record names (pids.json deleted) and whose host is gone is killed by the sweep', async () => {
    env = makeEnv()
    const first = env.host()
    await first.start(S('lost'))
    const pid = env.fakes[0]!.pid
    rmSync(join(env.root, 'pids.json'))
    const next = env.host() // a new server: no entries, no records
    const plan = await next.sweep()
    expect(plan.kill.map(k => k.pid)).toEqual([pid])
    expect(env.fakes[0]!.exited).toBe(true)
    expect(existsSync(join(env.root, 'sessions', 'lost'))).toBe(false)
  })

  test('(b) the sweep never kills a browser THIS host is running, records or not', async () => {
    env = makeEnv()
    const h = env.host()
    await h.start(S('mine'))
    rmSync(join(env.root, 'pids.json'))
    const plan = await h.sweep()
    expect(plan.kill).toEqual([])
    expect(env.fakes[0]!.exited).toBe(false)
    await h.stopAll()
  })

  test('(a) a record whose host pid was recycled by a `sleep` is swept; one held by a live agentop is kept', async () => {
    env = makeEnv()
    const dirA = join(env.root, 'sessions', 'recycled')
    const dirB = join(env.root, 'sessions', 'kept')
    mkdirSync(dirA, { recursive: true }); mkdirSync(dirB, { recursive: true })
    env.foreignAlive.add(777); env.foreign.set(777, 'sleep\x00600')
    env.foreignAlive.add(888); env.foreign.set(888, '/usr/local/bin/agentop\x00server')
    writeFileSync(join(env.root, 'pids.json'), JSON.stringify([
      { key: 's-recycled', pid: 990001, profileDir: dirA, hostPid: 777, startedAt: 1 },
      { key: 's-kept', pid: 990002, profileDir: dirB, hostPid: 888, startedAt: 1 },
    ]))
    const plan = await env.host().sweep()
    expect(plan.keptForOtherHost).toEqual(['s-kept'])
    expect(existsSync(dirA)).toBe(false)
    expect(existsSync(dirB)).toBe(true)
    expect(env.foreignAlive.has(777)).toBe(true) // the recycled pid itself is never touched
  })

  test('(c) status reports tab URLs as origin+path and a clean, capped title', async () => {
    env = makeEnv()
    const h = env.host()
    await h.start(S('st'))
    await h.openTab('s-st', `data:text/html,${'x'.repeat(10_000)}`)
    const st = await h.status()
    const urls = st.live[0]!.tabs.map(t => t.url)
    expect(urls).toContain('data:text/html')
    for (const u of urls) expect(u.length).toBeLessThanOrEqual(300)
    await h.stopAll()
  })
})

describe('S4c — a stopped browser\'s pipe fds are settled BEFORE the next browser can take their numbers', () => {
  test('stop() settles (forces the runtime to drop the stale fd handles) BEFORE it resolves — and a next start follows', async () => {
    env = makeEnv()
    const order: string[] = []
    env.deps.settleFds = async () => { order.push('settle') }
    const h = env.host()
    await h.start(S('fd1'))
    await h.stop('s-fd1', 'requested').then(() => order.push('stopped'))
    expect(order).toEqual(['settle', 'stopped'])
    expect(await h.start(S('fd1'))).toMatchObject({ ok: true })
    await h.stopAll()
  })
})

describe('S12 — status carries the ceilings, and Delete profiles refuses while a browser is live', () => {
  beforeEach(() => { env = makeEnv() })

  test('status states the PSS thresholds and how many profile folders are on disk', async () => {
    const h = env.host()
    mkdirSync(join(env.root, 'sessions', 'aaa'), { recursive: true })
    mkdirSync(join(env.root, 'personal'), { recursive: true })
    const st = await h.status()
    expect(st.memory.trimBytes).toBe(PSS_TRIM_BYTES)
    expect(st.memory.killBytes).toBe(PSS_KILL_BYTES)
    expect(st.profiles.count).toBe(2)
  })

  test('with no browser live, every profile folder goes and the count is reported', async () => {
    const h = env.host()
    mkdirSync(join(env.root, 'sessions', 'aaa'), { recursive: true })
    mkdirSync(join(env.root, 'sessions', 'bbb'), { recursive: true })
    mkdirSync(join(env.root, 'personal'), { recursive: true })
    expect(h.deleteProfiles()).toEqual({ ok: true, removed: 3 })
    expect(existsSync(join(env.root, 'sessions', 'aaa'))).toBe(false)
    expect(existsSync(join(env.root, 'personal'))).toBe(false)
    expect((await h.status()).profiles.count).toBe(0)
  })

  test('refused while a browser is live — and nothing on disk is touched', async () => {
    const h = env.host()
    const r = await h.start(S('aaa'))
    expect(r.ok).toBe(true)
    const r2 = h.deleteProfiles()
    expect(r2.ok).toBe(false)
    if (!r2.ok) { expect(r2.error).toBe('browser_live'); expect(r2.sentence.length).toBeGreaterThan(10) }
    expect(existsSync(join(env.root, 'sessions', 'aaa'))).toBe(true)
    await h.stop('s-aaa', 'requested').catch(() => {})
  })
})

// NAVEGADOR.FECHAR-MINIMIZAR — the person's browser: close forgets, minimize keeps, idle stop keeps the TAB LIST.
describe('personal browser: minimize, idle stop keeps the tab list, restore, close', () => {
  const P = { kind: 'personal' } as const
  const HOME = 'https://home.example/'
  beforeEach(() => { env = makeEnv() })

  test('opening with nothing open and nothing saved loads the default page', async () => {
    const h = env.host()
    const r = await h.openPersonal(HOME)
    expect(r).toMatchObject({ ok: true, restored: 0, home: true })
    expect(env.fakes[0]!.methods).toContain('Target.createTarget')
    // the starting about:blank tab becomes the default page — it is not left standing beside it
    expect(env.fakes[0]!.closed).toEqual(['T0'])
    await h.stopAll()
  })

  test('minimize keeps Chromium and its tabs running; reopening is the SAME browser (nothing restarted)', async () => {
    const h = env.host()
    await h.openPersonal(HOME)
    expect(h.minimize('personal')).toBe(true)
    expect((await h.status()).live[0]).toMatchObject({ key: 'personal', minimized: true })
    env.advance(5 * 60_000)
    await h.tick()
    expect(env.fakes.length).toBe(1)
    const r = await h.openPersonal(HOME)
    expect(r).toMatchObject({ ok: true, restored: 0, home: false, wasStopped: false })
    expect(env.fakes.length).toBe(1)
    expect((await h.status()).live[0]!.minimized).toBe(false)
    await h.stopAll()
  })

  test('a minimized browser idle for 30 min is stopped but its tab list is kept; reopening restores the tabs', async () => {
    const h = env.host()
    await h.start(P)
    await h.openTab('personal', 'https://a.example/')
    await h.openTab('personal', 'https://b.example/')
    h.minimize('personal')
    env.advance(29 * 60_000)
    await h.tick()
    expect((await h.status()).live.length).toBe(1)
    env.advance(2 * 60_000)
    await h.tick()
    const st = await h.status()
    expect(st.live.length).toBe(0)
    expect(st.recentStops[0]).toMatchObject({ key: 'personal', reason: 'idle' })
    expect(st.personalSaved).toEqual({ tabs: 2 })
    const r = await h.openPersonal(HOME)
    expect(r).toMatchObject({ ok: true, restored: 2, home: false, wasStopped: true })
    expect((await h.status()).personalSaved).toBeNull()
    expect(env.fakes.length).toBe(2)
    expect(env.fakes[1]!.methods.filter(m => m === 'Target.createTarget').length).toBe(2)
    expect(env.fakes[1]!.closed).toEqual(['T0'])
    await h.stopAll()
  })

  test('a browser nobody minimized that idles out keeps no tab list', async () => {
    const h = env.host()
    await h.start(P)
    await h.openTab('personal', 'https://a.example/')
    env.advance(21 * 60_000)
    await h.tick()
    expect((await h.status()).personalSaved).toBeNull()
  })

  test('close stops Chromium, deletes the profile and clears every tab (and a saved list)', async () => {
    const h = env.host()
    await h.start(P)
    await h.openTab('personal', 'https://a.example/')
    h.minimize('personal')
    await h.stop('personal', 'requested')
    expect((await h.status()).live.length).toBe(0)
    expect(existsSync(join(env.root, 'personal'))).toBe(false)
    const r = await h.openPersonal(HOME)
    expect(r).toMatchObject({ ok: true, restored: 0, home: true })
    await h.stopAll()
  })

  test('short on memory, a session browser start stops the MINIMIZED personal one first — and keeps its tab list', async () => {
    env = makeEnv({ mem: 1 * GB })
    const h = env.host()
    // personal started while memory was fine is simulated by a host with enough memory first
    const ok = makeEnv()
    const h2 = ok.host()
    await h2.start(P)
    await h2.openTab('personal', 'https://a.example/')
    h2.minimize('personal')
    ;(ok.deps as any).memAvailable = async () => 1 * GB
    const r = await h2.start(S('zzz'))
    expect(r).toMatchObject({ ok: true, evicted: 'personal' })
    expect((await h2.status()).personalSaved).toEqual({ tabs: 1 })
    await h2.stopAll()
    rmSync(ok.root, { recursive: true, force: true })
    void h
  })
})
