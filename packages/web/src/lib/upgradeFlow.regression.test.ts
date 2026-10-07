/**
 * UPD.ANIM regressions: the animation restarted endlessly, never closed, and had to be clicked away.
 * Root causes (all pinned here): `useStageRefs` rebuilt its ref object every render (a dependency of the
 * scene effects, so every poll re-render recreated the scene); `UpdateFinale` reset its timers whenever its
 * `onDone` prop changed (a fresh arrow each render, so it never closed); `consumeRestore` left the snapshot
 * in place so every reload replayed the finale.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESTORE_KEY, encodeRestore } from './updateToast'
import { IDLE_FLOW, consumeRestore, dismissFlow, getFlow, resetFlow, setFlowForTest, startUpgrade } from './upgradeFlow'

const src = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8')

const store = new Map<string, string>()
let reloads = 0
let cachesCleared = 0
const real = { fetch: globalThis.fetch, window: (globalThis as any).window, sessionStorage: (globalThis as any).sessionStorage, caches: (globalThis as any).caches, navigator: (globalThis as any).navigator }

function install(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  store.clear(); reloads = 0; cachesCleared = 0
  ;(globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
  ;(globalThis as any).window = { location: { pathname: '/', search: '', hash: '', reload: () => { reloads++ } }, scrollY: 0 }
  ;(globalThis as any).caches = { keys: async () => ['c1'], delete: async () => { cachesCleared++; return true } }
  // The browser-side readiness probe asks for the current shell after /api/version. Keep that
  // pure-flow test seam explicit rather than making every fixture know about the document request.
  globalThis.fetch = (async (url, init) => url.toString().startsWith('/index.html') ? json({}) : fetchImpl(url.toString(), init)) as typeof fetch
}
beforeEach(() => resetFlow())
afterEach(() => {
  globalThis.fetch = real.fetch
  // Assigning `undefined` leaves the KEY behind, and other suites decide "is there a DOM" with
  // `'window' in globalThis` — so a missing original is deleted, not restored as undefined.
  for (const k of ['window', 'sessionStorage', 'caches'] as const) {
    if (real[k] === undefined) delete (globalThis as any)[k]; else (globalThis as any)[k] = real[k]
  }
  resetFlow()
})

const json = (o: unknown, ok = true) => new Response(JSON.stringify(o), { status: ok ? 200 : 500, headers: { 'content-type': 'application/json' } })

describe('the scene is created once per run, not once per render', () => {
  test('useStageRefs returns ONE object for the life of the component', () => {
    const s = src('components/UpdateStage.tsx')
    expect(s).toMatch(/export function useStageRefs\(\): StageRefs \{[\s\S]*useMemo\(/)
  })
  test('UpdateFinale keeps onDone in a ref: its timers do not depend on the callback identity', () => {
    const s = src('components/UpdateFinale.tsx')
    expect(s).toContain('doneRef.current()')
    expect(s).not.toMatch(/\}, \[onDone\]\)/)
  })
})

describe('the overlay cannot be dismissed from outside while the upgrade runs', () => {
  test('no outside-click or Escape handler on the overlay; dismissFlow ignores a running or arrived flow', () => {
    const s = src('components/UpgradeOverlay.tsx')
    expect(s).not.toMatch(/onClick=\{[^}]*dismissFlow[^}]*\}\s*\n?\s*style=\{\{ position: 'fixed'/)
    expect(s).not.toContain("'Escape'")
    expect(s).toContain('aria-modal="true"')
    for (const phase of ['running', 'arrived'] as const) {
      setFlowForTest({ ...IDLE_FLOW, phase, target: '2.0.0' })
      dismissFlow()
      expect(getFlow().phase).toBe(phase)
    }
    setFlowForTest({ ...IDLE_FLOW, phase: 'failed', target: '2.0.0' })
    dismissFlow()
    expect(getFlow().phase).toBe('idle')
  })
})

describe('one run: no restart loop; the server being down is part of it; arrival reloads once', () => {
  test('POST once; refused/unreachable server polls do not fail the run; the new version reloads exactly once and empties the caches', async () => {
    let posts = 0, polls = 0
    install(async (url, init) => {
      if (url.startsWith('/api/upgrade?') && init?.method === 'POST') { posts++; return json({ ok: true }) }
      if (url === '/api/version') {
        polls++
        if (polls === 1) return json({ current: '1.0.0' })       // the "before" read
        if (polls <= 4) throw new Error('ECONNREFUSED')          // the server restarting
        return json({ current: '2.0.0' })
      }
      if (url === '/api/upgrade/status') { if (polls <= 4) throw new Error('ECONNREFUSED'); return json({ progress: null }) }
      return json({}, false)
    })
    await startUpgrade('2.0.0', 'en')
    expect(posts).toBe(1)
    expect(reloads).toBe(1)
    expect(cachesCleared).toBeGreaterThan(0)
    expect(getFlow().phase).toBe('arrived')
    // pressing again while arrived/running is a no-op: no second POST
    await startUpgrade('2.0.0', 'en')
    expect(posts).toBe(1)
  }, 20000)

  test('a refusal is a clear failed state (with the server\'s sentence) — never a loop', async () => {
    install(async (url, init) => {
      if (init?.method === 'POST') return json({ ok: false, message: 'busy' }, false)
      return json({ current: '1.0.0' })
    })
    await startUpgrade('2.0.0', 'en')
    expect(getFlow()).toMatchObject({ phase: 'failed', message: 'busy' })
    expect(reloads).toBe(0)
  })
})

describe('the finale plays once', () => {
  test('consumeRestore reads the snapshot once and removes it', () => {
    install(async () => json({}))
    store.set(RESTORE_KEY, encodeRestore({ url: '/sessions/x', scrollY: 10, target: '2.0.0', from: '1.0.0', savedAt: Date.now() }))
    expect(consumeRestore('2.0.0')?.url).toBe('/sessions/x')
    expect(store.has(RESTORE_KEY)).toBe(false)
    expect(consumeRestore('2.0.0')).toBeNull()
  })
})

describe('Install on a version the server already runs restarts NOTHING (2026-10-04)', () => {
  test('a stale popup: the server already runs the target → no POST, caches cleared, one reload', async () => {
    const posts: string[] = []
    install(async (url, init) => {
      if (init?.method === 'POST') { posts.push(url); return json({ ok: true, started: true }) }
      return json({ current: '2.103.1' })
    })
    await startUpgrade('2.103.1', 'pt')
    expect(posts).toEqual([])
    expect(reloads).toBe(1)
    expect(cachesCleared).toBeGreaterThan(0)
    expect(getFlow().phase).toBe('idle')
  })
  test('the server answers `alreadyCurrent` → reload at once, no waiting for a restart', async () => {
    let versionAsks = 0
    install(async (_url, init) => {
      if (init?.method === 'POST') return json({ ok: true, alreadyCurrent: true, version: '2.103.1' })
      versionAsks++
      return json({ current: '2.103.0' })
    })
    await startUpgrade('2.103.1', 'en')
    expect(reloads).toBe(1)
    expect(versionAsks).toBe(1)
  })
})

describe('"the update did not finish" never shows beside the version it asked for', () => {
  test('a failed progress record while /api/version already reports the target -> arrived, not failed', async () => {
    let versionCalls = 0
    install(async (url: string) => {
      if (url.startsWith('/api/upgrade/status')) return json({ progress: { stage: 'failed', version: '9.9.9', at: Date.now() + 1000 } })
      if (url.startsWith('/api/upgrade')) return json({ ok: true })
      if (url.startsWith('/api/version')) return json({ current: ++versionCalls === 1 ? '9.9.8' : '9.9.9' })
      return json({})
    })
    await startUpgrade('9.9.9', 'en')
    expect(getFlow().phase).toBe('arrived')
    expect(reloads).toBe(1)
  })
})
