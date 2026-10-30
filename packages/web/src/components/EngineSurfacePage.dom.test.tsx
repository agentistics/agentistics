/**
 * Engine surfaces as pages, kept alive and indicated, in a real DOM (happy-dom): the `rail` entry in the
 * area tree opens `/x/<id>` and mounts the surface there; `keepAlive` keeps the SAME element mounted off
 * screen when the page is left or the surface is closed; the indicator pill shows on another route, its
 * timer follows the clock, and clicking it brings the surface back; nothing is left after the end.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { formatIndicatorElapsed, surfaceIndicatorRefusals, surfacesFrom, type SurfaceMountContext } from '../lib/engineSurfaces'

let createRoot: typeof import('react-dom/client').createRoot
let router: typeof import('react-router-dom')
let hostMod: typeof import('./EngineSurfaceHost')
let indicatorMod: typeof import('./EngineSurfaceIndicator')
let treeMod: typeof import('./nav/AreaTree')
let state: typeof import('../lib/engineSurfaceHost')
let caps: typeof import('../lib/engineCapsBus')
let buttonsMod: typeof import('./EngineSurfaceButtons')
let originalFetch: typeof globalThis.fetch
let status: unknown = { present: false }

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify(status), { status: 200 })
  createRoot = (await import('react-dom/client')).createRoot
  router = await import('react-router-dom')
  hostMod = await import('./EngineSurfaceHost')
  indicatorMod = await import('./EngineSurfaceIndicator')
  treeMod = await import('./nav/AreaTree')
  state = await import('../lib/engineSurfaceHost')
  caps = await import('../lib/engineCapsBus')
  buttonsMod = await import('./EngineSurfaceButtons')
})
afterAll(async () => { setSystemTime(); globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

const rail = { id: 'demo', placement: 'rail', icon: 'sparkles', label: { pt: 'Demo PT', en: 'Demo' }, module: '/api/engine/x/demo/mount.js' }
const settle = (ms = 20) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function mount(el: ReturnType<typeof h>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await settle()
  return { host, root }
}

/** The app in miniature: the area tree, the top-bar pills and three routes, with the navigator exposed. */
function app(go: { nav: NavigateFunction | null; path: string }) {
  const { MemoryRouter, Routes, Route, Outlet, useNavigate, useLocation, useParams } = router
  function Layout() {
    go.nav = useNavigate()
    const loc = useLocation()
    go.path = loc.pathname
    return h('div', null,
      h('header', { 'data-testid': 'bar' }, h(indicatorMod.EngineSurfaceIndicators, { lang: 'en', tickMs: 10 })),
      h(treeMod.AreaTree, { lang: 'en', pathname: loc.pathname }),
      h('main', null, h(Outlet)))
  }
  function Page() { const { surfaceId = '' } = useParams(); return h(hostMod.EngineSurfacePage, { key: surfaceId, surfaceId, lang: 'en' }) }
  return h(MemoryRouter, { initialEntries: ['/other'] },
    h(Routes, null,
      h(Route, { element: h(Layout) },
        h(Route, { path: 'other', element: h('p', null, 'other page') }),
        h(Route, { path: 'sessions/:id', element: h('p', null, 'session page') }),
        h(Route, { path: 'x/:surfaceId', element: h(Page) }))))
}

describe('pure', () => {
  test('a rail surface needs an icon and is always a page', () => {
    expect(surfacesFrom({ surfaces: [rail, { ...rail, id: 'bare', icon: undefined }] }, 'rail').map(s => [s.id, s.layout])).toEqual([['demo', 'page']])
    expect(surfacesFrom({ surfaces: [{ ...rail, placement: 'app-bar', layout: 'page' }] }, 'app-bar')[0]!.layout).toBeUndefined()
  })
  test('the timer is mm:ss, minutes unbounded, never negative', () => {
    expect(formatIndicatorElapsed(1000, 1000)).toBe('00:00')
    expect(formatIndicatorElapsed(0, 65_999)).toBe('01:05')
    expect(formatIndicatorElapsed(0, 3_725_000)).toBe('62:05')
    expect(formatIndicatorElapsed(5000, 1000)).toBe('00:00')
  })
  test('indicator refusals mirror the contract', () => {
    expect(surfaceIndicatorRefusals({ label: { pt: 'a', en: 'b' }, since: 1, tone: 'danger', icon: 'phone', endLabel: { pt: 'x', en: 'y' } })).toEqual([])
    expect(surfaceIndicatorRefusals({ label: { pt: 'a'.repeat(41), en: 'b' }, tone: 'pink', icon: 'bell', since: Infinity })).toEqual(['bad-label', 'bad-since', 'bad-tone', 'bad-icon'])
    expect(surfaceIndicatorRefusals(null)).toEqual(['bad-indicator'])
    // Lengths are judged after trimming, as the contract says.
    expect(surfaceIndicatorRefusals({ label: { pt: `  ${'a'.repeat(40)}  `, en: 'b' } })).toEqual([])
    expect(surfaceIndicatorRefusals({ label: { pt: '   ', en: 'b' } })).toEqual(['bad-label'])
  })
})

