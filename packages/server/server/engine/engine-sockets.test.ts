import { afterEach, describe, expect, it } from 'bun:test'
import { ENGINE_SOCKET_LIMITS, type EngineSocketHandlers } from '@agentistics/engine-api'
import { wsInputOriginOk } from '../sessions/input-protocol'
import { routeCapability, capabilityDenied } from '../capability-guard'
import { capabilitiesFor } from '../exposure'
import { hostGate, buildHostAllowlist } from '../host-allow'
import { AUTH_PUBLIC } from '../index-routes'
import {
  CLOSE, admit, closeAllEngineSockets, closeEngineSocket, engineSocketCount, onEngineSocketMessage, openEngineSocket,
  planEngineUpgrade, resetEngineSocketsForTests, surfaceSockets, sweepEndedSessions, type EngineSocketState, type RawSocket,
} from './engine-sockets'

afterEach(() => resetEngineSocketsForTests())

function raw(): RawSocket & { closed: [number | undefined, string | undefined][]; sent: unknown[] } {
  const r = { closed: [] as [number | undefined, string | undefined][], sent: [] as unknown[], send(d: unknown) { r.sent.push(d) }, close(c?: number, why?: string) { r.closed.push([c, why]) } }
  return r
}
function open(route: string, h: Partial<EngineSocketHandlers> & { got?: unknown[] } = {}): { st: EngineSocketState; r: ReturnType<typeof raw> } {
  const got: unknown[] = h.got ?? []
  const st: EngineSocketState = { route, handlers: { message: (_s, d) => { got.push(d) }, ...h }, entry: null }
  const r = raw()
  openEngineSocket(st, r)
  return { st, r }
}

describe('the handshake gates in front of an engine socket', () => {
  const list = buildHostAllowlist({ hostname: 'h', interfaceAddresses: ['127.0.0.1'], ports: [47291, 47292], allowedOrigins: [], secureOrigin: null })
  const local = capabilitiesFor('local', { central: false, exposure: undefined, allowLocalShell: false, tls: false })
  const exposed = capabilitiesFor('public', { central: true, exposure: 'public', allowLocalShell: false, tls: true })

  it('the prefix is localShell, authenticated, and refused on an exposed profile', () => {
    expect(routeCapability('/api/engine/x/ws/demo')).toBe('localShell')
    expect(capabilityDenied('localShell', exposed)?.status).toBe(403)
    expect(AUTH_PUBLIC.has('/api/engine/x')).toBe(false)
  })
  it('a rebinding Host is refused (421) before anything else', () => {
    expect(hostGate('/api/engine/x/ws/demo', 'evil.example:47291', list, local)?.status).toBe(421)
    expect(hostGate('/api/engine/x/ws/demo', '127.0.0.1:47291', list, local)).toBeNull()
  })
  it('a foreign Origin is refused and the engine is never asked', () => {
    const originOk = wsInputOriginOk({ origin: 'http://evil.example', host: '127.0.0.1:47291', allowlist: [], dev: false })
    expect(originOk).toBe(false)
    expect(planEngineUpgrade({ routeCanUpgrade: true, originOk, handlers: null, sessionExists: true, admission: { ok: true } }))
      .toEqual({ status: 403, error: 'forbidden_origin' })
  })
  it('refuses a route that cannot upgrade, a null answer and an unknown session', () => {
    const ok = { originOk: true, sessionExists: true, admission: { ok: true } as const }
    const h: EngineSocketHandlers = { message() {} }
    expect(planEngineUpgrade({ ...ok, routeCanUpgrade: false, handlers: h })?.status).toBe(404)
    expect(planEngineUpgrade({ ...ok, routeCanUpgrade: true, handlers: null })?.status).toBe(404)
    expect(planEngineUpgrade({ ...ok, routeCanUpgrade: true, handlers: { ...h, sessionId: 's1' }, sessionExists: false })?.status).toBe(404)
    expect(planEngineUpgrade({ ...ok, routeCanUpgrade: true, handlers: h })).toBeNull()
  })
})

