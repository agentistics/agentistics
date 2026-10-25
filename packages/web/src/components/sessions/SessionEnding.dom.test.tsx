/**
 * Ending a session in a real DOM (happy-dom): Ending… from the kill until it settles, the
 * conversation kept mounted underneath (so a refused kill restores it, draft included).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let SessionEndingGate: typeof import('./SessionEnding').SessionEndingGate
let ending: typeof import('../../lib/endingSessions')
let originalActEnvironment: boolean | undefined

beforeAll(async () => {
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The loader animates through the Web Animations API; happy-dom rejects a cancelled animation. It skips itself when absent.
  Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })
  createRoot = (await import('react-dom/client')).createRoot
  SessionEndingGate = (await import('./SessionEnding')).SessionEndingGate
  ending = await import('../../lib/endingSessions')
})
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); ending.resetEnding() })

const show = (id: string, lang: 'pt' | 'en') => act(() => {
  root.render(createElement(SessionEndingGate, { id, lang, children: createElement('textarea', { 'data-composer': '', defaultValue: 'draft' }) }))
})
const overlay = () => host.querySelector('[data-session-ending]')
const composer = () => host.querySelector('[data-composer]') as HTMLTextAreaElement

test('Ending… shows from the kill until it settles; the composer stays mounted, hidden, then returns', () => {
  show('s1', 'en')
  expect(overlay()).toBeNull()
  act(() => ending.markEnding('s1'))
  expect(overlay()).not.toBeNull()
  expect(overlay()!.textContent).toContain('Ending…')
  expect(composer().value).toBe('draft')
  expect((composer().parentElement as HTMLElement).style.display).toBe('none')
  act(() => ending.unmarkEnding('s1'))
  expect(overlay()).toBeNull()
  expect(composer().value).toBe('draft')
  expect((composer().parentElement as HTMLElement).style.display).toBe('contents')
})

test('another session ending does not touch this one; Portuguese copy', () => {
  show('s1', 'pt')
  act(() => ending.markEnding('s2'))
  expect(overlay()).toBeNull()
  act(() => ending.markEnding('s1'))
  expect(overlay()!.textContent).toContain('Encerrando…')
})

test('useFleet marks every kill as ending and always clears it when the call settles', async () => {
  const src = await Bun.file(new URL('../../lib/fleet.ts', import.meta.url)).text()
  expect(src).toMatch(/req\.action !== 'kill'\) return actRaw\(req\)\s+markEnding\(req\.id\)\s+try \{ return await actRaw\(req\) \} finally \{ unmarkEnding\(req\.id\) \}/)
})

test("the aside row says 'Ending…' beside the title while its session is being ended, like the reopening status", async () => {
  const { SessionLine } = await import('../nav/SessionLine')
  const session = { id: 'row1', title: 'T', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'needs you', actionable: true, attachCommand: '', verbs: [] } as never
  act(() => root.render(createElement(SessionLine, { session, selected: false, onOpen: () => {}, lang: 'en' })))
  expect(host.querySelector('[data-row-ending]')).toBeNull()
  act(() => ending.markEnding('row1'))
  expect(host.querySelector('[data-row-ending]')!.textContent).toContain('Ending…')
  act(() => ending.unmarkEnding('row1'))
  expect(host.querySelector('[data-row-ending]')).toBeNull()
})
