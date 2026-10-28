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

describe('EngineSurfaceButtons', () => {
  test('community build: no button', async () => {
    status = { present: false, reason: 'community-build' }
    const { host } = await mount(createElement(mod.EngineSurfaceButtons, { placement: 'session-header', sessionId: 's1', lang: 'en' }))
    expect(host.querySelector('button')).toBeNull()
  })

  test('engine surface: button → mount with the context → Esc unmounts and returns focus', async () => {
    const calls: string[] = []
    let ctx: { sessionId: string | null; lang: string; reducedMotion: boolean } | null = null
    const load = async () => ({
      mount(el: HTMLElement, c: typeof ctx) { calls.push('mount'); ctx = c; el.textContent = 'hello' },
      unmount(el: HTMLElement) { calls.push('unmount'); el.textContent = '' },
    })
    // Fresh module state: the hook caches /api/engine per page load.
    const { invalidateEngineCaps } = await import('../lib/engineCapsBus')
    status = { present: true, surfaces: [surface] }
    invalidateEngineCaps()
    const { host } = await mount(createElement(mod.EngineSurfaceButtons, { placement: 'session-header', sessionId: 's1', lang: 'pt', load }))
    const btn = host.querySelector('button[data-engine-surface="demo"]') as HTMLButtonElement
    expect(btn?.textContent).toBe('Demo PT')
    btn.focus()
    await act(async () => { btn.click() })
    await settle()
    const overlay = document.querySelector('[data-engine-overlay="demo"]')!
    expect(overlay.getAttribute('role')).toBe('dialog')
    expect(overlay.textContent).toContain('hello')
    expect(ctx).toMatchObject({ sessionId: 's1', lang: 'pt', reducedMotion: false })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await settle()
    expect(document.querySelector('[data-engine-overlay]')).toBeNull()
    expect(calls).toEqual(['mount', 'unmount'])
    expect(document.activeElement).toBe(btn)
  })

  test('a module without mount shows the failure and never throws', async () => {
    const { invalidateEngineCaps } = await import('../lib/engineCapsBus')
    status = { present: true, surfaces: [surface] }
    invalidateEngineCaps()
    const { host } = await mount(createElement(mod.EngineSurfaceButtons, { placement: 'session-header', sessionId: null, lang: 'en', load: async () => ({}) }))
    await act(async () => { (host.querySelector('button[data-engine-surface]') as HTMLButtonElement).click() })
    await settle()
    expect(document.querySelector('[data-engine-overlay] [role="alert"]')).not.toBeNull()
  })
})
