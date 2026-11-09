import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { EngineSurfaceInfo } from '../lib/engineSurfaces'

let createRoot: typeof import('react-dom/client').createRoot
let state: typeof import('../lib/engineSurfaceHost')
let frame: typeof import('./nay/NayWindowFrame')
let bridge: typeof import('../lib/nayDockBridge')
const roots: Array<{ unmount(): void }> = []
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  state = await import('../lib/engineSurfaceHost')
  frame = await import('./nay/NayWindowFrame')
  bridge = await import('../lib/nayDockBridge')
})
afterAll(async () => {
  await act(async () => { for (const root of roots) root.unmount(); state.resetEngineSurfaceHostForTests() })
  await GlobalRegistrator.unregister()
})
const call: EngineSurfaceInfo = {
  id: 'call', placement: 'composer', layout: 'inline', label: { pt: 'Ligar', en: 'Call' },
  activeLabel: { pt: 'Em ligação', en: 'On a call' }, module: '/api/engine/x/call.js',
}
async function render(element: ReturnType<typeof h>) {
  const el = document.createElement('div'); document.body.append(el)
  const root = createRoot(el); roots.push(root)
  await act(async () => { root.render(element) })
  return { el, root }
}
async function startCall(sessionId: string) {
  const slot = document.createElement('div'); document.body.append(slot)
  await act(async () => {
    state.openEngineSurface(call, { sessionId, lang: 'en', slotId: 'composer' })
    state.registerEngineSessionView('composer', sessionId)
    state.registerEngineInlineSlot('composer', sessionId, slot)
    state.setEngineSurfaceKeepAlive(state.currentEngineSurface()!.nonce, true)
  })
  return slot
}

test('leaving the session mid-call asks the dock for a detached window: parked, no float, adopted by the window', async () => {
  state.resetEngineSurfaceHostForTests()
  const asked: string[] = []
  const onUndock = (e: Event) => { asked.push((e as CustomEvent<{ id: string }>).detail.id); e.preventDefault() }
  window.addEventListener(bridge.NAY_UNDOCK_SESSION, onUndock)
  const slot = await startCall('s1')
  const nonce = state.currentEngineSurface()!.nonce
  await act(async () => { state.registerEngineInlineSlot('composer', 's1', null, slot); state.registerEngineSessionView('composer', null) })
  expect(asked).toEqual(['s1'])
  const s = state.mountedEngineSurfaces().find(x => x.nonce === nonce)
  expect(s?.layout).toBe('inline')
  expect(s?.parked).toBe(true)
  // The detached window's SessionChat mounts its own inline slot and adopts the call.
  const winSlot = document.createElement('div'); document.body.append(winSlot)
  await act(async () => {
    state.registerEngineSessionView('window-composer', 's1')
    state.registerEngineInlineSlot('window-composer', 's1', winSlot)
    state.resumeParkedInlineSurfaces('s1')
  })
  const back = state.currentEngineSurface()!
  expect(back.nonce).toBe(nonce)
  expect(back.layout).toBe('inline')
  expect(back.parked).toBe(false)
  expect(state.resolveInlineSlot()).toBe(winSlot)
  window.removeEventListener(bridge.NAY_UNDOCK_SESSION, onUndock)
  state.resetEngineSurfaceHostForTests()
})

test('with no dock listening (a phone) the call floats exactly as before', async () => {
  state.resetEngineSurfaceHostForTests()
  const slot = await startCall('s2')
  await act(async () => { state.registerEngineInlineSlot('composer', 's2', null, slot); state.registerEngineSessionView('composer', null) })
  expect(state.mountedEngineSurfaces()[0]!.layout).toBe('float')
  state.resetEngineSurfaceHostForTests()
})

test('a detached window never shows an X: only minimize; the float popup keeps its own', async () => {
  const win = { id: 's3', x: 40, y: 40, w: 520, h: 600, minimized: false, z: 1 }
  let minimized = 0, closed = 0
  const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
  const probe = (canClose: boolean) => h(frame.NayWindowFrame, { win, lang: 'en' as const, title: 'S3', onFocus: () => {}, onMove: () => {}, onMinimize: () => { minimized++ }, onClose: () => { closed++ }, canClose, children: h('span', null, 'body') })
  const detached = await render(probe(false))
  expect(btn('Close the window')).toBeNull()
  await act(async () => { btn('Minimize')!.click() })
  expect(minimized).toBe(1); expect(closed).toBe(0)
  await act(async () => { detached.root.unmount() })
  detached.el.remove()
  const popup = await render(probe(true))
  expect(btn('Close the window')).not.toBeNull()
  await act(async () => { popup.root.unmount() })
})

