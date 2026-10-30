import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { EngineSurfaceInfo, SurfaceMountContext } from '../lib/engineSurfaces'

let createRoot: typeof import('react-dom/client').createRoot
let state: typeof import('../lib/engineSurfaceHost')
let host: typeof import('./EngineSurfaceHost')
let badge: typeof import('./EngineSurfaceNayBadge')
const roots: Array<{ unmount(): void }> = []
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  state = await import('../lib/engineSurfaceHost')
  host = await import('./EngineSurfaceHost')
  badge = await import('./EngineSurfaceNayBadge')
})
afterAll(async () => {
  await act(async () => { for (const root of roots) root.unmount(); state.resetEngineSurfaceHostForTests() })
  await GlobalRegistrator.unregister()
})
const surface: EngineSurfaceInfo = { id: 'float-demo', placement: 'composer', layout: 'float', label: { pt: 'Demo', en: 'Demo' }, module: '/api/engine/x/demo.js' }
async function render(element: ReturnType<typeof h>) {
  const el = document.createElement('div'); document.body.append(el)
  const root = createRoot(el); roots.push(root)
  await act(async () => { root.render(element) })
  return { el, root }
}

test('float → minimize → live Nay badge → restore keeps the same element, even without keepAlive', async () => {
  state.resetEngineSurfaceHostForTests()
  let mounts = 0, unmounts = 0
  let element: HTMLElement | undefined
  const view = await render(h(host.EngineSurfaceHost, { load: async () => ({ mount(el: HTMLElement) { mounts++; element = el; el.textContent = 'running' }, unmount() { unmounts++ } }) }))
  function NayButton() {
    const surfaces = state.useMountedEngineSurfaces().filter(s => s.parked && s.layout === 'float')
    return h('button', { 'data-nay-fab': true, onClick: () => state.resumeEngineSurface(surfaces[0]!.nonce) }, h(badge.EngineSurfaceNayBadge, { surfaces, lang: 'en' }))
  }
  const fab = await render(h(NayButton))
  await act(async () => { state.openEngineSurface(surface, { sessionId: 's1', lang: 'en' }) })
  const stable = element!
  expect(document.querySelector('[data-layout="float"]')?.contains(stable)).toBe(true)
  await act(async () => { (document.querySelector('button[aria-label="Minimize"]') as HTMLButtonElement).click() })
  expect(stable.isConnected).toBe(true)
  expect(stable.closest('[data-engine-parked]')).not.toBeNull()
  expect(fab.el.querySelector('[data-engine-nay-badge]')?.textContent).toBe('1')
  await act(async () => { fab.el.querySelector('button')!.click() })
  expect(element).toBe(stable)
  expect(document.querySelector('[data-layout="float"]')?.contains(stable)).toBe(true)
  expect(fab.el.querySelector('[data-engine-nay-badge]')).toBeNull()
  expect(mounts).toBe(1); expect(unmounts).toBe(0)
  await act(async () => { view.root.unmount(); fab.root.unmount(); state.resetEngineSurfaceHostForTests() })
})

test('leaving a session floats kept-alive inline and side layouts, with opt-out and no forced aside', async () => {
  for (const layout of ['inline', 'side'] as const) for (const floatOnLeave of [undefined, true, false]) {
    state.resetEngineSurfaceHostForTests()
    const slot = document.createElement('div'); document.body.append(slot)
    await act(async () => {
      state.registerEngineSideWant('aside-main', 's1')
      state.openEngineSurface({ ...surface, layout, floatOnLeave }, { sessionId: 's1', lang: 'en' })
      state.registerEngineInlineSlot('composer', 's1', slot)
      state.setEngineSurfaceKeepAlive(state.currentEngineSurface()!.nonce, true)
    })
    const nonce = state.currentEngineSurface()!.nonce
    await act(async () => { state.registerEngineInlineSlot('composer', 's1', null, slot); state.registerEngineSideWant('aside-main', 's2') })
    expect(state.currentEngineSurface()!.layout).toBe(floatOnLeave === false ? layout : 'float')
    expect(state.currentEngineSurface()!.nonce).toBe(nonce)
    expect(state.resolveSideAsideId()).toBeNull()
    slot.remove()
  }
  state.resetEngineSurfaceHostForTests()
})

test('a Nay tab moves the same mounted element off screen when its panel closes and restores it', async () => {
  state.resetEngineSurfaceHostForTests()
  let mounts = 0, element: HTMLElement | undefined
  let ctx: SurfaceMountContext | undefined
  const view = await render(h(host.EngineSurfaceHost, { load: async () => ({ mount(el: HTMLElement, context: SurfaceMountContext) { mounts++; element = el; ctx = context } }) }))
  const tab = await render(h(host.EngineSurfaceNaySlot, { surfaceId: surface.id }))
  await act(async () => { state.openEngineSurface({ ...surface, placement: 'nay-tab', layout: undefined }, { sessionId: null, lang: 'en' }) })
  const stable = element!
  expect(tab.el.contains(stable)).toBe(true)
  expect(document.querySelector('[data-engine-overlay]')).toBeNull()
  await act(async () => { tab.root.render(null) })
  expect(stable.isConnected).toBe(true)
  expect(stable.closest('[data-engine-parked]')).not.toBeNull()
  await act(async () => { tab.root.render(h(host.EngineSurfaceNaySlot, { surfaceId: surface.id })) })
  expect(tab.el.contains(stable)).toBe(true)
  expect(mounts).toBe(1)
  await act(async () => { ctx!.close(); view.root.unmount(); tab.root.unmount(); state.resetEngineSurfaceHostForTests() })
})

test('a side surface in a standalone session view floats on leave, while a second view prevents it', async () => {
  state.resetEngineSurfaceHostForTests()
  let mounts = 0, element: HTMLElement | undefined
  const view = await render(h(host.EngineSurfaceHost, { load: async () => ({ mount(el: HTMLElement, ctx: SurfaceMountContext) { mounts++; element = el; ctx.keepAlive(true) } }) }))
  const session = await render(h(host.EngineSurfaceInlineSlot, { sessionId: 'standalone', slotId: 'one' }))
  const second = await render(h(host.EngineSurfaceInlineSlot, { sessionId: 'standalone', slotId: 'two' }))
  await act(async () => { state.openEngineSurface({ ...surface, layout: 'side' }, { sessionId: 'standalone', lang: 'en' }) })
  const stable = element!
  await act(async () => { session.root.render(null) })
  expect(state.currentEngineSurface()!.layout).toBe('side')
  await act(async () => { second.root.render(null) })
  expect(state.currentEngineSurface()!.layout).toBe('float')
  expect(document.querySelector('[data-layout="float"]')?.contains(stable)).toBe(true)
  expect(mounts).toBe(1)
  await act(async () => { view.root.unmount(); session.root.unmount(); second.root.unmount(); state.resetEngineSurfaceHostForTests() })
})

test('surface-submitted text is visible in the user bubble with a microphone chip', async () => {
  const { ChatBubble } = await import('./sessions/ChatBubble')
  const view = await render(h(ChatBubble, { turn: { role: 'user', text: '[from agentistics · surface]\n[Internal instructions.]\n\nShow my tasks.' }, lang: 'en', harness: 'claude' }))
  expect(view.el.textContent).toContain('Show my tasks.')
  expect(view.el.querySelector('.lucide-user')).not.toBeNull()
  expect(view.el.querySelector('[data-surface-turn] .lucide-mic')).not.toBeNull()
  expect(view.el.textContent).not.toContain('Internal instructions')
  expect(view.el.textContent).not.toContain('from agentistics')
  await act(async () => { view.root.unmount() })
})
