import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vaultRequestAllowed } from './vault/http'
import { REQUEST_TTL_MS, STALE_MS, STATE_MAX_BYTES, acceptReport, callSurfaceFrom, callView, dashboardRequest, handleStart, handleStateWrite, newNayCallStore, parseReport, requestStart, startStatus, type OriginCtx, type StartDeps } from './nay-call'

const surfaces = [
  { id: 'sparkle', placement: 'composer', icon: 'sparkles', label: { pt: 'a', en: 'a' } },
  { id: 'voice-call', placement: 'composer', icon: 'phone', label: { pt: 'Ligar', en: 'Call' } },
]
const surface = callSurfaceFrom(surfaces)
const T0 = 1_000_000
const deps = (over: Partial<StartDeps> = {}, now = T0): StartDeps => ({ verify: async () => null, roleOf: async () => undefined, now: () => now, dashboard: true, ...over })

describe('callSurfaceFrom', () => {
  test('the same surface the button picks: composer + phone; none without voice', () => {
    expect(surface?.id).toBe('voice-call')
    expect(callSurfaceFrom([])).toBeNull()
    expect(callSurfaceFrom([surfaces[0]!, { id: 'r', placement: 'rail', icon: 'phone', label: { pt: 'a', en: 'a' } }])).toBeNull()
  })
})

describe('parseReport / callView', () => {
  test('a malformed report is ignored', () => {
    expect(parseReport(null, T0)).toBeNull()
    expect(parseReport({ active: 'yes' }, T0)).toBeNull()
  })
  test('an idle report drops the session and timer; an active one keeps them', () => {
    expect(parseReport({ active: false, parked: true, sessionId: 's', since: 5 }, T0)).toMatchObject({ active: false, parked: false, sessionId: null, since: null })
    expect(parseReport({ active: true, parked: true, sessionId: 's', since: 5 }, T0)).toMatchObject({ active: true, parked: true, sessionId: 's', since: 5 })
  })
  test('no browser reporting is "unknown", never "no call"; a stale report expires', () => {
    const store = newNayCallStore()
    expect(callView(store, surface, T0)).toMatchObject({ available: true, browser: false, call: null })
    acceptReport(store, { active: true, parked: false, sessionId: 'nay-1', since: 7 }, T0)
    expect(callView(store, surface, T0 + 1000)).toMatchObject({ browser: true, call: { active: true, sessionId: 'nay-1', since: 7 } })
    expect(callView(store, surface, T0 + STALE_MS + 1)).toMatchObject({ browser: false, call: null })
  })
  test('without a voice surface the call is not available', () => {
    expect(callView(newNayCallStore(), null, T0).available).toBe(false)
  })
})

