/**
 * A chat note with an arrow ("tarefa em segundo plano respondeu ↗") is a real button: clicking it
 * (or pressing Enter/Space on it) publishes a panel request for the tab it names, with the ref the
 * note carries, even when that panel is already open.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let ChatBubble: typeof import('./ChatBubble').ChatBubble
let store: typeof import('../../lib/artifactsStore')

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1000, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  ChatBubble = (await import('./ChatBubble')).ChatBubble
  store = await import('../../lib/artifactsStore')
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); await GlobalRegistrator.unregister() })

test('the background-task note is a button; click and keyboard open the Agents panel on its ref, twice', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(createElement(ChatBubble, {
      turn: { role: 'user', text: 'background task reported back', system: 'background task reported back', systemRef: 'toolu_01ABC' } as never,
      lang: 'pt', harness: 'claude', sessionId: 's1',
    } as never))
  })
  const btn = host.querySelector('button')!
  expect(btn.textContent).toContain('tarefa em segundo plano respondeu')
  act(() => { btn.click() })
  const first = store.getPanelFocusRequest()
  expect(first?.tab).toBe('agents')
  expect(first?.ref).toBe('toolu_01ABC')
  // The panel is open now: a second click must still be a distinct, visible request.
  await new Promise(r => setTimeout(r, 3))
  act(() => { btn.click() })
  expect(store.getPanelFocusRequest()!.at).toBeGreaterThan(first!.at)
  // A real <button> is focusable and Enter/Space activate it natively.
  expect(btn.tagName).toBe('BUTTON')
  expect(btn.disabled).toBe(false)
  act(() => root.unmount())
  host.remove()
})
