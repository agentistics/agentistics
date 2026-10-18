/** The pending-close state as a person sees it: row, tab, and the open conversation. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

let SessionRow: typeof import('../nav/SessionsAside').SessionRow
let store: typeof import('../../lib/closingSessions')
let createRoot: typeof import('react-dom/client').createRoot
let MemoryRouter: typeof import('react-router-dom').MemoryRouter

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  SessionRow = (await import('../nav/SessionsAside')).SessionRow
  store = await import('../../lib/closingSessions')
})
afterAll(async () => {
  await new Promise(r => setTimeout(r, 50))
  await GlobalRegistrator.unregister()
})

const s = {
  id: 'x1', title: 'A session with a really long title that must fade out instead of wrapping onto two lines', harness: 'claude', cwd: '/x', project: 'x',
  state: 'waiting', stateLabel: 'needs you', actionable: true, attachCommand: '', verbs: [], task: 'A very long task title that used to wrap under the title', model: 'claude-opus-5-5',
} as unknown as ControlSession

test('row: one line, task only in the hover card; closing dims it, shows the ring and "closing", ignores the click', async () => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  let opened = 0
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(SessionRow, { session: s, selected: false, cardColor: 'wash', lang: 'en', onOpen: () => { opened++ } }))))
  const row = host.querySelector<HTMLElement>('[data-session-row]')!
  expect(row.textContent).not.toContain('A very long task title')
  // plain row: no state tint, no coloured edge — only the open row is highlighted
  expect(row.style.background).toBe('transparent')
  expect(row.style.boxShadow).toBe('none')
  expect(row.querySelector('[data-row-tail]')!.textContent).toBe('you')
  expect(row.style.opacity).toBe('1')
  // hover card carries the task and the model
  const open = row.querySelector<HTMLElement>('[data-session-open]')!
  await act(async () => { open.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 400)) })
  const card = document.querySelector('[role="tooltip"][data-session-hover-card]')
  expect(card?.textContent).toContain('A very long task title')
  // closing
  await act(async () => { store.beginClosing('x1') })
  expect(row.style.opacity).toBe('0.75')
  expect(row.querySelector('[data-closing-ring]')).not.toBeNull()
  expect(row.querySelector('[data-row-tail]')!.textContent).toBe('closing')
  await act(async () => { open.click() })
  expect(opened).toBe(0)
  await act(async () => { store.clearClosing('x1') })
  expect(row.style.opacity).toBe('1')
  expect(row.querySelector('[data-closing-ring]')).toBeNull()
  await act(async () => root.unmount())
})