describe('requestStart', () => {
  const fresh = () => { const s = newNayCallStore(); acceptReport(s, { active: false }, T0); return s }

  test('the dashboard (no session field, browser provenance) can start; the next browser report collects it exactly once', async () => {
    const store = fresh()
    const out = await requestStart(store, surface, {}, deps())
    expect(out).toMatchObject({ ok: true, already: false })
    expect(callView(store, surface, T0).startRequested).toBe(true)
    expect(acceptReport(store, { active: false }, T0 + 100)).toEqual({ ok: true, start: true })
    expect(acceptReport(store, { active: false }, T0 + 200)).toEqual({ ok: true, start: false })
  })
  test('a request nobody collected in time is forgotten', async () => {
    const store = fresh()
    await requestStart(store, surface, {}, deps())
    expect(acceptReport(store, { active: false }, T0 + REQUEST_TTL_MS + 1)).toEqual({ ok: true, start: false })
  })
  test('a call already active is reported, not restarted', async () => {
    const store = newNayCallStore(); acceptReport(store, { active: true, parked: false, sessionId: 's' }, T0)
    expect(await requestStart(store, surface, {}, deps())).toMatchObject({ ok: true, already: true })
    expect(store.requestedAt).toBeNull()
  })
  test('refused with no voice, and with no browser open (never queued)', async () => {
    expect(await requestStart(fresh(), null, {}, deps())).toEqual({ ok: false, error: 'no_voice' })
    const empty = newNayCallStore()
    expect(await requestStart(empty, surface, {}, deps())).toEqual({ ok: false, error: 'no_browser' })
    expect(empty.requestedAt).toBeNull()
  })
  test('a session must prove itself and be a leader; a worker may not ring the owner', async () => {
    const body = { session: { id: 'm', token: 't' } }
    expect(await requestStart(fresh(), surface, body, deps())).toEqual({ ok: false, error: 'unverified_sender' })
    expect(await requestStart(fresh(), surface, body, deps({ verify: async () => 'm', roleOf: async () => 'worker' }))).toEqual({ ok: false, error: 'leader_only' })
    expect(await requestStart(fresh(), surface, body, deps({ verify: async () => 'm', roleOf: async () => 'leader' }))).toMatchObject({ ok: true })
  })
  test('no session field is NOT proof of being the person: a direct client without provenance is refused', async () => {
    const store = fresh()
    expect(await requestStart(store, surface, {}, deps({ dashboard: false }))).toEqual({ ok: false, error: 'unverified_sender' })
    expect(store.requestedAt).toBeNull()
  })
  test('a claimed session never falls back to the dashboard branch, even with browser headers', async () => {
    const store = fresh()
    const body = { session: { id: 'm', token: 'bad' } }
    expect(await requestStart(store, surface, body, deps({ dashboard: true }))).toEqual({ ok: false, error: 'unverified_sender' })
    expect(await requestStart(store, surface, body, deps({ dashboard: true, verify: async () => 'm', roleOf: async () => 'worker' }))).toEqual({ ok: false, error: 'leader_only' })
    expect(await requestStart(store, surface, { session: null }, deps({ dashboard: true }))).toMatchObject({ ok: false })
    expect(store.requestedAt).toBeNull()
  })
  test('a non-object body is a bad request, never read as {}', async () => {
    for (const b of [null, 'x', 5, [], undefined]) expect(await requestStart(fresh(), surface, b, deps())).toEqual({ ok: false, error: 'bad_request' })
    expect(startStatus({ ok: false, error: 'bad_request' })).toBe(400)
  })
  test('M2: a PARKED call is returned to (queued, collected once), like the button; an on-screen one is `already`', async () => {
    const parked = newNayCallStore(); acceptReport(parked, { active: true, parked: true, sessionId: 's', since: 1 }, T0)
    expect(await requestStart(parked, surface, {}, deps())).toMatchObject({ ok: true, already: false })
    expect(acceptReport(parked, { active: true, parked: true, sessionId: 's', since: 1 }, T0 + 100)).toEqual({ ok: true, start: true })
    expect(acceptReport(parked, { active: true, parked: true, sessionId: 's', since: 1 }, T0 + 200)).toEqual({ ok: true, start: false })
    const onScreen = newNayCallStore(); acceptReport(onScreen, { active: true, parked: false, sessionId: 's' }, T0)
    expect(await requestStart(onScreen, surface, {}, deps())).toMatchObject({ ok: true, already: true })
    expect(acceptReport(onScreen, { active: true, parked: false, sessionId: 's' }, T0 + 100)).toEqual({ ok: true, start: false })
  })
  test('status codes', () => {
    expect(startStatus({ ok: false, error: 'unverified_sender' })).toBe(401)
    expect(startStatus({ ok: false, error: 'leader_only' })).toBe(403)
    expect(startStatus({ ok: false, error: 'no_voice' })).toBe(409)
    expect(startStatus({ ok: false, error: 'bad_report' })).toBe(400)
  })
})

