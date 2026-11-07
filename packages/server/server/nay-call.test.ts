import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REQUEST_TTL_MS, STALE_MS, acceptReport, callSurfaceFrom, callView, newNayCallStore, parseReport, requestStart, startStatus, type StartDeps } from './nay-call'

const surfaces = [
  { id: 'sparkle', placement: 'composer', icon: 'sparkles', label: { pt: 'a', en: 'a' } },
  { id: 'voice-call', placement: 'composer', icon: 'phone', label: { pt: 'Ligar', en: 'Call' } },
]
const surface = callSurfaceFrom(surfaces)
const T0 = 1_000_000
const deps = (over: Partial<StartDeps> = {}, now = T0): StartDeps => ({ verify: async () => null, roleOf: async () => undefined, now: () => now, ...over })

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

  test('the person (no session field) can start; the next browser report collects it exactly once', async () => {
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
  test('status codes', () => {
    expect(startStatus({ ok: false, error: 'unverified_sender' })).toBe(401)
    expect(startStatus({ ok: false, error: 'leader_only' })).toBe(403)
    expect(startStatus({ ok: false, error: 'no_voice' })).toBe(409)
    expect(startStatus({ ok: false, error: 'bad_report' })).toBe(400)
  })
})

describe('wiring', () => {
  const index = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
  const guard = readFileSync(join(import.meta.dir, 'capability-guard.ts'), 'utf8')
  test('the routes exist and ride the localShell guard (a central refuses them)', () => {
    for (const r of ["'/api/nay-call' && req.method === 'GET'", "'/api/nay-call/state' && req.method === 'PUT'", "'/api/nay-call/start' && req.method === 'POST'"]) expect(index).toContain(r)
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
