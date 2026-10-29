import { beforeEach, describe, expect, test } from 'bun:test'
import { parseInjectedHeader } from '@agentistics/core'
import { isOwnerTurn } from '../sessions/handoff-relay'
import { createStructuredSessions, markEngineOpened, resetEngineOpenedForTests, SURFACE_TURN_HEADER } from './structured-handle'

function rig() {
  const sent: string[] = []
  const cancelled: string[] = []
  const state = { alive: true, activity: 'working', attention: null as unknown, structured: true }
  const followed: string[] = []
  const backend = {
    isStructured: () => state.structured,
    attentionOf: () => state.attention as never,
    activityOf: () => state.activity as never,
    sendText: async (_id: string, t: string) => { sent.push(t); return true },
    cancelTurn: (id: string) => { cancelled.push(id); return true },
    chatOf: () => ({
      conversationId: 'c1',
      chat: {
        declares: {} as never,
        resolve: async () => ({ harness: 'claude', conversationId: 'c1', sourceRef: 'x' }) as never,
        follow: (_s: unknown, max: number, on: (d: unknown) => void) => { followed.push(`max=${max}`); on({ kind: 'window', turns: [] }); return () => followed.push('off') },
      },
    }),
  }
  const surfaces: Record<string, { closed: boolean }[]> = {}
  const api = createStructuredSessions({
    backend: async () => backend as never,
    alive: async () => state.alive,
    surfaces: id => surfaces[id] ?? [],
  })
  return { api, state, sent, cancelled, followed, surfaces }
}
const tick = () => new Promise(r => setTimeout(r, 5))

beforeEach(() => resetEngineOpenedForTests())

describe('structuredSessions.get', () => {
  test('1. null for any id but the one the surface was opened from; never enumerates', () => {
    const r = rig()
    r.surfaces['s1'] = [{ closed: false }]
    expect(r.api.get('s1')).not.toBeNull()
    expect(r.api.get('s2')).toBeNull()
    expect(r.api.get('')).toBeNull()
    expect(r.api.get('../s1')).toBeNull()
    expect(Object.keys(r.api)).toEqual(['get'])
  })

  test('1b. a session the engine opened itself resolves without a surface', () => {
    const r = rig()
    expect(r.api.get('e1')).toBeNull()
    markEngineOpened('e1')
    expect(r.api.get('e1')).not.toBeNull()
    expect(r.api.get('other')).toBeNull()
  })

  test('the handle exposes follow, send, cancel (and a live flag) only', () => {
    const r = rig()
    r.surfaces['s1'] = [{ closed: false }]
    expect(Object.keys(r.api.get('s1')!).sort()).toEqual(['cancel', 'follow', 'live', 'send'])
  })

  test('2. send is typed with an injected header and is never the owner', async () => {
    const r = rig()
    r.surfaces['s1'] = [{ closed: false }]
    expect(await r.api.get('s1')!.send('hello there')).toBe(true)
    expect(r.sent).toEqual([`${SURFACE_TURN_HEADER}\nhello there`])
    const h = parseInjectedHeader(r.sent[0]!)
    expect(h).toMatchObject({ origin: 'agentistics', kind: 'surface', body: 'hello there' })
    expect(isOwnerTurn({ role: 'user', text: r.sent[0]! })).toBe(false)
  })

  test('send refuses empty text, an open request, and a non-structured session', async () => {
    const r = rig()
    r.surfaces['s1'] = [{ closed: false }]
    const h = r.api.get('s1')!
    expect(await h.send('   ')).toBe(false)
    r.state.attention = { open: true }
    expect(await h.send('x')).toBe(false)
    r.state.attention = null
    r.state.structured = false
    expect(await h.send('x')).toBe(false)
    expect(r.sent).toEqual([])
  })

  test('3. cancel cancels only a turn in flight', async () => {
    const r = rig()
    r.surfaces['s1'] = [{ closed: false }]
    const h = r.api.get('s1')!
    expect(await h.cancel()).toBe(true)
    expect(r.cancelled).toEqual(['s1'])
    r.state.activity = 'waiting'
    expect(await h.cancel()).toBe(false)
    expect(r.cancelled).toEqual(['s1'])
  })

  test('4. the handle dies when the surface unmounts, and stays dead', async () => {
    const r = rig()
    const sock = { closed: false }
    r.surfaces['s1'] = [sock]
    const h = r.api.get('s1')!
    const got: unknown[] = []
    h.follow(10, d => got.push(d))
    await tick()
    expect(got.length).toBe(1)
    sock.closed = true
    expect(h.live).toBe(false)
    expect(await h.send('late')).toBe(false)
    expect(await h.cancel()).toBe(false)
    const off = h.follow(10, d => got.push(d))
    await tick()
    expect(got.length).toBe(1)
    off()
    // a surface mounted again does not revive the old handle
    r.surfaces['s1'] = [{ closed: false }]
    expect(h.live).toBe(false)
    expect(r.api.get('s1')!.live).toBe(true)
    expect(r.sent).toEqual([])
  })

  test('4b. the handle dies when the session ends', async () => {
    const r = rig()
    r.surfaces['s1'] = [{ closed: false }]
    const h = r.api.get('s1')!
    r.state.alive = false
    expect(await h.send('x')).toBe(false)
    expect(h.live).toBe(false)
    r.state.alive = true
    expect(await h.send('x')).toBe(false)
  })

  test('follow stops delivering after the unsubscribe', async () => {
    const r = rig()
    r.surfaces['s1'] = [{ closed: false }]
    const off = r.api.get('s1')!.follow(500, () => {})
    await tick()
    off()
    expect(r.followed).toEqual(['max=200', 'off'])
  })
})
