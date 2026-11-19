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
