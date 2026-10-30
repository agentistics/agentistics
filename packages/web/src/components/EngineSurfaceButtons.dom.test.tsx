/**
 * Engine surfaces in a real DOM (happy-dom): no button without an engine, a generic button with one,
 * mount on click with the host's context, and unmount + focus return on Esc / close.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import { surfaceModulePathOk, surfacesFrom } from '../lib/engineSurfaces'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./EngineSurfaceButtons')
let originalFetch: typeof globalThis.fetch
let status: unknown = { present: false, reason: 'community-build' }

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify(status), { status: 200 })
  createRoot = (await import('react-dom/client')).createRoot
  mod = await import('./EngineSurfaceButtons')
})
// Every root this file mounted is unmounted before the DOM goes: a surface host left subscribed to the
// shared host store would keep mounting the next file's surfaces with THIS file's loaders.
const roots: Array<{ unmount(): void }> = []
afterAll(async () => { await act(async () => { for (const r of roots) r.unmount() }); globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

const surface = { id: 'demo', placement: 'session-header', label: { pt: 'Demo PT', en: 'Demo' }, module: '/api/engine/x/demo/mount.js' }
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => { root.render(el) })
  await settle()
  return { host, root }
}

describe('pure', () => {
  test('only same-origin paths under the prefix reach import()', () => {
    expect(surfaceModulePathOk('/api/engine/x/a/m.js')).toBe(true)
    for (const bad of ['https://evil.example/a.js', '/api/engine/x/../a.js', '/other/a.js', '/api/engine/x/a.js?q', '/api/engine/x/%2e%2e/a.js']) {
      expect(surfaceModulePathOk(bad)).toBe(false)
    }
    expect(surfacesFrom({ surfaces: [surface, { ...surface, id: 'bad', module: 'https://evil.example/a.js' }] }, 'session-header').map(s => s.id)).toEqual(['demo'])
    expect(surfacesFrom({ surfaces: [surface] }, 'nay-dock')).toEqual([])
  })
})

describe('EngineSurfaceButtons + EngineSurfaceHost', () => {
  const esc = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })

  test('community build: no button', async () => {
    status = { present: false, reason: 'community-build' }
    const { host } = await mount(createElement(mod.EngineSurfaceButtons, { placement: 'session-header', sessionId: 's1', lang: 'en' }))
    expect(host.querySelector('button')).toBeNull()
  })

  test('composer surface is an icon button and opens with its composer session', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const { invalidateEngineCaps } = await import('../lib/engineCapsBus')
    const { resetEngineSurfaceHostForTests } = await import('../lib/engineSurfaceHost')
    resetEngineSurfaceHostForTests()
    invalidateEngineCaps()
    const calls: Array<string | null> = []
    const buttons = await mount(createElement(mod.EngineSurfaceButtons, { placement: 'composer', sessionId: 'composer-session', lang: 'pt' }))
    status = { present: true, surfaces: [{ ...surface, placement: 'composer', icon: 'phone' }] }
    invalidateEngineCaps()
    await settle()
    const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, { load: async () => ({ mount(_: HTMLElement, ctx: { sessionId: string | null }) { calls.push(ctx.sessionId) } }) }))
    const btn = buttons.host.querySelector('button[data-engine-surface="demo"]') as HTMLButtonElement
    expect(btn.getAttribute('aria-label')).toBe('Demo PT')
    expect(btn.textContent).toBe('')
    await act(async () => { btn.click() })
    await settle()
    expect(calls).toEqual(['composer-session'])
    surfaceHost.root.unmount()
    resetEngineSurfaceHostForTests()
  })

  test('inline composer surface mounts above the composer, keeps it usable, and re-parents on setLayout', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const hostState = await import('../lib/engineSurfaceHost')
    hostState.resetEngineSurfaceHostForTests()
    const calls: string[] = []
    let ctx: { layout: string; setLayout(l: 'full' | 'side' | 'inline'): void; close(): void } | null = null
    let node: HTMLElement | null = null
    const load = async () => ({
      mount(el: HTMLElement, c: NonNullable<typeof ctx>) { calls.push('mount'); ctx = c; node = el; el.textContent = 'inline-body' },
      unmount() { calls.push('unmount') },
    })
    const view = await mount(createElement('div', { 'data-testid': 'session' },
      createElement(hostMod.EngineSurfaceInlineSlot, { sessionId: 's9', slotId: 'a' }),
      createElement('textarea', { 'data-testid': 'composer' }),
    ))
    const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, { load }))
    const info = { ...surface, placement: 'composer', layout: 'inline' } as never
    await act(async () => { hostState.openEngineSurface(info, { sessionId: 's9', lang: 'en' }) })
    await settle()
    const slot = view.host.querySelector('[data-engine-inline="demo"]') as HTMLElement
    expect(slot.textContent).toBe('inline-body')
    expect(ctx!.layout).toBe('inline')
    expect(document.querySelector('[data-engine-overlay]')).toBeNull()
    expect(document.activeElement).toBe(node)
    const composer = view.host.querySelector('[data-testid="composer"]')!
    expect(slot.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(composer.isConnected).toBe(true)

    const before = node
    await act(async () => { ctx!.setLayout('side') })
    expect(document.querySelector('[data-engine-overlay="demo"]')!.textContent).toContain('inline-body')
    expect(node).toBe(before)
    await act(async () => { ctx!.setLayout('inline') })
    expect(view.host.querySelector('[data-engine-inline="demo"]')!.contains(before)).toBe(true)
    expect(calls).toEqual(['mount'])
    await act(async () => { ctx!.close() })
    await settle()
    expect(calls).toEqual(['mount', 'unmount'])
    expect(view.host.querySelector('[data-engine-inline]')).toBeNull()
    // Unmount every root this test made: a leftover EngineSurfaceHost would mount the next test's surface too.
    await act(async () => { surfaceHost.root.unmount(); view.root.unmount() })
    hostState.resetEngineSurfaceHostForTests()
  })

  test('two views of one session: the opener\'s slot wins; when it unmounts the other takes over; none falls back to side', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const hostState = await import('../lib/engineSurfaceHost')
    hostState.resetEngineSurfaceHostForTests()
    let ctx: { layout: string } | null = null
    let node: HTMLElement | null = null
    const load = async () => ({ mount(el: HTMLElement, c: NonNullable<typeof ctx>) { ctx = c; node = el; el.textContent = 'body' } })
    const slot = (id: string) => createElement(hostMod.EngineSurfaceInlineSlot, { sessionId: 's1', slotId: id })
    const viewA = await mount(slot('a'))
    const viewB = await mount(slot('b'))
    const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, { load }))
    await act(async () => { hostState.openEngineSurface({ ...surface, placement: 'composer', layout: 'inline' } as never, { sessionId: 's1', lang: 'en', slotId: 'b' }) })
    await settle()
    expect(viewB.host.contains(node)).toBe(true)
    expect(viewA.host.contains(node)).toBe(false)
    // The view that does NOT own the surface unmounting must not unregister the owner's slot.
    await act(async () => { viewA.root.unmount() })
    expect(viewB.host.contains(node)).toBe(true)
    expect(ctx!.layout).toBe('inline')
    // The owner goes away: no other live slot, so it is drawn as a side panel (and reported so).
    await act(async () => { viewB.root.unmount() })
    expect(document.querySelector('[data-engine-overlay="demo"]')!.getAttribute('data-layout')).toBe('side')
    expect(ctx!.layout).toBe('side')
    // A live slot of the same session appearing again takes it back.
    const viewC = await mount(slot('c'))
    expect(viewC.host.contains(node)).toBe(true)
    expect(ctx!.layout).toBe('inline')
    await act(async () => { surfaceHost.root.unmount(); viewC.root.unmount() })
    hostState.resetEngineSurfaceHostForTests()
  })

  test('frameless surface: no host close button or padding; non-composer cannot go inline', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const hostState = await import('../lib/engineSurfaceHost')
    hostState.resetEngineSurfaceHostForTests()
    let ctx: { setLayout(l: 'full' | 'side' | 'inline'): void; close(): void } | null = null
    const load = async () => ({ mount(_: HTMLElement, c: NonNullable<typeof ctx>) { ctx = c } })
    const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, { load }))
    await act(async () => { hostState.openEngineSurface({ ...surface, frameless: true } as never, { sessionId: null, lang: 'en' }) })
    await settle()
    const overlay = document.querySelector('[data-engine-overlay="demo"]') as HTMLElement
    expect(overlay.dataset.frameless).toBe('true')
    expect(overlay.querySelector('button')).toBeNull()
    expect(overlay.style.padding).toBe('0px')
    await act(async () => { ctx!.setLayout('inline') })
    expect(hostState.currentEngineSurface()!.layout).toBe('full')
    await act(async () => { ctx!.close() })
    await act(async () => { surfaceHost.root.unmount() })
    hostState.resetEngineSurfaceHostForTests()
  })

  test('composer surface active state: icon, tone, label; click closes and restores', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const { invalidateEngineCaps } = await import('../lib/engineCapsBus')
    const hostState = await import('../lib/engineSurfaceHost')
    hostState.resetEngineSurfaceHostForTests()
    const calls: string[] = []
    status = { present: false }
    invalidateEngineCaps()
    const buttons = await mount(createElement(mod.EngineSurfaceButtons, { placement: 'composer', sessionId: 'c1', lang: 'en' }))
    status = { present: true, surfaces: [{ ...surface, placement: 'composer', icon: 'phone', activeIcon: 'phone-off', activeTone: 'danger', activeLabel: { pt: 'Fim', en: 'End it' } }] }
    invalidateEngineCaps()
    await settle()
    const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, { load: async () => ({ mount() { calls.push('mount') }, unmount() { calls.push('unmount') } }) }))
    const btn = () => buttons.host.querySelector('button[data-engine-surface="demo"]') as HTMLButtonElement
    const idleIcon = btn().innerHTML
    expect(btn().getAttribute('aria-label')).toBe('Demo')
    await act(async () => { btn().click() })
    await settle()
    expect(btn().getAttribute('aria-pressed')).toBeNull()
    expect(btn().dataset.active).toBe('true')
    expect(btn().getAttribute('aria-label')).toBe('End it')
    expect(btn().dataset.tone).toBe('danger')
    expect(btn().style.background).toBe('var(--accent-red)')
    expect(btn().innerHTML).not.toBe(idleIcon)
    await act(async () => { btn().click() })
    await settle()
    expect(document.querySelector('[data-engine-overlay]')).toBeNull()
    expect(calls).toEqual(['mount', 'unmount'])
    expect(btn().getAttribute('aria-label')).toBe('Demo')
    expect(btn().innerHTML).toBe(idleIcon)
    await act(async () => { surfaceHost.root.unmount(); buttons.root.unmount() })
    hostState.resetEngineSurfaceHostForTests()
  })

  test('app-bar surface: button → mount → side/full without unmount → survives navigation → explicit close', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const { invalidateEngineCaps } = await import('../lib/engineCapsBus')
    const calls: string[] = []
    let ctx: { sessionId: string | null; lang: string; reducedMotion: boolean; layout: string; setLayout(l: 'full' | 'side'): void; close(): void } | null = null
    let node: HTMLElement | null = null
    const load = async () => ({
      mount(el: HTMLElement, c: NonNullable<typeof ctx>) { calls.push('mount'); ctx = c; node = el; el.textContent = 'hello' },
      unmount(el: HTMLElement) { calls.push('unmount'); el.textContent = '' },
    })
    status = { present: true, surfaces: [{ ...surface, placement: 'app-bar' }] }
    invalidateEngineCaps()
    const buttons = await mount(createElement(mod.EngineSurfaceButtons, { placement: 'app-bar', sessionId: null, lang: 'pt' }))
    await mount(createElement(hostMod.EngineSurfaceHost, { load }))
    const btn = buttons.host.querySelector('button[data-engine-surface="demo"]') as HTMLButtonElement
    expect(btn.textContent).toBe('Demo PT')
    btn.focus()
    await act(async () => { btn.click() })
    await settle()
    const overlay = () => document.querySelector('[data-engine-overlay="demo"]') as HTMLElement
    expect(overlay().getAttribute('role')).toBe('dialog')
    expect(overlay().textContent).toContain('hello')
    expect(ctx).toMatchObject({ sessionId: null, lang: 'pt', reducedMotion: false, layout: 'full' })

    // The surface flips the frame to a side panel: same container, still mounted, page usable.
    const before = node
    await act(async () => { ctx!.setLayout('side') })
    expect(overlay().dataset.layout).toBe('side')
    expect(overlay().getAttribute('role')).toBe('complementary')
    expect(node).toBe(before)
    expect(calls).toEqual(['mount'])
    await esc() // Esc is a modal's key: it does not end a side panel
    expect(overlay()).not.toBeNull()

    // Navigating away unmounts the screen's button; the surface stays.
    await act(async () => { buttons.root.unmount() })
    expect(overlay()).not.toBeNull()
    expect(calls).toEqual(['mount'])

    await act(async () => { ctx!.setLayout('full') })
    expect(overlay().dataset.layout).toBe('full')
    await act(async () => { ctx!.close() })
    await settle()
    expect(document.querySelector('[data-engine-overlay]')).toBeNull()
    expect(calls).toEqual(['mount', 'unmount'])
  })

  test('Esc closes a full surface and unmounts it', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const { openEngineSurface, resetEngineSurfaceHostForTests } = await import('../lib/engineSurfaceHost')
    resetEngineSurfaceHostForTests()
    const calls: string[] = []
    await mount(createElement(hostMod.EngineSurfaceHost, { load: async () => ({ mount() { calls.push('mount') }, unmount() { calls.push('unmount') } }) }))
    const trigger = document.body.appendChild(document.createElement('button'))
    await act(async () => { openEngineSurface({ ...surface, placement: 'session-header' } as never, { sessionId: 's1', lang: 'en', trigger }) })
    await settle()
    await esc()
    await settle()
    expect(document.querySelector('[data-engine-overlay]')).toBeNull()
    expect(calls).toEqual(['mount', 'unmount'])
    expect(document.activeElement).toBe(trigger)
  })

  test('a module without mount shows the failure and never throws', async () => {
    const hostMod = await import('./EngineSurfaceHost')
    const { openEngineSurface, closeEngineSurface, resetEngineSurfaceHostForTests } = await import('../lib/engineSurfaceHost')
    resetEngineSurfaceHostForTests()
    await mount(createElement(hostMod.EngineSurfaceHost, { load: async () => ({}) }))
    await act(async () => { openEngineSurface({ ...surface, placement: 'session-header' } as never, { sessionId: null, lang: 'en' }) })
    await settle()
    expect(document.querySelector('[data-engine-overlay] [role="alert"]')).not.toBeNull()
    await act(async () => { closeEngineSurface() })
  })
})
