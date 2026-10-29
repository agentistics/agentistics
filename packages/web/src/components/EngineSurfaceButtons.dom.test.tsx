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
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

const surface = { id: 'demo', placement: 'session-header', label: { pt: 'Demo PT', en: 'Demo' }, module: '/api/engine/x/demo/mount.js' }
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
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