const ctx: OriginCtx = { host: 'localhost:47292', allowlist: [], dev: false }
const dash = { 'sec-fetch-site': 'same-origin' }
const req = (method: string, path: string, body: string | undefined, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:47292${path}`, { method, ...(body !== undefined ? { body } : {}), headers: { 'content-type': 'application/json', ...headers } })

describe('dashboardRequest (the vault predicate itself)', () => {
  const r = (headers: Record<string, string>, method = 'POST') => ({ method, headers: new Headers(headers) })
  const json = { 'content-type': 'application/json' }
  test('same-origin JSON counts; the Origin fallback only when Sec-Fetch-Site is absent', () => {
    expect(dashboardRequest(r({ ...json, 'sec-fetch-site': 'same-origin' }), ctx)).toBe(true)
    expect(dashboardRequest(r({ ...json, origin: 'http://localhost:47292' }), ctx)).toBe(true)
    expect(dashboardRequest(r({ ...json }), ctx)).toBe(false)
    expect(dashboardRequest(r({ ...json, origin: 'https://evil.example' }), ctx)).toBe(false)
  })
  test('same-site, cross-site (even with a matching Origin) and none are refused', () => {
    for (const site of ['same-site', 'cross-site', 'none']) {
      expect(dashboardRequest(r({ ...json, 'sec-fetch-site': site, origin: 'http://localhost:47292' }), ctx)).toBe(false)
    }
  })
  test('a missing or non-JSON Content-Type is refused', () => {
    expect(dashboardRequest(r({ 'sec-fetch-site': 'same-origin' }), ctx)).toBe(false)
    expect(dashboardRequest(r({ 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }), ctx)).toBe(false)
  })
  test('agrees with vaultRequestAllowed on every combination (no variant)', () => {
    const sites = [null, 'same-origin', 'same-site', 'cross-site', 'none']
    const origins = [null, 'http://localhost:47292', 'https://evil.example']
    const cts = [null, 'application/json', 'text/plain']
    for (const s of sites) for (const o of origins) for (const c of cts) {
      const h: Record<string, string> = {}
      if (s) h['sec-fetch-site'] = s
      if (o) h.origin = o
      if (c) h['content-type'] = c
      expect(dashboardRequest(r(h), ctx)).toBe(vaultRequestAllowed(r(h), ctx.host, { allowlist: ctx.allowlist, dev: ctx.dev }).ok)
    }
  })
})

describe('route handlers (real Requests)', () => {
  const live = () => { const s = newNayCallStore(); acceptReport(s, { active: false }, T0); return s }
  const base = { verify: async () => null, roleOf: async () => undefined, now: () => T0 } as Omit<StartDeps, 'dashboard'>

  test('H1: POST start with no proof and no browser provenance is refused (401), nothing queued', async () => {
    const store = live()
    const r = await handleStart(req('POST', '/api/nay-call/start', '{}'), store, surface, ctx, base)
    expect(r.status).toBe(401)
    expect(store.requestedAt).toBeNull()
  })
  test('H1: malformed JSON / non-object / oversized body → 400/413, never read as {}', async () => {
    const store = live()
    expect((await handleStart(req('POST', '/api/nay-call/start', '{nope', dash), store, surface, ctx, base)).status).toBe(400)
    expect((await handleStart(req('POST', '/api/nay-call/start', '[]', dash), store, surface, ctx, base)).status).toBe(400)
    expect((await handleStart(req('POST', '/api/nay-call/start', JSON.stringify({ pad: 'x'.repeat(5000) }), dash), store, surface, ctx, base)).status).toBe(413)
    expect(store.requestedAt).toBeNull()
  })
  test('H1: a worker session (verified, role worker) is 403; a bad token is 401; a leader is accepted', async () => {
    const body = JSON.stringify({ session: { id: 'm', token: 't' } })
    const store = live()
    expect((await handleStart(req('POST', '/api/nay-call/start', body), store, surface, ctx, { ...base, verify: async () => 'm', roleOf: async () => 'worker' })).status).toBe(403)
    expect((await handleStart(req('POST', '/api/nay-call/start', body), store, surface, ctx, base)).status).toBe(401)
    expect(store.requestedAt).toBeNull()
    expect((await handleStart(req('POST', '/api/nay-call/start', body), store, surface, ctx, { ...base, verify: async () => 'm', roleOf: async () => 'leader' })).status).toBe(200)
    expect(store.requestedAt).toBe(T0)
  })
  const refused: Array<Record<string, string>> = [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site', origin: 'http://localhost:47292' }, { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }]
  test('N1: start from same-site, cross-site+Origin, or without a JSON Content-Type is refused (401), nothing queued', async () => {
    for (const h of refused) {
      const store = live()
      const r = await handleStart(req('POST', '/api/nay-call/start', '{}', h), store, surface, ctx, base)
      expect(r.status).toBe(401)
      expect(store.requestedAt).toBeNull()
    }
  })
  test('N1: PUT state from same-site, cross-site+Origin, or text/plain is 403 and changes nothing', async () => {
    for (const h of refused) {
      const store = live()
      store.requestedAt = T0
      const r = await handleStateWrite(req('PUT', '/api/nay-call/state', JSON.stringify({ active: true, sessionId: 'x', since: 1 }), h), store, ctx, T0 + 10)
      expect(r.status).toBe(403)
      expect(store.requestedAt).toBe(T0)
      expect(store.report?.sessionId).toBeNull()
    }
  })
  test('the dashboard (same-origin) can start', async () => {
    const store = live()
    const r = await handleStart(req('POST', '/api/nay-call/start', '{}', dash), store, surface, ctx, base)
    expect(r.status).toBe(200)
    expect(store.requestedAt).toBe(T0)
  })
  test('M1: PUT state without browser provenance is 403 and changes nothing (cannot forge a call or steal a start)', async () => {
    const store = live()
    store.requestedAt = T0
    const forged = JSON.stringify({ active: true, sessionId: 'fake', since: 1 })
    const r = await handleStateWrite(req('PUT', '/api/nay-call/state', forged), store, ctx, T0 + 10)
    expect(r.status).toBe(403)
    expect(store.report?.sessionId).toBeNull()
    expect(store.requestedAt).toBe(T0)
    expect((await handleStateWrite(req('PUT', '/api/nay-call/state', JSON.stringify({ active: false }), { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }), store, ctx, T0 + 10)).status).toBe(403)
    expect(store.requestedAt).toBe(T0)
  })
  test('M1: PUT state from the dashboard works; bad shape → 400; over the byte limit → 413; malformed → 400', async () => {
    const store = newNayCallStore()
    const ok = await handleStateWrite(req('PUT', '/api/nay-call/state', JSON.stringify({ active: true, parked: false, sessionId: 'nay-1', since: 3 }), dash), store, ctx, T0)
    expect(ok).toEqual({ body: { ok: true, start: false }, status: 200 })
    expect(store.report?.sessionId).toBe('nay-1')
    expect((await handleStateWrite(req('PUT', '/api/nay-call/state', JSON.stringify({ active: 'yes' }), dash), store, ctx, T0)).status).toBe(400)
    expect((await handleStateWrite(req('PUT', '/api/nay-call/state', 'not json', dash), store, ctx, T0)).status).toBe(400)
    const big = await handleStateWrite(req('PUT', '/api/nay-call/state', JSON.stringify({ active: false, pad: 'x'.repeat(STATE_MAX_BYTES + 1) }), dash), store, ctx, T0)
    expect(big.status).toBe(413)
  })
})

describe('wiring', () => {
  const index = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
  const guard = readFileSync(join(import.meta.dir, 'capability-guard.ts'), 'utf8')
  test('the routes exist and ride the localShell guard (a central refuses them)', () => {
    for (const r of ["'/api/nay-call' && req.method === 'GET'", "'/api/nay-call/state' && req.method === 'PUT'", "'/api/nay-call/start' && req.method === 'POST'", 'nc.handleStateWrite(', 'nc.handleStart(']) expect(index).toContain(r)
    expect(guard).toContain("['/api/nay-call', 'localShell']")
  })
  test('the MCP tool is declared and policy-listed with the same routes', () => {
    const mcp = readFileSync(join(import.meta.dir, '../../mcp/agentistics-mcp.ts'), 'utf8')
    expect(mcp).toContain('name: "agentistics_nay_call"')
    expect(mcp).toContain('case "agentistics_nay_call"')
    expect(mcp).toContain('"/api/nay-call/start"')
    const policy = readFileSync(join(import.meta.dir, '../../core/src/agentToolPolicy.ts'), 'utf8')
    expect(policy).toContain("'GET /api/nay-call', 'POST /api/nay-call/start'")
  })
})