test('minimized detached windows: reopen through the normal flow; close from the menu, except mid-call', () => {
  const dock = require('../lib/nayDock') as typeof import('../lib/nayDock')
  const vp = { w: 1280, h: 800 }
  let d = dock.detachSession({ open: false, panelSession: null, windows: [] }, 's1', vp)
  d = dock.minimizeWindow(d, 's1')
  expect(d.windows[0]!.minimized).toBe(true)
  // Normal flow (Nay -> the session) restores the window.
  expect(dock.openSession(d, 's1').windows[0]!.minimized).toBe(false)
  // Mid-call the menu's close brings the window back instead of orphaning the call.
  expect(dock.closeMinimizedWindow(d, 's1', true).windows[0]!.minimized).toBe(false)
  expect(dock.closeMinimizedWindow(d, 's1', false).windows).toHaveLength(0)
})

test('undock requests: automatic keeps a minimized window minimized, the menu (manual) restores it', () => {
  const dock = require('../lib/nayDock') as typeof import('../lib/nayDock')
  const vp = { w: 1280, h: 800 }
  const base = dock.minimizeWindow(dock.detachSession({ open: false, panelSession: null, windows: [] }, 's1', vp), 's1')
  expect(dock.applyUndockRequest(base, 's1', vp, false).windows[0]!.minimized).toBe(true)
  expect(dock.applyUndockRequest(base, 's1', vp, true).windows[0]!.minimized).toBe(false)
  // No window yet: both kinds open one.
  const none = { open: false, panelSession: null, windows: [] }
  expect(dock.applyUndockRequest(none, 's2', vp, false).windows).toHaveLength(1)
  expect(dock.applyUndockRequest(none, 's2', vp, true).windows).toHaveLength(1)
})

test('requestUndockSession carries the manual flag; the default is automatic', () => {
  const seen: Array<{ id: string; manual: boolean }> = []
  const on = (e: Event) => { seen.push((e as CustomEvent<{ id: string; manual: boolean }>).detail); e.preventDefault() }
  window.addEventListener(bridge.NAY_UNDOCK_SESSION, on)
  expect(bridge.requestUndockSession('a')).toBe(true)
  expect(bridge.requestUndockSession('b', { manual: true })).toBe(true)
  window.removeEventListener(bridge.NAY_UNDOCK_SESSION, on)
  expect(seen).toEqual([{ id: 'a', manual: false }, { id: 'b', manual: true }])
})

test('an open Picture-in-Picture window: leaving the session undocks nothing and floats nothing; closed PiP behaves as before', async () => {
  const g = globalThis as { documentPictureInPicture?: unknown }
  for (const [pip, expectUndock] of [[{ window: { closed: false } }, false], [{ window: { closed: true } }, true], [{ window: null }, true], [undefined, true]] as const) {
    state.resetEngineSurfaceHostForTests()
    g.documentPictureInPicture = pip
    const asked: string[] = []
    const onUndock = (e: Event) => { asked.push((e as CustomEvent<{ id: string }>).detail.id); e.preventDefault() }
    window.addEventListener(bridge.NAY_UNDOCK_SESSION, onUndock)
    const slot = await startCall('sp')
    await act(async () => { state.registerEngineInlineSlot('composer', 'sp', null, slot); state.registerEngineSessionView('composer', null) })
    const s = state.mountedEngineSurfaces()[0]!
    if (expectUndock) {
      expect(asked).toEqual(['sp']); expect(s.parked).toBe(true)
    } else {
      expect(asked).toEqual([]); expect(s.parked).toBe(false); expect(s.layout).toBe('inline')
    }
    window.removeEventListener(bridge.NAY_UNDOCK_SESSION, onUndock)
  }
  delete g.documentPictureInPicture
  state.resetEngineSurfaceHostForTests()
})
