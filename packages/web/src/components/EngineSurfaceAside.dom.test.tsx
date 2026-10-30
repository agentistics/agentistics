/**
 * The engine `side` slot and the aside frame, in a real DOM (happy-dom): slot registration and ownership,
 * which aside a surface resolves to, who sees the surface, and that what the aside already holds is never
 * remounted when a side surface opens or closes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, useEffect } from 'react'
import type { EngineSurfaceInfo } from '../lib/engineSurfaces'

let createRoot: typeof import('react-dom/client').createRoot
let state: typeof import('../lib/engineSurfaceHost')
let asideMod: typeof import('./EngineSurfaceAside')

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  state = await import('../lib/engineSurfaceHost')
  asideMod = await import('./EngineSurfaceAside')
})
const roots: Array<{ unmount(): void }> = []
afterAll(async () => { await act(async () => { for (const r of roots) r.unmount() }); await GlobalRegistrator.unregister() })

const surface = {
  id: 'side-demo', placement: 'composer', layout: 'side', label: { pt: 'Lado', en: 'Side' }, module: '/api/engine/x/side/mount.js',
} as unknown as EngineSurfaceInfo
const open = (sessionId: string | null) => act(async () => { state.openEngineSurface(surface, { sessionId, lang: 'en' }) })
const close = () => act(async () => { state.endEngineSurface(state.currentEngineSurface()!.nonce) })

async function mount(el: ReturnType<typeof h>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => { root.render(el) })
  return { host, root }
}

describe('side slot store', () => {
  test('a slot is removed only by its own element; without a slot the fixed panel is used', async () => {
    state.resetEngineSurfaceHostForTests()
    const a = document.createElement('div'), b = document.createElement('div')
    await open('s1')
    expect(state.resolveSideSlot()).toBeNull()
    await act(async () => { state.registerEngineSideSlot('aside-main', 's1', a) })
    expect(state.resolveSideSlot()).toBe(a)
    expect(state.resolveSideSlotId()).toBe('aside-main')
    // An older element's late cleanup must not drop the slot that replaced it.
    await act(async () => { state.registerEngineSideSlot('aside-main', 's1', b) })
    await act(async () => { state.registerEngineSideSlot('aside-main', 's1', null, a) })
    expect(state.resolveSideSlot()).toBe(b)
    await act(async () => { state.registerEngineSideSlot('aside-main', 's1', null, b) })
    expect(state.resolveSideSlot()).toBeNull()
    state.resetEngineSurfaceHostForTests()
  })

  test('a slot of another session never receives the surface; the first slot of its session wins', async () => {
    state.resetEngineSurfaceHostForTests()
    const other = document.createElement('div'), first = document.createElement('div'), second = document.createElement('div')
    await open('s1')
    await act(async () => {
      state.registerEngineSideSlot('aside-other', 's2', other)
      state.registerEngineSideSlot('aside-main', 's1', first)
      state.registerEngineSideSlot('aside-split', 's1', second)
    })
    expect(state.resolveSideSlot()).toBe(first)
    expect(state.resolveSideSlotId()).toBe('aside-main')
    state.resetEngineSurfaceHostForTests()
  })

  test('useEngineSideSurface answers only for the session the visible side surface belongs to', async () => {
    state.resetEngineSurfaceHostForTests()
    const seen: Array<string | null> = []
    function Probe({ sid }: { sid: string | null }) {
      const s = state.useEngineSideSurface(sid)
      seen.push(s ? s.surface.id : null)
      return null
    }
    await mount(h(Probe, { sid: 's1' }))
    expect(seen.at(-1)).toBeNull()
    await open('s1')
    expect(seen.at(-1)).toBe('side-demo')
    const other = await mount(h(Probe, { sid: 's2' }))
    expect(seen.at(-1)).toBeNull()
    other.root.unmount()
    await close()
    expect(seen.at(-1)).toBeNull()
    state.resetEngineSurfaceHostForTests()
  })
})

describe('EngineSurfaceAside', () => {
  const noop = () => {}
  function Held({ log }: { log: string[] }) {
    useEffect(() => { log.push('mount'); return () => { log.push('unmount') } }, [log])
    return h('span', { 'data-held': '' }, 'held')
  }
  const render = (log: string[], engine: Parameters<typeof asideMod.EngineSurfaceAside>[0]['engine'], extra: { shown?: boolean; showStrip?: boolean } = {}) =>
    h(asideMod.EngineSurfaceAside, {
      engine, shown: extra.shown ?? true, panelsLabel: 'Panels', onPickEngine: noop, onPickPanels: noop, showStrip: extra.showStrip ?? true,
    }, h(Held, { log }))

  test('what the aside holds keeps its identity while a side surface opens and closes', async () => {
    state.resetEngineSurfaceHostForTests()
    const log: string[] = []
    const { host, root } = await mount(render(log, null))
    const node = host.querySelector('[data-held]')
    expect(log).toEqual(['mount'])
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    const section = { sessionId: 's1', slotId: 'aside-main', label: 'Side', owned: true }
    await act(async () => { root.render(render(log, section)) })
    expect(host.querySelector('[role="tablist"]')).not.toBeNull()
    expect(host.querySelector('[data-engine-side-slot="aside-main"]')).not.toBeNull()
    expect(host.querySelector('[data-held]')).toBe(node)
    await act(async () => { root.render(render(log, section, { shown: false })) })
    expect(host.querySelector('[data-held]')).toBe(node)
    await act(async () => { root.render(render(log, null)) })
    expect(host.querySelector('[data-held]')).toBe(node)
    expect(host.querySelector('[data-engine-side-slot]')).toBeNull()
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(log).toEqual(['mount'])
  })

  test('the strip is not drawn on a phone, nor by an aside that does not own the slot', async () => {
    state.resetEngineSurfaceHostForTests()
    const log: string[] = []
    const section = { sessionId: 's1', slotId: 'aside-split', label: 'Side', owned: false }
    const { host, root } = await mount(render(log, section))
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    await act(async () => { root.render(render(log, { ...section, owned: true }, { showStrip: false })) })
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    await act(async () => { root.render(render(log, { ...section, owned: true })) })
    expect(host.querySelectorAll('[role="tab"]').length).toBe(2)
  })
})
