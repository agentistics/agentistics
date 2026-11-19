/**
 * A phone drawer unmounts its row menu while a kill is in flight (the session is marked as ending).
 * Ending a session something live is using is refused the first time, in words (the engine's own sentence); the
 * existing confirm dialog asks once more and only that second, explicit confirm sends `force: true` (cuts it off on purpose).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { FleetRow } from '../../lib/fleet'

let createRoot: typeof import('react-dom/client').createRoot
let SessionActions: typeof import('./SessionActions').SessionActions
let HeldKillHost: typeof import('./HeldKillHost').HeldKillHost
let Drawer: typeof import('../Drawer').Drawer
let originalFetch: typeof globalThis.fetch

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  // Plain assignment (writable): a non-writable property would make a later test's own assignment throw.
  ;(Element.prototype as unknown as { animate: unknown }).animate = undefined
  class FakeEventSource { readyState = 0; constructor(public url: string) {} addEventListener() {} removeEventListener() {} close() {} }
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  ;(window as unknown as { EventSource?: unknown }).EventSource = FakeEventSource
  globalThis.fetch = (async () => new Response('{"options":[],"enabled":false}', { status: 200, headers: { 'content-type': 'application/json' } })) as never
  createRoot = (await import('react-dom/client')).createRoot
  SessionActions = (await import('./SessionActions')).SessionActions
  HeldKillHost = (await import('./HeldKillHost')).HeldKillHost
  Drawer = (await import('../Drawer')).Drawer
})
afterAll(async () => {
  await new Promise(r => setTimeout(r, 50))
  globalThis.fetch = originalFetch
  delete (globalThis as { EventSource?: unknown }).EventSource
  await GlobalRegistrator.unregister()
})

const row = {
  id: 'agentop-abc', title: 'Líder', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'waiting', actionable: true, attachCommand: '',
  verbs: [{ action: 'kill', label: 'End', enabled: true }],
} as unknown as FleetRow

const byText = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined

test('menu unmounted before the held refusal lands → the page-level host still asks, and its confirm forces', async () => {
  const calls: Array<{ id: string; action: string; force?: boolean }> = []
  let release: (v: unknown) => void = () => {}
  const act_ = (req: { id: string; action: string; force?: boolean }) => {
    calls.push(req)
    return req.force ? Promise.resolve({ ok: true, message: '' }) : new Promise(r => { release = r })
  }
  const menuHost = document.createElement('div'); document.body.appendChild(menuHost)
  const pageHost = document.createElement('div'); document.body.appendChild(pageHost)
  const menuRoot = createRoot(menuHost); const pageRoot = createRoot(pageHost)
  let ended = 0
  await act(async () => { pageRoot.render(createElement(HeldKillHost, { lang: 'en', act: act_ as never, onEnded: () => { ended++ } })) })
  await act(async () => { menuRoot.render(createElement(SessionActions, { row, lang: 'en', inline: true, act: act_ as never })) })
  await act(async () => { byText(menuHost, 'End')!.click() })
  await act(async () => { byText(menuHost, 'End')!.click() })
  expect(calls).toEqual([{ id: 'agentop-abc', action: 'kill' }])
  await act(async () => { menuRoot.unmount() }) // the drawer closes: ending
  await act(async () => { release({ ok: false, held: true, message: 'In use right now: engine words.' }); await new Promise(r => setTimeout(r, 10)) })
  expect(document.body.textContent).toContain('End anyway?')
  expect(document.body.textContent).toContain('engine words')
  await act(async () => { byText(document.body, 'End anyway')!.click(); await new Promise(r => setTimeout(r, 10)) })
  expect(calls.at(-1)).toEqual({ id: 'agentop-abc', action: 'kill', force: true })
  expect(ended).toBe(1)
  expect(document.body.textContent).not.toContain('End anyway?')
  pageRoot.unmount()
})

// The real phone case: the Drawer is still MOUNTED (phase `leaving`) when the refusal lands, so the menu is not
// unmounted and used to open its own dialog inside the sliding panel, which went away with it.
test('a REAL drawer that is closing when the held refusal lands → the page-level host asks, outside the drawer', async () => {
  const calls: Array<{ id: string; action: string; force?: boolean }> = []
  let release: (v: unknown) => void = () => {}
  const act_ = (req: { id: string; action: string; force?: boolean }) => {
    calls.push(req)
    return req.force ? Promise.resolve({ ok: true, message: '' }) : new Promise(r => { release = r })
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const tree = (open: boolean) => createElement('div', null,
    createElement(HeldKillHost, { lang: 'en', act: act_ as never }),
    createElement(Drawer, { open, title: 'x', onClose: () => {}, side: 'left', lang: 'en' } as never,
      createElement(SessionActions, { row, lang: 'en', inline: true, heldToHost: true, act: act_ as never })))
  await act(async () => { root.render(tree(true)) })
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  await act(async () => { byText(host, 'End')!.click() })
  await act(async () => { byText(host, 'End')!.click() })
  expect(calls).toEqual([{ id: 'agentop-abc', action: 'kill' }])
  await act(async () => { root.render(tree(false)) }) // ending closes the drawer: phase `leaving`, still mounted
  await act(async () => { release({ ok: false, held: true, message: 'In use right now: engine words.' }); await new Promise(r => setTimeout(r, 10)) })
  const dialogs = Array.from(document.body.querySelectorAll('*')).filter(e => e.textContent?.includes('End anyway?') && e.children.length === 0)
  expect(dialogs.length).toBeGreaterThan(0)
  // The dialog lives outside the drawer panel, which is what keeps it alive and on screen.
  expect(dialogs.every(d => !d.closest('[data-drawer-side]'))).toBe(true)
  await act(async () => { byText(document.body, 'End anyway')!.click(); await new Promise(r => setTimeout(r, 10)) })
  expect(calls.at(-1)).toEqual({ id: 'agentop-abc', action: 'kill', force: true })
  root.unmount()
})

test('a question about a session that is gone is dropped, and cancelling then re-mounting never reopens it', async () => {
  const { offerHeldKill, peekHeldKill } = await import('../../lib/heldKill')
  const act_ = () => Promise.resolve({ ok: true, message: '' })
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  let live = true
  const tree = () => createElement(HeldKillHost, { lang: 'en', act: act_ as never, stillValid: () => live })
  await act(async () => { root.render(tree()) })
  await act(async () => { offerHeldKill({ id: 'agentop-abc', message: 'In use: words.' }) })
  expect(document.body.textContent).toContain('End anyway?')
  await act(async () => { byText(document.body, 'Cancel')!.click() })
  expect(peekHeldKill()).toBeNull()
  await act(async () => { root.unmount() })
  const host2 = document.createElement('div'); document.body.appendChild(host2)
  const root2 = createRoot(host2)
  await act(async () => { root2.render(tree()) }) // navigating: a new host mounts
  expect(document.body.textContent).not.toContain('End anyway?')
  await act(async () => { offerHeldKill({ id: 'agentop-abc', message: 'again' }) })
  live = false
  await act(async () => { root2.render(tree()) })
  expect(peekHeldKill()).toBeNull()
  expect(document.body.textContent).not.toContain('End anyway?')
  root2.unmount()
})
