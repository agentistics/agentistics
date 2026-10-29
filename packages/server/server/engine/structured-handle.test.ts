import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseInjectedHeader } from '@agentistics/core'
import { isOwnerTurn } from '../sessions/handoff-relay'
import {
  closeEngineSocket, installSocketSessions, openEngineSocket, resetEngineSocketsForTests, type EngineSocketState, type RawSocket,
} from './engine-sockets'
import { createStructuredSessions, markEngineOpened, MAX_SURFACE_TURN_BYTES, resetEngineOpenedForTests, SURFACE_TURN_HEADER } from './structured-handle'

function rig() {
  const sent: string[] = []
  const cancelled: string[] = []
  const state = { alive: true, aliveThrows: false, activity: 'working', attention: null as unknown, structured: true, sendThrows: false }
  const followed: string[] = []
  const backend = {
    isStructured: () => state.structured,
    attentionOf: () => state.attention as never,
    activityOf: () => state.activity as never,
    sendText: async (_id: string, t: string) => { if (state.sendThrows) throw new Error('boom'); sent.push(t); return true },
    cancelTurn: (id: string) => { cancelled.push(id); return true },
    chatOf: (id: string) => ({
      conversationId: 'c-' + id,
      chat: {
        declares: {} as never,
        resolve: async () => ({ harness: 'claude', conversationId: 'c1', sourceRef: 'x' }) as never,
        follow: (_s: unknown, max: number, on: (d: unknown) => void) => { followed.push(`max=${max}`); on({ kind: 'window', turns: [] }); return () => followed.push('off') },
      },
    }),
  }
  const host = createStructuredSessions({ backend: async () => backend as never, alive: async () => { if (state.aliveThrows) throw new Error('registry'); return state.alive } })
  installSocketSessions(host)
  const sockets: { st: EngineSocketState; api: ReturnType<typeof apiOf> }[] = []
  function apiOf(st: EngineSocketState) { return st.entry!.api }
  const raw = (): RawSocket => ({ send() {}, close() {} })
  const mount = (sessionId?: string) => {
    const st: EngineSocketState = { route: '/api/engine/x/ws/a', handlers: { ...(sessionId ? { sessionId } : {}), message() {} }, entry: null }
    openEngineSocket(st, raw())
    sockets.push({ st, api: apiOf(st) })
    return { st, api: apiOf(st), unmount: () => closeEngineSocket(st, 1000, '') }
  }
  return { host, state, sent, cancelled, followed, mount }
}
const tick = () => new Promise(r => setTimeout(r, 5))

beforeEach(() => resetEngineOpenedForTests())
afterEach(() => { resetEngineSocketsForTests(); installSocketSessions(null) })

