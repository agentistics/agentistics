/**
 * Ending a session something live is using is refused the first time, in words (the engine's own sentence); the
 * existing confirm dialog asks once more and only that second, explicit confirm sends `force: true` (cuts it off on purpose).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { FleetRow } from '../../lib/fleet'

let createRoot: typeof import('react-dom/client').createRoot
let SessionActions: typeof import('./SessionActions').SessionActions

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })
  class FakeEventSource { readyState = 0; constructor(public url: string) {} addEventListener() {} removeEventListener() {} close() {} }
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  ;(window as unknown as { EventSource?: unknown }).EventSource = FakeEventSource
  globalThis.fetch = (async () => new Response('{"options":[],"enabled":false}', { status: 200, headers: { 'content-type': 'application/json' } })) as never
  createRoot = (await import('react-dom/client')).createRoot
  SessionActions = (await import('./SessionActions')).SessionActions
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); await GlobalRegistrator.unregister() })

const row = {
  id: 'agentop-abc', title: 'Líder', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'waiting', actionable: true, attachCommand: '',
  verbs: [{ action: 'kill', label: 'End', enabled: true }],
} as unknown as FleetRow

const byText = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined

test('first press refused with held → a second dialog; its confirm re-sends with force; cancel sends nothing', async () => {
  const calls: Array<{ id: string; action: string; force?: boolean }> = []
  const act_ = async (req: { id: string; action: string; force?: boolean }) => {
    calls.push(req)
    return req.force ? { ok: true, message: '' } : { ok: false, held: true as const, message: 'This session is in use right now: engine words (3 min ago). Ending it cuts off whatever uses it.' }
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(SessionActions, { row, lang: 'en', inline: true, act: act_ as never })) })
  await act(async () => { byText(host, 'End')!.click() }) // the verb → the existing stop confirmation
  expect(calls).toEqual([])
  await act(async () => { byText(host, 'End')!.click(); await new Promise(r => setTimeout(r, 10)) }) // the stop confirmation's own End
  expect(calls).toEqual([{ id: 'agentop-abc', action: 'kill' }]) // refused: no force
  const dialog = document.body.textContent ?? ''
  expect(dialog).toContain('End anyway?')
  expect(dialog).toContain('engine words')
  await act(async () => { byText(document.body, 'Cancel')!.click() })
  expect(calls).toHaveLength(1)
  // press again → refused again → confirm
  await act(async () => { byText(host, 'End')!.click() })
  await act(async () => { byText(host, 'End')!.click(); await new Promise(r => setTimeout(r, 10)) })
  await act(async () => { byText(document.body, 'End anyway')!.click(); await new Promise(r => setTimeout(r, 10)) })
  expect(calls.at(-1)).toEqual({ id: 'agentop-abc', action: 'kill', force: true })
  root.unmount()
})
