import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

// CONTAS.AGENDA-SALVAR r4 · N1: on desktop the trigger of "Uso dos planos" is the prototype's LABELLED pill
// (dot + "Uso dos planos"), not only a gauge icon in the footer icon row.
let createRoot: typeof import('react-dom/client').createRoot
let PlanUsageFootButton: typeof import('./PlanUsageFootButton').PlanUsageFootButton
let host: HTMLDivElement
let root: Root
let originalFetch: typeof fetch

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  globalThis.fetch = (async (url: string) => String(url) === '/api/plan-limits'
    ? Response.json({ limits: [], registered: [], budgets: [], hiddenFromAgents: [] })
    : Response.json({ accounts: [] })) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  PlanUsageFootButton = (await import('./PlanUsageFootButton')).PlanUsageFootButton
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

async function mount(collapsed: boolean) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(createElement(PlanUsageFootButton, { lang: 'pt', collapsed, footBtn: { width: 34, height: 34 } })) })
  return host.querySelector('button') as HTMLButtonElement
}

test('N1: expanded, the trigger is a pill with a visible "Uso dos planos" label and a dot', async () => {
  const btn = await mount(false)
  expect(btn.textContent).toContain('Uso dos planos')
  expect(btn.querySelector('[data-plan-usage-dot]')).not.toBeNull()
  expect(btn.querySelector('svg')).toBeNull() // the label replaces the gauge icon
  expect(btn.style.borderRadius).toBe('99px')
})

test('N1: the pill opens the existing popup (hover or focus) and marks itself hot while open', async () => {
  const btn = await mount(false)
  expect(document.querySelector('[data-plan-usage-popover]')).toBeNull()
  await act(async () => { btn.focus() })
  expect(document.querySelector('[data-plan-usage-popover]')).not.toBeNull()
  expect(btn.getAttribute('aria-expanded')).toBe('true')
  expect(btn.getAttribute('data-plan-usage-hot')).toBe('true')
})

test('N1: collapsed sidebar keeps the compact gauge icon (no room for a label)', async () => {
  const btn = await mount(true)
  expect(btn.querySelector('svg')).not.toBeNull()
  expect(btn.textContent).not.toContain('Uso dos planos')
  expect(btn.getAttribute('aria-label')).toBe('Uso dos planos')
})
