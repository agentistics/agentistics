import { describe, expect, test } from 'bun:test'
import { runAction, type ActionHost } from './browser-actions'
import type { ActionArgs } from './browser-action-spec'

/** Two pages whose button has the SAME backend node id (8) and a different label. */
const PAGES: Record<string, { loader: string; label: string }> = {
  A: { loader: 'LA', label: 'Keep' },
  B: { loader: 'LB', label: 'Delete everything' },
  A2: { loader: 'LA2', label: 'Keep' },
}

function fake(tabIds = ['T1']) {
  const state = { page: 'A', clicks: [] as string[], listeners: [] as ((ev: any) => void)[], tabs: tabIds.map(t => ({ targetId: t, url: 'http://x/', title: '', active: false })), active: tabIds[0] ?? null as string | null, gone: new Set<string>() }
  const fire = (method: string, sid?: string) => setTimeout(() => state.listeners.slice().forEach(l => l({ method, sessionId: sid, params: {} })), 0)
  const cdp: any = {
    on(l: (ev: any) => void) { state.listeners.push(l); return () => { state.listeners = state.listeners.filter(x => x !== l) } },
    async send(method: string, params: any, sid?: string) {
      if (sid && state.gone.has(sid)) throw new Error(`${method}: timed out`)
      const pg = PAGES[state.page]!
      switch (method) {
        case 'Page.getFrameTree': return { frameTree: { frame: { loaderId: pg.loader } } }
        case 'Runtime.evaluate': return { result: { value: { url: `http://x/${state.page}`, title: state.page } } }
        case 'Accessibility.getFullAXTree': return { nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'], backendDOMNodeId: 1 },
          { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: pg.label }, backendDOMNodeId: 8, childIds: [] },
        ] }
        case 'Accessibility.getPartialAXTree': return { nodes: [{ name: { value: pg.label }, role: { value: 'button' } }] }
        case 'DOM.scrollIntoViewIfNeeded': return {}
        case 'DOM.getContentQuads': return { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] }
        case 'DOM.resolveNode': return { object: { objectId: 'o1' } }
        case 'DOM.describeNode': return {}
        case 'Input.dispatchMouseEvent': if (params.type === 'mousePressed') state.clicks.push(pg.label); return {}
        case 'Page.navigate': state.page = params.url.split('/').pop()!; fire('Page.loadEventFired', sid); return { loaderId: PAGES[state.page]!.loader }
        case 'Page.reload': state.page = state.page === 'A' ? 'A2' : state.page; fire('Page.loadEventFired', sid); return {}
        default: return {}
      }
    },
  }
  const host: ActionHost = {
    cdp, ownerKind: 'session', maxTabs: 4,
    tabs: () => state.tabs.map(t => ({ ...t, active: t.targetId === state.active })),
    activeTab: () => state.active, setActive: (t) => { state.active = t },
    noteTab: () => {}, sessionFor: async (t) => (state.tabs.some(x => x.targetId === t) ? `S-${t}` : (() => { throw new Error('No target with given id') })()),
    waitTab: async () => {}, blockedSince: () => [], blockReason: async () => null, noteAction: () => {}, touch: () => {}, now: () => Date.now(),
  }
  return { host, state }
}
const act = (h: ActionHost, a: ActionArgs) => runAction(h, a)
const click = (ref: string): ActionArgs => ({ action: 'click', ref, button: 'left', double: false })
const refIn = (snap: any) => /\[ref=(e\d+@g\d+)\]/.exec(snap.snapshot)![1]!

describe('refs die with their document', () => {
  test('a ref from page A clicks nothing on page B, even with the same node id', async () => {
    const { host, state } = fake()
    const snap = await act(host, { action: 'snapshot', mode: 'full' })
    const ref = refIn(snap)
    expect(ref).toMatch(/^e8@g1$/)
    await act(host, { action: 'navigate', url: 'http://x/B' })
    const r = await act(host, click(ref))
    expect(r).toMatchObject({ ok: false, error: 'stale_ref' })
    expect(state.clicks).toEqual([])
  })

  test('a reload voids the refs; a fresh snapshot makes new ones that work and name the live node', async () => {
    const { host, state } = fake()
    const ref = refIn(await act(host, { action: 'snapshot', mode: 'full' }))
    await act(host, { action: 'reload' })
    expect(await act(host, click(ref))).toMatchObject({ ok: false, error: 'stale_ref' })
    const ref2 = refIn(await act(host, { action: 'snapshot', mode: 'full' }))
    expect(ref2).toBe('e8@g2')
    expect(await act(host, click(ref2))).toMatchObject({ ok: true, clicked: 'Keep' })
    expect(state.clicks).toEqual(['Keep'])
  })

  test('the result names the node actually clicked, read live after validation', async () => {
    const { host, state } = fake()
    await act(host, { action: 'navigate', url: 'http://x/B' })
    const ref = refIn(await act(host, { action: 'snapshot', mode: 'full' }))
    state.page = 'B'
    const r = await act(host, click(ref))
    expect(r).toMatchObject({ ok: true, clicked: 'Delete everything' })
  })

  test('a tab switch voids the refs of the tab it selects', async () => {
    const { host, state } = fake(['T1', 'T2'])
    const ref = refIn(await act(host, { action: 'snapshot', mode: 'full' }))
    await act(host, { action: 'tab_select', tab: 'T2' })
    await act(host, { action: 'tab_select', tab: 'T1' })
    expect(await act(host, click(ref))).toMatchObject({ ok: false, error: 'stale_ref' })
    expect(state.clicks).toEqual([])
  })

  test('type, select, scroll and wait_for refuse a stale ref too, and a bare or invented ref', async () => {
    const { host } = fake()
    const ref = refIn(await act(host, { action: 'snapshot', mode: 'full' }))
    await act(host, { action: 'navigate', url: 'http://x/B' })
    for (const a of [
      { action: 'type', ref, text: 'x', submit: false },
      { action: 'select', ref, values: ['a'] },
      { action: 'scroll', ref, dx: 0, dy: 0 },
      { action: 'wait_for', ref, timeoutMs: 100 },
    ] as ActionArgs[]) expect(await act(host, a)).toMatchObject({ ok: false, error: 'stale_ref' })
    const fresh = refIn(await act(host, { action: 'snapshot', mode: 'full' }))
    for (const bad of ['e8', fresh.replace('@g2', '@g9'), 'e999@g2']) {
      const r = await act(host, click(bad))
      expect(r.ok).toBe(bad === 'e999@g2')
    }
  })
})

describe('a tab that disappeared is said in words', () => {
  test('a timeout on a tab the browser no longer lists answers no_such_tab and moves to a survivor', async () => {
    const { host, state } = fake(['T1', 'T2'])
    // The page closed the tab while the action was in flight: its session times out and the tab is unlisted.
    state.gone.add('S-T1')
    const cdp = host.cdp as any
    const send = cdp.send.bind(cdp)
    cdp.send = async (m: string, p: any, sid?: string, t?: number) => {
      if (sid === 'S-T1') state.tabs = state.tabs.filter(x => x.targetId !== 'T1')
      return send(m, p, sid, t)
    }
    const r = await act(host, click('e8@g1'))
    expect(r).toMatchObject({ ok: false, error: 'no_such_tab' })
    expect((r as any).sentence).toMatch(/no longer exists/)
    expect(state.active).toBe('T2')
    expect(await act(host, { action: 'tabs' })).toMatchObject({ ok: true })
  })
})
