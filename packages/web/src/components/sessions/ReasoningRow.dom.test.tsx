/**
 * The reasoning line in a real DOM (happy-dom): animated + ticking while the model reasons, `Raciocinou · N s` once over,
 * and the text opens on click and survives live updates.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let ReasoningRow: typeof import('./ReasoningRow').ReasoningRow
let originalActEnvironment: boolean | undefined
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(async () => {
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  ReasoningRow = (await import('./ReasoningRow')).ReasoningRow
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove(); root = null; host = null
})
afterAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})

async function mount(props: { running: boolean; text: string; startedAt: number | null; endedAt: number | null }) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(ReasoningRow, { text: props.text, running: props.running, clock: { startedAt: props.startedAt, endedAt: props.endedAt }, lang: 'pt' })))
  return host
}

test('running: a status line with the brain pulsing and the elapsed seconds; the text is not shown until asked', async () => {
  const h = await mount({ running: true, text: 'pensando em voz alta', startedAt: Date.now() - 12_000, endedAt: null })
  const label = h.querySelector('[role="status"]')!
  expect(label.textContent).toMatch(/^Raciocinando… · (11|12|13) s$/)
  expect(h.querySelector('.ag-reasoning-pulse')).not.toBeNull()
  expect(h.textContent).not.toContain('pensando em voz alta')
})

test('done: the past tense with its measured span, no pulse, and a click opens the text', async () => {
  const h = await mount({ running: false, text: 'pensando em voz alta', startedAt: 1000, endedAt: 13_000 })
  expect(h.textContent).toContain('Raciocinou · 12 s')
  expect(h.querySelector('.ag-reasoning-pulse')).toBeNull()
  const btn = h.querySelector('button')!
  expect(btn.getAttribute('aria-expanded')).toBe('false')
  await act(async () => { btn.click() })
  expect(btn.getAttribute('aria-expanded')).toBe('true')
  expect(h.textContent).toContain('pensando em voz alta')
})
