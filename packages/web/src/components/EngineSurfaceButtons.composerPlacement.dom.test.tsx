/**
 * Where a composer surface's button sits (owner, 2026-11-27): while ACTIVE (on screen from this
 * session) it is drawn immediately before Send/Stop, and is absent from the tool row; idle, parked or
 * active for ANOTHER session, it stays in the tool row. The harness mirrors SessionChat's composer
 * row — the tool row holds `only="inactive"`, the acting group holds `only="active"` right before the
 * send slot (pinned over SessionChat's source in `sessions/SessionChat.surfacePlacement.lint.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let mod: typeof import('./EngineSurfaceButtons')
let hostState: typeof import('../lib/engineSurfaceHost')
let caps: typeof import('../lib/engineCapsBus')
let originalFetch: typeof globalThis.fetch

const surface = {
  id: 'demo', placement: 'composer', label: { pt: 'Demo', en: 'Demo' }, module: '/api/engine/x/demo/mount.js',
  icon: 'sparkles', activeTone: 'danger', activeLabel: { pt: 'Encerrar', en: 'End it' },
}

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ present: true, surfaces: [surface] }), { status: 200 })
  createRoot = (await import('react-dom/client')).createRoot
  mod = await import('./EngineSurfaceButtons')
  hostState = await import('../lib/engineSurfaceHost')
  caps = await import('../lib/engineCapsBus')
})
const roots: Array<{ unmount(): void }> = []
afterAll(async () => {
  await act(async () => { for (const r of roots) r.unmount() })
  hostState.resetEngineSurfaceHostForTests()
  globalThis.fetch = originalFetch
  await GlobalRegistrator.unregister()
})
beforeEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount() })
  document.body.innerHTML = ''
  hostState.resetEngineSurfaceHostForTests()
  caps.invalidateEngineCaps()
})

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })

/** The composer row as SessionChat lays it out: tool row on the left, acting group on the right. */
function Row({ sessionId }: { sessionId: string }) {
  const common = { placement: 'composer' as const, sessionId, lang: 'en' as const }
  return h('div', { 'data-row': 'composer' },
    h('div', { 'data-tools': '' },
      h('button', { 'aria-label': 'Attach file' }),
      h(mod.EngineSurfaceButtons, { ...common, only: 'inactive' }),
      h('button', { 'aria-label': 'Task' })),
    h('div', { 'data-actions': '' },
      h('button', { 'aria-label': 'Mode' }),
      h(mod.EngineSurfaceButtons, { ...common, only: 'active' }),
      h('button', { 'aria-label': 'Send', 'data-send': '' })),
  )
}

async function mountRow(sessionId = 's1') {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(h(Row, { sessionId })) })
  await settle()
  return el
}
const surfaceIn = (el: HTMLElement, part: 'tools' | 'actions') => el.querySelectorAll(`[data-${part}] [data-engine-surface="demo"]`)
const send = (el: HTMLElement) => el.querySelector('[data-send]') as HTMLButtonElement

test('idle: the button is in the tool row only', async () => {
  const el = await mountRow()
  expect(surfaceIn(el, 'tools').length).toBe(1)
  expect(surfaceIn(el, 'actions').length).toBe(0)
  expect((send(el).previousElementSibling as HTMLElement).getAttribute('aria-label')).toBe('Mode')
})

test('active for this session: the button is the previous sibling of Send and absent from the tool row', async () => {
  const el = await mountRow()
  await act(async () => { hostState.openEngineSurface(surface as never, { sessionId: 's1', lang: 'en' }) })
  await settle()
  expect(surfaceIn(el, 'tools').length).toBe(0)
  expect(surfaceIn(el, 'actions').length).toBe(1)
  const prev = send(el).previousElementSibling as HTMLElement
  expect(prev.dataset.engineSurface).toBe('demo')
  expect(prev.dataset.active).toBe('true')
  expect(prev.getAttribute('aria-label')).toBe('End it')
  // Same size tokens as in the tool row.
  expect(prev.style.width).toBe('34px')
  expect(prev.style.height).toBe('34px')
  // Keyboard order: the button is the tab stop right before Send.
  const order: HTMLElement[] = Array.from(el.querySelectorAll('button'))
  expect(order[order.indexOf(send(el)) - 1]).toBe(prev)
})

test('parked: back to the tool row', async () => {
  const el = await mountRow()
  await act(async () => { hostState.openEngineSurface(surface as never, { sessionId: 's1', lang: 'en' }) })
  const n = hostState.mountedEngineSurfaces()[0]!.nonce
  await act(async () => { hostState.setEngineSurfaceKeepAlive(n, true); hostState.closeEngineSurface(n) })
  await settle()
  expect(hostState.mountedEngineSurfaces()[0]!.parked).toBe(true)
  const inTools = surfaceIn(el, 'tools')
  expect(inTools.length).toBe(1)
  expect((inTools[0] as HTMLElement).dataset.parked).toBe('true')
  expect(surfaceIn(el, 'actions').length).toBe(0)
})

test("another session's active surface: this composer keeps it in the tool row", async () => {
  const el = await mountRow('s1')
  await act(async () => { hostState.openEngineSurface(surface as never, { sessionId: 'other', lang: 'en' }) })
  await settle()
  expect(surfaceIn(el, 'tools').length).toBe(1)
  expect(surfaceIn(el, 'actions').length).toBe(0)
  expect((surfaceIn(el, 'tools')[0] as HTMLElement).dataset.active).toBeUndefined()
})

test('no filter: every face is drawn where the component is placed (other placements unchanged)', async () => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(h(mod.EngineSurfaceButtons, { placement: 'composer', sessionId: 's1', lang: 'en' })) })
  await settle()
  expect(el.querySelectorAll('[data-engine-surface="demo"]').length).toBe(1)
  await act(async () => { hostState.openEngineSurface(surface as never, { sessionId: 's1', lang: 'en' }) })
  await settle()
  expect(el.querySelectorAll('[data-engine-surface="demo"][data-active="true"]').length).toBe(1)
})