describe('limits', () => {
  it('closes a frame over the cap, and lets an engine only narrow it', () => {
    const got: unknown[] = []
    const { st, r } = open('/api/engine/x', { got })
    onEngineSocketMessage(st, 'a'.repeat(ENGINE_SOCKET_LIMITS.maxFrameBytes))
    expect(got.length).toBe(1)
    onEngineSocketMessage(st, 'a'.repeat(ENGINE_SOCKET_LIMITS.maxFrameBytes + 1))
    expect(r.closed[0]![0]).toBe(CLOSE.tooBig)
    const wide = open('/api/engine/x', { maxFrameBytes: 10 * ENGINE_SOCKET_LIMITS.maxFrameBytes, got })
    onEngineSocketMessage(wide.st, new Uint8Array(ENGINE_SOCKET_LIMITS.maxFrameBytes + 1))
    expect(wide.r.closed[0]![0]).toBe(CLOSE.tooBig)
    const narrow = open('/api/engine/x', { maxFrameBytes: 4, got })
    onEngineSocketMessage(narrow.st, 'hello')
    expect(narrow.r.closed[0]![0]).toBe(CLOSE.tooBig)
  })
  it('refuses connections beyond the per-route and per-session ceilings', () => {
    for (let i = 0; i < ENGINE_SOCKET_LIMITS.perSession; i++) open('/api/engine/x', { sessionId: 's1' })
    expect(admit('/api/engine/x', 's1')).toEqual({ ok: false, reason: 'session-full' })
    expect(admit('/api/engine/x', 's2').ok).toBe(true)
    for (let i = engineSocketCount(); i < ENGINE_SOCKET_LIMITS.perRoute; i++) open('/api/engine/x')
    expect(admit('/api/engine/x', 's2')).toEqual({ ok: false, reason: 'route-full' })
    expect(planEngineUpgrade({ routeCanUpgrade: true, originOk: true, handlers: { message() {} }, sessionExists: true, admission: { ok: false, reason: 'route-full' } })?.status).toBe(503)
  })
  it('frees the slot when the socket closes', () => {
    const { st } = open('/api/engine/x', { sessionId: 's1' })
    expect(engineSocketCount()).toBe(1)
    closeEngineSocket(st, 1000, '')
    expect(engineSocketCount()).toBe(0)
  })
})

describe('closing', () => {
  it('closes the sockets of a session that ended, and only those', async () => {
    const a = open('/api/engine/x', { sessionId: 'gone' })
    const b = open('/api/engine/x', { sessionId: 'live' })
    const c = open('/api/engine/x')
    expect(await sweepEndedSessions(async id => id === 'live')).toBe(1)
    expect(a.r.closed[0]![0]).toBe(CLOSE.sessionEnded)
    expect(b.r.closed.length + c.r.closed.length).toBe(0)
  })
  it('closes everything at engine shutdown', () => {
    const a = open('/api/engine/x'); const b = open('/api/engine/x', { sessionId: 's' })
    closeAllEngineSockets('engine-shutdown')
    expect(a.r.closed[0]![0]).toBe(CLOSE.going)
    expect(b.r.closed[0]![0]).toBe(CLOSE.going)
  })
})

describe('surfaceSockets: which surfaces are mounted for a session', () => {
  it('lists only open sockets that declared that session', () => {
    const a = open('/api/engine/x/ws/a', { sessionId: 's1' })
    open('/api/engine/x/ws/a', { sessionId: 's2' })
    open('/api/engine/x/ws/a')
    expect(surfaceSockets('s1').length).toBe(1)
    expect(surfaceSockets('s3')).toEqual([])
    closeEngineSocket(a.st, 1000, '')
    expect(surfaceSockets('s1')).toEqual([])
  })
})