describe('the handle a socket hands out', () => {
  test('1. a surface reaches only the session ITS handshake declared; two surfaces never cross', async () => {
    const r = rig()
    const a = r.mount('sA'), b = r.mount('sB')
    const ha = a.api.structured!()!, hb = b.api.structured!()!
    await ha.send('to A'); await hb.send('to B')
    expect(r.sent).toEqual([`${SURFACE_TURN_HEADER}\nto A`, `${SURFACE_TURN_HEADER}\nto B`])
    // the host id travels in the backend call, not from anything the engine passes
    expect(Object.keys(ha).sort()).toEqual(['cancel', 'follow', 'live', 'send'])
    expect(r.mount().api.structured!()).toBeNull() // a socket that declared no session
  })
  test('1b. host.structuredSessions.get answers only sessions the engine started: a surface session id is null', () => {
    const r = rig()
    r.mount('sA')
    expect(r.host.engine.get('sA')).toBeNull()
    expect(r.host.engine.get('')).toBeNull()
    markEngineOpened('e1')
    expect(r.host.engine.get('e1')).not.toBeNull()
    expect(r.host.engine.get('other')).toBeNull()
    expect(Object.keys(r.host.engine)).toEqual(['get'])
  })
  test('2. send is typed with an injected header and is never the owner', async () => {
    const r = rig()
    const h = r.mount('s1').api.structured!()!
    expect(await h.send('hello there')).toBe(true)
    const h2 = parseInjectedHeader(r.sent[0]!)
    expect(h2).toMatchObject({ origin: 'agentistics', kind: 'surface', body: 'hello there' })
    expect(isOwnerTurn({ role: 'user', text: r.sent[0]! })).toBe(false)
  })
  test('send refuses empty, oversized, an open request, and a non-structured session', async () => {
    const r = rig()
    const h = r.mount('s1').api.structured!()!
    expect(await h.send('   ')).toBe(false)
    expect(await h.send('x'.repeat(MAX_SURFACE_TURN_BYTES + 1))).toBe(false)
    r.state.attention = { open: true }
    expect(await h.send('x')).toBe(false)
    r.state.attention = null
    r.state.structured = false
    expect(await h.send('x')).toBe(false)
    expect(r.sent).toEqual([])
  })
  test('3. cancel cancels only a turn in flight', async () => {
    const r = rig()
    const h = r.mount('s1').api.structured!()!
    expect(await h.cancel()).toBe(true)
    expect(r.cancelled).toEqual(['s1'])
    r.state.activity = 'waiting'
    expect(await h.cancel()).toBe(false)
    expect(r.cancelled).toEqual(['s1'])
  })
  test('4. the handle dies with ITS socket; a second surface on the same session does not keep it alive', async () => {
    const r = rig()
    const a = r.mount('s1'), b = r.mount('s1')
    const ha = a.api.structured!()!, hb = b.api.structured!()!
    const got: unknown[] = []
    ha.follow(10, d => got.push(d))
    await tick()
    expect(got.length).toBe(1)
    a.unmount()
    expect(ha.live).toBe(false)
    expect(hb.live).toBe(true)
    expect(await ha.send('late')).toBe(false)
    expect(await ha.cancel()).toBe(false)
    expect(r.followed).toEqual(['max=10', 'off']) // the subscription was released at the unmount
    expect(r.sent).toEqual([])
    expect(await hb.send('still')).toBe(true)
    // a surface mounted again gets a new handle; the old one stays dead
    const c = r.mount('s1')
    expect(c.api.structured!()!.live).toBe(true)
    expect(ha.live).toBe(false)
  })
  test('4b. the handle dies when the session ends, and stays dead', async () => {
    const r = rig()
    const h = r.mount('s1').api.structured!()!
    r.state.alive = false
    expect(await h.send('x')).toBe(false)
    expect(h.live).toBe(false)
    r.state.alive = true
    expect(await h.send('x')).toBe(false)
  })
  test('4c. an engine-started session leaves the set when it ends', async () => {
    const r = rig()
    markEngineOpened('e1')
    const h = r.host.engine.get('e1')!
    r.state.alive = false
    expect(await h.send('x')).toBe(false)
    expect(r.host.engine.get('e1')).toBeNull()
  })
  test('methods never throw: a failing backend resolves false', async () => {
    const r = rig()
    const h = r.mount('s1').api.structured!()!
    r.state.sendThrows = true
    expect(await h.send('x')).toBe(false)
  })
  test('unmount releases the subscriptions without anybody touching the handle', async () => {
    const r = rig()
    const a = r.mount('s1')
    a.api.structured!()!.follow(10, () => {})
    await tick()
    expect(r.followed).toEqual(['max=10'])
    a.unmount()
    expect(r.followed).toEqual(['max=10', 'off'])
  })
  test('structured() after the close is null, and asking twice returns the same handle', () => {
    const r = rig()
    const a = r.mount('s1')
    expect(a.api.structured!()).toBe(a.api.structured!())
    a.unmount()
    expect(a.api.structured!()).toBeNull()
  })
  test('a transient registry error refuses the use but does not end an engine-started session', async () => {
    const r = rig()
    markEngineOpened('e1')
    const h = r.host.engine.get('e1')!
    r.state.aliveThrows = true
    expect(await h.send('x')).toBe(false)
    expect(r.host.engine.get('e1')).not.toBeNull()
    r.state.aliveThrows = false
    expect(await h.send('x')).toBe(true)
  })
  test('without installed sessions a socket offers no structured door', () => {
    const r = rig()
    installSocketSessions(null)
    expect(r.mount('s1').api.structured).toBeUndefined()
  })
})
