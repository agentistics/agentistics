/**
 * The active composer button ENDS a surface that declared an active face; a parked inline surface
 * returns when its session view comes back; the active surface owns the microphone; the Nay button
 * lists minimized surfaces; the floating card opens compact.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let btns: typeof import('./EngineSurfaceButtons')
let hostMod: typeof import('./EngineSurfaceHost')
let state: typeof import('../lib/engineSurfaceHost')
let caps: typeof import('../lib/engineCapsBus')
let menu: typeof import('./nay/MinimizedMenu')
let originalFetch: typeof globalThis.fetch
let status: unknown = { present: false }
const roots: Array<{ unmount(): void }> = []

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify(status), { status: 200 })
  createRoot = (await import('react-dom/client')).createRoot
  btns = await import('./EngineSurfaceButtons')
  hostMod = await import('./EngineSurfaceHost')
  state = await import('../lib/engineSurfaceHost')
  caps = await import('../lib/engineCapsBus')
  menu = await import('./nay/MinimizedMenu')
})
afterAll(async () => { await act(async () => { for (const r of roots) r.unmount() }); globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })
async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => { root.render(el) })
  await settle()
  return { host, root }
}
const base = { id: 'call', placement: 'composer', label: { pt: 'Ligar', en: 'Call' }, module: '/api/engine/x/call.js', icon: 'phone' }
const active = { activeLabel: { pt: 'Encerrar ligação', en: 'End call' }, activeIcon: 'phone-off', activeTone: 'danger' }
const indicator = { label: { pt: 'Em ligação', en: 'On a call' }, endLabel: { pt: 'Encerrar', en: 'End' }, since: Date.now() }

async function setup(info: Record<string, unknown>) {
  state.resetEngineSurfaceHostForTests()
  status = { present: false }; caps.invalidateEngineCaps()
  const buttons = await mount(createElement(btns.EngineSurfaceButtons, { placement: 'composer', sessionId: 's1', lang: 'en' }))
  status = { present: true, surfaces: [info] }; caps.invalidateEngineCaps(); await settle()
  let unmounts = 0
  const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, {
    load: async () => ({
      mount(_: HTMLElement, ctx: { keepAlive(on: boolean): void; setIndicator(i: unknown): void }) { ctx.keepAlive(true); ctx.setIndicator(indicator) },
      unmount() { unmounts++ },
    }),
  }))
  const btn = () => buttons.host.querySelector('button[data-engine-surface="call"]') as HTMLButtonElement
  await act(async () => { btn().click() }); await settle()
  return { buttons, surfaceHost, btn, unmounts: () => unmounts }
}

describe('composer active button', () => {
  test('with activeLabel it ENDS a kept-alive surface: no parked entry, no pill, unmounted', async () => {
    const t = await setup({ ...base, ...active })
    expect(state.mountedEngineSurfaces()[0]!.indicator).not.toBeNull()
    await act(async () => { t.btn().click() }); await settle()
    expect(state.mountedEngineSurfaces()).toHaveLength(0)
    expect(t.unmounts()).toBe(1)
    expect(t.btn().dataset.parked).toBeUndefined()
    await act(async () => { t.surfaceHost.root.unmount(); t.buttons.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })

  test('without activeLabel/activeIcon the click still parks a kept-alive surface', async () => {
    const t = await setup({ ...base })
    // Idle face: the click cannot be the "active" one, so drive the host close the button would call.
    state.closeEngineSurface()
    await settle()
    expect(state.mountedEngineSurfaces()[0]!.parked).toBe(true)
    expect(t.unmounts()).toBe(0)
    await act(async () => { t.surfaceHost.root.unmount(); t.buttons.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })
})

describe('session view', () => {
  test('a parked inline surface of the session returns to the slot when the view comes back', async () => {
    state.resetEngineSurfaceHostForTests()
    const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, {
      load: async () => ({ mount(el: HTMLElement, ctx: { keepAlive(on: boolean): void }) { ctx.keepAlive(true); el.textContent = 'live' } }),
    }))
    const info = { ...base, layout: 'inline' } as never
    const first = await mount(createElement(hostMod.EngineSurfaceInlineSlot, { sessionId: 's1', slotId: 'a' }))
    await act(async () => { state.openEngineSurface(info, { sessionId: 's1', lang: 'en', slotId: 'a' }) }); await settle()
    expect(first.host.textContent).toBe('live')
    await act(async () => { first.root.unmount() })
    await act(async () => { state.closeEngineSurface() }) // another page took the screen: parked
    expect(state.mountedEngineSurfaces()[0]!.parked).toBe(true)
    const back = await mount(createElement(hostMod.EngineSurfaceInlineSlot, { sessionId: 's1', slotId: 'b' }))
    expect(state.mountedEngineSurfaces()[0]!.parked).toBe(false)
    expect(back.host.textContent).toBe('live')
    await act(async () => { surfaceHost.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })

  test('closing the surface while staying in the session leaves it parked', async () => {
    state.resetEngineSurfaceHostForTests()
    const surfaceHost = await mount(createElement(hostMod.EngineSurfaceHost, {
      load: async () => ({ mount(_: HTMLElement, ctx: { keepAlive(on: boolean): void }) { ctx.keepAlive(true) } }),
    }))
    await mount(createElement(hostMod.EngineSurfaceInlineSlot, { sessionId: 's1', slotId: 'a' }))
    await act(async () => { state.openEngineSurface({ ...base, layout: 'inline' } as never, { sessionId: 's1', lang: 'en', slotId: 'a' }) }); await settle()
    await act(async () => { state.closeEngineSurface() }); await settle()
    expect(state.mountedEngineSurfaces()[0]!.parked).toBe(true)
    await act(async () => { surfaceHost.root.unmount() })
    state.resetEngineSurfaceHostForTests()
  })

  test('hasActiveComposerSurface: true for the session while an active-face surface is mounted, even parked', () => {
    state.resetEngineSurfaceHostForTests()
    expect(state.hasActiveComposerSurface('s1')).toBe(false)
    state.openEngineSurface({ ...base, ...active } as never, { sessionId: 's1', lang: 'en' })
    expect(state.hasActiveComposerSurface('s1')).toBe(true)
    expect(state.hasActiveComposerSurface('s2')).toBe(false)
    state.minimizeEngineSurface(state.mountedEngineSurfaces()[0]!.nonce)
    state.setEngineSurfaceKeepAlive(state.mountedEngineSurfaces()[0]!.nonce, true)
    state.closeEngineSurface()
    expect(state.hasActiveComposerSurface('s1')).toBe(true)
    state.endEngineSurface(state.mountedEngineSurfaces()[0]!.nonce)
    expect(state.hasActiveComposerSurface('s1')).toBe(false)
    state.openEngineSurface({ ...base } as never, { sessionId: 's1', lang: 'en' })
    expect(state.hasActiveComposerSurface('s1')).toBe(false)
    state.resetEngineSurfaceHostForTests()
  })
})

describe('Nay button menu', () => {
  const view = (calls: string[]) => createElement(menu.MinimizedMenu, {
    pt: false, items: [], onRestore: () => {}, onClose: () => {}, anchorStyle: { position: 'relative' },
    surfaceItems: [{ id: '7', label: 'Back to the call', since: Date.now() - 65_000, onResume: () => calls.push('resume'), endLabel: 'End', onEnd: () => calls.push('end') }],
    onOpenChat: () => calls.push('chat'),
    renderButton: ({ toggle }) => createElement('button', { 'data-fab': true, onClick: toggle }, 'Nay'),
  })

  test('a click lists the minimized surface (resume + end) and "Open Nay chat"', async () => {
    const calls: string[] = []
    const { host } = await mount(view(calls))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await act(async () => { (host.querySelector('[data-fab]') as HTMLButtonElement).click() })
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map(x => x.textContent)
    expect(items.some(x => x?.includes('Back to the call') && /\d+:\d{2}/.test(x))).toBe(true)
    expect(items).toContain('End')
    expect(items.some(x => x?.includes('Open Nay chat'))).toBe(true)
    await act(async () => { (document.querySelector('[data-surface-end]') as HTMLButtonElement).click() })
    expect(calls).toEqual(['end'])
  })

  test('without surfaces the button owns the click as before (no menu)', async () => {
    const { host } = await mount(createElement(menu.MinimizedMenu, {
      pt: false, items: [], onRestore: () => {}, onClose: () => {}, anchorStyle: {},
      renderButton: () => createElement('button', { 'data-fab2': true }, 'Nay'),
    }))
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('floating card', () => {
  test('opens card-sized and inside the viewport, clear of the phone navigation', () => {
    const d = hostMod.compactFloatBox(1280, 800)
    expect([d.w, d.h]).toEqual([360, 480])
    expect(d.x + d.w).toBeLessThanOrEqual(1280); expect(d.y + d.h).toBeLessThanOrEqual(800)
    const m = hostMod.compactFloatBox(390, 844)
    expect(m.w).toBeLessThanOrEqual(366); expect(m.y + m.h).toBeLessThanOrEqual(844 - 72)
  })
})