describe('rail page, keepAlive and indicator', () => {
  test('rail entry → page mount → leaving without keepAlive unmounts', async () => {
    state.resetEngineSurfaceHostForTests()
    status = { present: true, surfaces: [rail] }
    caps.invalidateEngineCaps()
    const calls: string[] = []
    const go = { nav: null as NavigateFunction | null, path: '' }
    const view = await mount(app(go))
    const surfaceHost = await mount(h(hostMod.EngineSurfaceHost, { load: async () => ({ mount(el: HTMLElement) { calls.push('mount'); el.textContent = 'page-body' }, unmount() { calls.push('unmount') } }) }))
    const entry = () => view.host.querySelector('a[data-engine-rail="demo"]') as HTMLAnchorElement
    expect(entry().getAttribute('href')).toBe('/x/demo')
    expect(entry().getAttribute('title')).toBe('Demo')
    expect(entry().getAttribute('aria-current')).toBeNull()
    await act(async () => { entry().click() })
    await settle()
    expect(go.path).toBe('/x/demo')
    expect(entry().getAttribute('aria-current')).toBe('page')
    const page = view.host.querySelector('[data-engine-page="demo"]') as HTMLElement
    expect(page.textContent).toBe('page-body')
    expect(document.querySelector('[data-engine-overlay]')).toBeNull()
    expect(state.currentEngineSurface()!.layout).toBe('page')
    await act(async () => { go.nav!('/other') })
    await settle()
    expect(calls).toEqual(['mount', 'unmount'])
    expect(state.mountedEngineSurfaces()).toEqual([])
    expect(document.querySelector('[data-engine-parked]')).toBeNull()
    await act(async () => { surfaceHost.root.unmount(); view.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })

  test('keepAlive page: same element off screen, pill on another route with a live timer, click returns, keepAlive(false) ends', async () => {
    state.resetEngineSurfaceHostForTests()
    status = { present: true, surfaces: [rail] }
    caps.invalidateEngineCaps()
    const calls: string[] = []
    let ctx: SurfaceMountContext | null = null
    let node: HTMLElement | null = null
    const go = { nav: null as NavigateFunction | null, path: '' }
    const view = await mount(app(go))
    const surfaceHost = await mount(h(hostMod.EngineSurfaceHost, {
      load: async () => ({
        mount(el: HTMLElement, c: SurfaceMountContext) { calls.push('mount'); ctx = c; node = el; el.textContent = 'live' },
        unmount() { calls.push('unmount') },
      }),
    }))
    await act(async () => { go.nav!('/x/demo') })
    await settle()
    const T0 = 1_800_000_000_000
    setSystemTime(new Date(T0 + 5_000))
    await act(async () => {
      ctx!.keepAlive(true)
      ctx!.setIndicator({ label: { pt: 'Em curso', en: 'Running' }, since: T0, tone: 'danger', icon: 'phone' })
    })
    await settle()
    const pill = () => view.host.querySelector('[data-engine-indicator="demo"]') as HTMLElement | null
    expect(pill()!.textContent).toContain('Running')
    expect(pill()!.querySelector('[data-engine-indicator-time]')!.textContent).toBe('00:05')
    expect(pill()!.dataset.tone).toBe('danger')

    const before = node!
    await act(async () => { go.nav!('/other') })
    await settle()
    expect(view.host.textContent).toContain('other page')
    expect(calls).toEqual(['mount'])
    expect(before.isConnected).toBe(true)
    expect(document.querySelector('[data-engine-parked="demo"]')!.contains(before)).toBe(true)
    expect(before.textContent).toBe('live')
    // The pill is on the other route, and its timer follows the clock.
    expect(pill()).not.toBeNull()
    setSystemTime(new Date(T0 + 65_000))
    await settle(40)
    expect(pill()!.querySelector('[data-engine-indicator-time]')!.textContent).toBe('01:05')

    // Clicking it navigates back to the page: the same element, never remounted.
    await act(async () => { (pill()!.querySelector('button') as HTMLButtonElement).click() })
    await settle()
    expect(go.path).toBe('/x/demo')
    expect(view.host.querySelector('[data-engine-page="demo"]')!.contains(before)).toBe(true)
    expect(document.querySelector('[data-engine-parked]')).toBeNull()
    expect(calls).toEqual(['mount'])

    // keepAlive(false) while off screen ends it at once, and leaves nothing behind.
    await act(async () => { go.nav!('/other') })
    await settle()
    expect(calls).toEqual(['mount'])
    await act(async () => { ctx!.keepAlive(false) })
    await settle()
    expect(calls).toEqual(['mount', 'unmount'])
    expect(before.isConnected).toBe(false)
    expect(document.querySelector('[data-engine-parked]')).toBeNull()
    expect(pill()).toBeNull()
    expect(state.mountedEngineSurfaces()).toEqual([])
    setSystemTime()
    await act(async () => { surfaceHost.root.unmount(); view.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })

  test('keepAlive composer surface: the host close parks it; the pill reopens the session in its layout; end button; close leaves nothing', async () => {
    state.resetEngineSurfaceHostForTests()
    status = { present: false }
    caps.invalidateEngineCaps()
    const calls: string[] = []
    let ctx: SurfaceMountContext | null = null
    let node: HTMLElement | null = null
    const go = { nav: null as NavigateFunction | null, path: '' }
    const view = await mount(app(go))
    const surfaceHost = await mount(h(hostMod.EngineSurfaceHost, {
      load: async () => ({
        mount(el: HTMLElement, c: SurfaceMountContext) { calls.push('mount'); ctx = c; node = el; el.textContent = 'composer-body' },
        unmount() { calls.push('unmount') },
      }),
    }))
    const info = { id: 'talk', placement: 'composer', icon: 'phone', label: { pt: 'T', en: 'T' }, module: '/api/engine/x/t/m.js', layout: 'side' } as never
    await act(async () => { state.openEngineSurface(info, { sessionId: 's7', lang: 'en' }) })
    await settle()
    const ends: string[] = []
    await act(async () => {
      ctx!.keepAlive(true)
      ctx!.setIndicator({ label: { pt: 'Ativo', en: 'Active' }, endLabel: { pt: 'Encerrar', en: 'End' } })
      ctx!.onIndicatorEnd(() => { ends.push('end') })
    })
    expect(() => ctx!.setIndicator({ label: { pt: '', en: 'x' } } as never)).toThrow('bad-label')
    expect(state.currentEngineSurface()!.indicator!.label.en).toBe('Active')
    const before = node!
    expect(document.querySelector('[data-engine-overlay="talk"]')!.getAttribute('data-layout')).toBe('side')

    // The host's close button parks it instead of unmounting.
    await act(async () => { (document.querySelector('[data-engine-overlay="talk"] button') as HTMLButtonElement).click() })
    await settle()
    expect(document.querySelector('[data-engine-overlay]')).toBeNull()
    expect(document.querySelector('[data-engine-parked="talk"]')!.contains(before)).toBe(true)
    expect(calls).toEqual(['mount'])

    const pill = () => view.host.querySelector('[data-engine-indicator="talk"]') as HTMLElement | null
    expect(pill()!.querySelector('[data-engine-indicator-time]')).toBeNull()
    await act(async () => { (pill()!.querySelector('[data-engine-indicator-end]') as HTMLButtonElement).click() })
    expect(ends).toEqual(['end'])

    // The pill opens the owning session and brings the surface back in the layout it had.
    await act(async () => { (pill()!.querySelector('button') as HTMLButtonElement).click() })
    await settle()
    expect(go.path).toBe('/sessions/s7')
    const overlay = document.querySelector('[data-engine-overlay="talk"]') as HTMLElement
    expect(overlay.getAttribute('data-layout')).toBe('side')
    expect(overlay.contains(before)).toBe(true)
    expect(calls).toEqual(['mount'])

    // Opening another surface parks the kept-alive one rather than ending it.
    const talk = ctx!
    const talkNonce = state.currentEngineSurface()!.nonce
    await act(async () => { state.openEngineSurface({ id: 'other', placement: 'app-bar', label: { pt: 'O', en: 'O' }, module: '/api/engine/x/o/m.js' } as never, { sessionId: null, lang: 'en' }) })
    await settle()
    expect(document.querySelector('[data-engine-parked="talk"]')!.contains(before)).toBe(true)
    expect(state.currentEngineSurface()!.surface.id).toBe('other')
    await act(async () => { state.closeEngineSurface() })
    await settle()

    // ctx.close() always ends it; nothing is left: no holder, no pill, no handler, no element.
    await act(async () => { talk.close() })
    await settle()
    expect(calls).toEqual(['mount', 'mount', 'unmount', 'unmount'])
    expect(before.isConnected).toBe(false)
    expect(document.querySelector('[data-engine-parked]')).toBeNull()
    expect(pill()).toBeNull()
    expect(state.mountedEngineSurfaces()).toEqual([])
    await act(async () => { state.endEngineSurfaceIndicator(talkNonce) })
    expect(ends).toEqual(['end'])
    await act(async () => { surfaceHost.root.unmount(); view.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })
  test('parked composer button shows the idle face; it brings the surface back with focus; a surface no longer announced ends', async () => {
    state.resetEngineSurfaceHostForTests()
    const talk = { id: 'talk', placement: 'composer', icon: 'phone', activeIcon: 'phone-off', activeTone: 'danger', activeLabel: { pt: 'Fim', en: 'End' }, label: { pt: 'T', en: 'Talk' }, module: '/api/engine/x/t/m.js', layout: 'side' }
    status = { present: true, surfaces: [talk] }
    caps.invalidateEngineCaps()
    const calls: string[] = []
    let ctx: SurfaceMountContext | null = null
    const go = { nav: null as NavigateFunction | null, path: '' }
    const view = await mount(app(go))
    const buttons = await mount(h(buttonsMod.EngineSurfaceButtons, { placement: 'composer', sessionId: 's7', lang: 'en' }))
    const surfaceHost = await mount(h(hostMod.EngineSurfaceHost, {
      load: async () => ({ mount(el: HTMLElement, c: SurfaceMountContext) { calls.push('mount'); ctx = c; el.textContent = 'x' }, unmount() { calls.push('unmount') } }),
    }))
    const btn = () => buttons.host.querySelector('button[data-engine-surface="talk"]') as HTMLButtonElement
    await act(async () => { btn().click() })
    await settle()
    expect(btn().getAttribute('aria-label')).toBe('End')
    await act(async () => { ctx!.keepAlive(true); ctx!.setIndicator({ label: { pt: '  Ativo ', en: ' Active  ' } }) })
    expect(state.currentEngineSurface()!.indicator!.label.en).toBe('Active')
    // Taking it off screen: the button no longer promises "End" — it is the idle button, marked parked.
    await act(async () => { btn().click() })
    await settle()
    expect(document.querySelector('[data-engine-parked="talk"]')).not.toBeNull()
    expect(btn().getAttribute('aria-label')).toBe('Talk')
    expect(btn().dataset.active).toBeUndefined()
    expect(btn().dataset.parked).toBe('true')
    expect(btn().dataset.tone).toBeUndefined()
    expect(ctx!.layout).toBe('side')
    // Its click brings it back, focus inside the frame, as on mount.
    await act(async () => { btn().click() })
    await settle()
    const overlay = document.querySelector('[data-engine-overlay="talk"]') as HTMLElement
    expect(overlay).not.toBeNull()
    expect(overlay.contains(document.activeElement)).toBe(true)
    expect(btn().getAttribute('aria-label')).toBe('End')
    expect(calls).toEqual(['mount'])
    // Park it again, then the engine stops announcing it: it ends and its pill goes.
    await act(async () => { state.closeEngineSurface() })
    await settle()
    expect(view.host.querySelector('[data-engine-indicator="talk"]')).not.toBeNull()
    status = { present: true, surfaces: [] }
    await act(async () => { caps.invalidateEngineCaps() })
    await settle()
    expect(calls).toEqual(['mount', 'unmount'])
    expect(state.mountedEngineSurfaces()).toEqual([])
    expect(document.querySelector('[data-engine-parked]')).toBeNull()
    expect(view.host.querySelector('[data-engine-indicator]')).toBeNull()
    await act(async () => { surfaceHost.root.unmount(); buttons.root.unmount(); view.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })

  test('a parked inline surface reports the layout it had, and comes back into its slot', async () => {
    state.resetEngineSurfaceHostForTests()
    status = { present: false }
    caps.invalidateEngineCaps()
    let ctx: SurfaceMountContext | null = null
    let node: HTMLElement | null = null
    const view = await mount(h(hostMod.EngineSurfaceInlineSlot, { sessionId: 's1', slotId: 'a' }))
    const surfaceHost = await mount(h(hostMod.EngineSurfaceHost, { load: async () => ({ mount(el: HTMLElement, c: SurfaceMountContext) { ctx = c; node = el } }) }))
    const info = { id: 'in', placement: 'composer', icon: 'phone', label: { pt: 'I', en: 'I' }, module: '/api/engine/x/i/m.js', layout: 'inline' } as never
    await act(async () => { state.openEngineSurface(info, { sessionId: 's1', lang: 'en', slotId: 'a' }) })
    await settle()
    expect(ctx!.layout).toBe('inline')
    await act(async () => { ctx!.keepAlive(true) })
    await act(async () => { state.closeEngineSurface() })
    await settle()
    expect(document.querySelector('[data-engine-parked="in"]')!.contains(node)).toBe(true)
    expect(ctx!.layout).toBe('inline')
    await act(async () => { state.openEngineSurface(info, { sessionId: 's1', lang: 'en', slotId: 'a' }) })
    await settle()
    expect(view.host.querySelector('[data-engine-inline="in"]')!.contains(node)).toBe(true)
    expect(document.activeElement).toBe(node)
    await act(async () => { ctx!.close() })
    await act(async () => { surfaceHost.root.unmount(); view.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })
  test('ctx.openSession navigates without remounting the app; a keepAlive surface stays mounted', async () => {
    state.resetEngineSurfaceHostForTests()
    status = { present: false }
    caps.invalidateEngineCaps()
    const calls: string[] = []
    let ctx: SurfaceMountContext | null = null
    let node: HTMLElement | null = null
    const go = { nav: null as NavigateFunction | null, path: '' }
    const view = await mount(app(go))
    const marker = view.host.querySelector('header')!
    const surfaceHost = await mount(h(hostMod.EngineSurfaceHost, {
      load: async () => ({
        mount(el: HTMLElement, c: SurfaceMountContext) { calls.push('mount'); ctx = c; node = el; el.textContent = 'body' },
        unmount() { calls.push('unmount') },
      }),
    }))
    const info = { id: 'talk', placement: 'composer', icon: 'phone', label: { pt: 'T', en: 'T' }, module: '/api/engine/x/t/m.js', layout: 'side' } as never
    await act(async () => { state.openEngineSurface(info, { sessionId: 's1', lang: 'en' }) })
    await settle()
    await act(async () => { ctx!.keepAlive(true) })
    const before = node!
    await act(async () => { (document.querySelector('[data-engine-overlay="talk"] button') as HTMLButtonElement).click() })
    await settle()
    expect(document.querySelector('[data-engine-parked="talk"]')!.contains(before)).toBe(true)

    let ok = false
    await act(async () => { ok = ctx!.openSession!('abc-123') })
    await settle()
    expect(ok).toBe(true)
    expect(go.path).toBe('/sessions/abc-123')
    // The app was not remounted (same header node) and the parked surface is still the same mounted element.
    expect(view.host.querySelector('header')).toBe(marker)
    expect(document.querySelector('[data-engine-parked="talk"]')!.contains(before)).toBe(true)
    expect(calls).toEqual(['mount'])

    for (const bad of ['', 'a/b', '/x', '..', 'a?b', 'a b', 'x'.repeat(129), 42 as never, null as never]) {
      let r = true
      await act(async () => { r = ctx!.openSession!(bad) })
      expect(r).toBe(false)
    }
    expect(go.path).toBe('/sessions/abc-123')
    await act(async () => { ctx!.close() })
    await act(async () => { surfaceHost.root.unmount(); view.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })

})
