import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Root } from 'react-dom/client'

// CONTAS.AGENDA-SALVAR r2 · U1 (a trigger for the popup at 390px, opening it as a centred sheet),
// U2 (footer "Dias e horários: na conta" + "Abrir contas ›"), U3 (header "Uso dos planos" + "muda na hora").
let createRoot: typeof import('react-dom/client').createRoot
let PlanUsagePhoneSheet: typeof import('./PlanUsageFootButton').PlanUsagePhoneSheet
let requestPlanUsagePopup: typeof import('../lib/planUsagePopupRequests').requestPlanUsagePopup
let MobileAreaBar: typeof import('./nav/MobileAreaBar').MobileAreaBar
let Router: typeof import('react-router-dom').MemoryRouter
let host: HTMLDivElement
let root: Root
let originalFetch: typeof fetch

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 390, height: 844 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  globalThis.fetch = (async (url: string) => String(url) === '/api/plan-limits'
    ? Response.json({ limits: [], registered: [], budgets: [], hiddenFromAgents: [] })
    : Response.json({ accounts: [] })) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  PlanUsagePhoneSheet = (await import('./PlanUsageFootButton')).PlanUsagePhoneSheet
  requestPlanUsagePopup = (await import('../lib/planUsagePopupRequests')).requestPlanUsagePopup
  MobileAreaBar = (await import('./nav/MobileAreaBar')).MobileAreaBar
  Router = (await import('react-router-dom')).MemoryRouter
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

async function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(createElement(Router, null, node)) })
}

test('U1: the phone\'s "Go to" sheet has a "Uso dos planos" row that opens the popup as a centred sheet', async () => {
  await mount(createElement('div', null,
    createElement(PlanUsagePhoneSheet, { lang: 'pt' }),
    createElement(MobileAreaBar, { lang: 'pt', pathname: '/usage', onNavigate: () => {}, actions: [
      { key: 'plan-usage', label: 'Uso dos planos', icon: (() => null) as never, onClick: requestPlanUsagePopup },
    ] })))
  expect(document.querySelector('[data-plan-usage-popover]')).toBeNull()
  const more = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Mais' || b.textContent === 'Mais')!
  await act(async () => { more.click() })
  const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-bottom-sheet] button')).find(b => b.textContent?.includes('Uso dos planos'))!
  expect(row).toBeTruthy()
  await act(async () => { row.click() })
  const pop = document.querySelector('[data-plan-usage-popover]') as HTMLElement
  expect(pop).not.toBeNull()
  expect(pop.getAttribute('data-plan-usage-placement')).toBe('phone-sheet')
  expect(pop.style.top).toBe('50%')
  expect(pop.style.width).toBe('366px') // 390 − 12 − 12
  // U3 + U2 inside the same popup
  expect(pop.querySelector('[data-plan-usage-head]')?.textContent).toBe('Uso dos planosmuda na hora')
  expect(pop.querySelector('[data-plan-usage-foot]')?.textContent).toBe('Dias e horários: na contaAbrir contas ›')
  expect(pop.textContent).not.toContain('% usado')
  expect(pop.textContent).not.toContain('Clique para ver tudo')
  // a press on the scrim closes it
  await act(async () => { (document.querySelector('[data-plan-usage-scrim]') as HTMLElement).click() })
  expect(document.querySelector('[data-plan-usage-popover]')).toBeNull()
})

test('Esc closes the phone sheet', async () => {
  await mount(createElement(PlanUsagePhoneSheet, { lang: 'pt' }))
  await act(async () => { requestPlanUsagePopup() })
  expect(document.querySelector('[data-plan-usage-popover]')).not.toBeNull()
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(document.querySelector('[data-plan-usage-popover]')).toBeNull()
})

test('U1: App wires the phone row and mounts the phone sheet only on a phone', () => {
  const app = readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8')
  expect(app).toContain("key: 'plan-usage'")
  expect(app).toContain('onClick: requestPlanUsagePopup')
  expect(app).toMatch(/\{isMobile && <PlanUsagePhoneSheet lang=\{lang\} \/>\}/)
})

test('U2/U3 in English', async () => {
  await mount(createElement(PlanUsagePhoneSheet, { lang: 'en' }))
  await act(async () => { requestPlanUsagePopup() })
  const pop = document.querySelector('[data-plan-usage-popover]') as HTMLElement
  expect(pop.querySelector('[data-plan-usage-head]')?.textContent).toBe('Plan usagechanges instantly')
  expect(pop.querySelector('[data-plan-usage-foot]')?.textContent).toBe('Days and hours: on the accountOpen accounts ›')
})
