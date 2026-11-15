/**
 * The `/api/browser/*` dispatcher and the gate, against a FAKE host (no Chromium). The real end-to-end —
 * a throwaway server driven over HTTP — is `browser-s2.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { browserAllowed, decideDriver } from './browser-gate'
import { browserRoute, type RouteDeps, type RouteHost } from './browser-web'
import type { ActionHost } from './browser-actions'
import type { BrowserOwner } from './browser-spec'

describe('browser-gate', () => {
  test('the profile is the security answer; the preference only narrows; absent reads as on', () => {
    expect(browserAllowed(true, undefined)).toBe(true)
    expect(browserAllowed(true, true)).toBe(true)
    expect(browserAllowed(true, false)).toBe(false)
    expect(browserAllowed(false, true)).toBe(false)
    expect(browserAllowed(false, undefined)).toBe(false)
  })

  test('a session route needs a verified id and drives THAT id; a personal route refuses any session identity', () => {
    expect(decideDriver({ route: 'session', carriesSession: true, verifiedId: null })).toMatchObject({ ok: false, error: 'unverified_session', status: 403 })
    expect(decideDriver({ route: 'session', carriesSession: true, verifiedId: 'abc' })).toEqual({ ok: true, owner: { kind: 'session', managedId: 'abc' } })
    expect(decideDriver({ route: 'personal', carriesSession: true, verifiedId: null })).toMatchObject({ ok: false, error: 'session_cannot_drive_personal' })
    expect(decideDriver({ route: 'personal', carriesSession: false, verifiedId: null })).toEqual({ ok: true, owner: { kind: 'personal' } })
  })
})

function fakeDeps(over: Partial<RouteDeps> = {}) {
  const live = new Set<string>()
  const started: string[] = []
  const stopped: string[] = []
  const ran: Array<{ key: string; args: any }> = []
  const keyOf = (o: BrowserOwner) => o.kind === 'personal' ? 'personal' : `s-${o.managedId}`
  const host: RouteHost = {
    start: async (o) => { const k = keyOf(o); started.push(k); live.add(k); return { ok: true, key: k, pid: 1, reused: false } },
    stop: async (k) => { stopped.push(k); live.delete(k) },
    actionHost: (k) => (live.has(k) ? ({ key: k } as unknown as ActionHost) : null),
    status: async () => ({ live: [...live] }),
  }
  const deps: RouteDeps = {
    host,
    verify: async (id, token) => (token === `good-${id}` ? String(id) : null),
    run: async (h, args) => { ran.push({ key: (h as any).key, args }); return { ok: true, action: args.action } },
    ...over,
  }
  return { deps, started, stopped, ran, live }
}

const proof = (id: string) => ({ id, token: `good-${id}` })

describe('browserRoute', () => {
  test('a verified session drives its own browser, started on the first call', async () => {
    const f = fakeDeps()
    const r = await browserRoute('POST', '/api/browser/session/navigate', { session: proof('aaa'), url: 'http://localhost:5173/' }, f.deps)
    expect(r).toEqual({ status: 200, body: { ok: true, action: 'navigate' } })
    expect(f.started).toEqual(['s-aaa'])
    expect(f.ran[0]).toEqual({ key: 's-aaa', args: { action: 'navigate', url: 'http://localhost:5173/' } })
  })

  test("another session's id in the body (owner/key/managedId) changes nothing: the proof decides", async () => {
    const f = fakeDeps()
    await browserRoute('POST', '/api/browser/session/click', { session: proof('aaa'), managedId: 'bbb', owner: { kind: 'session', managedId: 'bbb' }, key: 's-bbb', ref: 'e1' }, f.deps)
    expect(f.ran.map(r => r.key)).toEqual(['s-aaa'])
  })

  test('a forged or missing proof is refused before anything starts', async () => {
    const f = fakeDeps()
    for (const session of [undefined, null, { id: 'bbb', token: 'good-aaa' }, { id: 'aaa' }]) {
      const r = await browserRoute('POST', '/api/browser/session/navigate', { session, url: 'http://a/' }, f.deps)
      expect(r?.status).toBe(403)
      expect((r?.body as any).error).toBe('unverified_session')
    }
    expect(f.started).toEqual([])
  })

  test('the personal browser refuses a request carrying a session identity — even a valid one', async () => {
    const f = fakeDeps()
    const r = await browserRoute('POST', '/api/browser/personal/navigate', { session: proof('aaa'), url: 'http://a/' }, f.deps)
    expect(r).toMatchObject({ status: 403, body: { error: 'session_cannot_drive_personal' } })
    const ok = await browserRoute('POST', '/api/browser/personal/navigate', { url: 'http://a/' }, f.deps)
    expect(ok?.status).toBe(200)
    expect(f.ran.map(x => x.key)).toEqual(['personal'])
    expect((await browserRoute('POST', '/api/browser/personal/evaluate', { expression: '1' }, f.deps))?.status).toBe(404)
  })

  test('a session that ended gets no browser', async () => {
    const f = fakeDeps({ sessionLive: (id) => id !== 'dead' })
    const r = await browserRoute('POST', '/api/browser/session/navigate', { session: proof('dead'), url: 'http://a/' }, f.deps)
    expect(r).toMatchObject({ status: 403, body: { error: 'session_not_running' } })
    expect(f.started).toEqual([])
  })

  test('bad arguments are 400 with a sentence; unknown actions 404; wrong method 405; other paths null', async () => {
    const f = fakeDeps()
    expect(await browserRoute('POST', '/api/browser/session/click', { session: proof('a') }, f.deps)).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect((await browserRoute('POST', '/api/browser/session/rm_rf', { session: proof('a') }, f.deps))?.status).toBe(404)
    expect((await browserRoute('GET', '/api/browser/session/navigate', {}, f.deps))?.status).toBe(405)
    expect(await browserRoute('GET', '/api/browser/elsewhere', {}, f.deps)).toBeNull()
    expect(await browserRoute('POST', '/api/browser/session/../personal/navigate', {}, f.deps)).toBeNull()
    expect(f.started).toEqual([])
  })

  test('tabs on no browser does not start one; close stops only the caller', async () => {
    const f = fakeDeps()
    expect(await browserRoute('POST', '/api/browser/session/tabs', { session: proof('a') }, f.deps)).toEqual({ status: 200, body: { ok: true, live: false, tabs: [] } })
    expect(f.started).toEqual([])
    await browserRoute('POST', '/api/browser/session/navigate', { session: proof('a'), url: 'http://x/' }, f.deps)
    await browserRoute('POST', '/api/browser/session/navigate', { session: proof('b'), url: 'http://x/' }, f.deps)
    const c = await browserRoute('POST', '/api/browser/session/close', { session: proof('a') }, f.deps)
    expect((c?.body as any).closed).toBe(true)
    expect(f.stopped).toEqual(['s-a'])
    expect(f.live.has('s-b')).toBe(true)
  })

  test('a refused start is a 503/501 with the host sentence', async () => {
    const f = fakeDeps()
    f.deps.host.start = async () => ({ ok: false, reason: 'session-ceiling', sentence: 'busy' })
    const nav = { session: proof('a'), url: 'http://x/' }
    expect(await browserRoute('POST', '/api/browser/session/navigate', nav, f.deps)).toEqual({ status: 503, body: { ok: false, error: 'session-ceiling', sentence: 'busy' } })
    f.deps.host.start = async () => ({ ok: false, reason: 'no-executable', sentence: 'none' })
    expect((await browserRoute('POST', '/api/browser/session/navigate', nav, f.deps))?.status).toBe(501)
  })

  test('a READ with no browser open refuses in words and never starts one (QA S2 reservation 2)', async () => {
    const f = fakeDeps()
    for (const verb of ['snapshot', 'screenshot', 'wait_for']) {
      const r = await browserRoute('POST', `/api/browser/session/${verb}`, { session: proof('a'), ...(verb === 'wait_for' ? { text: 'x' } : {}) }, f.deps)
      expect(r?.status).toBe(200)
      expect(r?.body).toMatchObject({ ok: false, error: 'no_browser' })
    }
    expect(f.started).toEqual([])
    expect(f.ran).toEqual([])
    // with a browser open the same read runs
    await browserRoute('POST', '/api/browser/session/navigate', { session: proof('a'), url: 'http://x/' }, f.deps)
    expect((await browserRoute('POST', '/api/browser/session/snapshot', { session: proof('a') }, f.deps))?.body).toMatchObject({ ok: true })
  })

  test('the S3 hook: the gate sees every ACTION and no READ, and can answer instead', async () => {
    const seen: string[] = []
    const f = fakeDeps({ gate: async (_k, a) => { seen.push(a); return a === 'click' ? { proceed: false, result: { ok: false, error: 'held' } } : { proceed: true } } })
    await browserRoute('POST', '/api/browser/session/navigate', { session: proof('a'), url: 'http://x/' }, f.deps)
    await browserRoute('POST', '/api/browser/session/snapshot', { session: proof('a') }, f.deps)
    await browserRoute('POST', '/api/browser/session/tabs', { session: proof('a') }, f.deps)
    const held = await browserRoute('POST', '/api/browser/session/click', { session: proof('a'), ref: 'e1' }, f.deps)
    expect(seen).toEqual(['navigate', 'click'])
    expect(held?.body).toEqual({ ok: false, error: 'held' })
    expect(f.ran.map(r => r.args.action)).toEqual(['navigate', 'snapshot', 'tabs'])
  })

  test('status is a GET', async () => {
    const f = fakeDeps()
    expect(await browserRoute('GET', '/api/browser/status', undefined, f.deps)).toEqual({ status: 200, body: { live: [] } })
    expect((await browserRoute('POST', '/api/browser/status', {}, f.deps))?.status).toBe(405)
  })
})
