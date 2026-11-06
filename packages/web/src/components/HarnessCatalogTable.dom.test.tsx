import { afterAll, beforeAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { HarnessChatStatus } from '../hooks/useChatHarnesses'
import type { PlanLimits } from '@agentistics/core'

let createRoot: typeof import('react-dom/client').createRoot
let Table: typeof import('./HarnessCatalogTable').HarnessCatalogTable
let root: Root | undefined
let host: HTMLDivElement | undefined

const status = (overrides: Partial<HarnessChatStatus> = {}): HarnessChatStatus => ({
  id: 'codex', label: 'Codex', installed: true, authReady: true, ready: true,
  models: [], defaultModel: '', setup: {}, ...overrides,
})

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Table = (await import('./HarnessCatalogTable')).HarnessCatalogTable
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
})
afterAll(async () => { await GlobalRegistrator.unregister() })

async function mount(props: Record<string, unknown>) {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(Table, props as never)))
}

test('loading and empty states are explicit', async () => {
  await mount({ lang: 'pt', statuses: [], mode: 'new', loading: true })
  expect(host!.textContent).toContain('Vendo todos os harnesses compatíveis')
  await act(async () => root!.render(createElement(Table, { lang: 'pt', statuses: [], mode: 'usage' })))
  expect(host!.textContent).toContain('Nenhum harness compatível')
})

test('non-installed row exposes Install but does not install by itself', async () => {
  let installs = 0
  await mount({ lang: 'pt', statuses: [status({ installed: false, authReady: false, ready: false })], mode: 'new', onInstall: () => { installs++ } })
  const button = host!.querySelector<HTMLButtonElement>('button')!
  expect(button.textContent).toBe('Instalar')
  expect(installs).toBe(0)
  await act(async () => button.click())
  expect(installs).toBe(1)
})

test('installed without readings says sem leitura and renders plan bars on its row', async () => {
  const limits = { harness: 'codex', updatedAt: 1, windows: [{ kind: '5h', usedPct: 42, resetsAt: 2 }], source: 'test' } as unknown as PlanLimits
  await mount({ lang: 'pt', statuses: [status()], mode: 'new', planLimits: [limits], now: 1 })
  expect(host!.textContent).toContain('Sem leitura')
  expect(host!.querySelector('[data-plan-compact]')).not.toBeNull()
})

test('new-session selection keeps the harness limits on the selected row', async () => {
  let selected = ''
  const limits = { harness: 'codex', updatedAt: 1, windows: [{ kind: '5h', usedPct: 42, resetsAt: 2 }], source: 'test' } as unknown as PlanLimits
  await mount({ lang: 'pt', statuses: [status()], available: [{ id: 'codex', label: 'Codex' }], mode: 'new', planLimits: [limits], now: 1, onSelect: (id: string) => { selected = id } })
  expect(host!.querySelector('[data-plan-compact]')).not.toBeNull()
  const button = Array.from(host!.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.includes('Selecionar'))
  expect(button).not.toBeUndefined()
  await act(async () => button!.click())
  expect(selected).toBe('codex')
})

test('Usage distinguishes not installed from installed without reading', async () => {
  await mount({ lang: 'pt', statuses: [status({ id: 'codex', installed: false, authReady: false, ready: false }), status({ id: 'claude', label: 'Claude' })], mode: 'usage' })
  const rows = Array.from(host!.querySelectorAll<HTMLElement>('[data-harness-row]'))
  expect(rows.find(r => r.dataset.harnessRow === 'codex')?.textContent).toContain('Não instalado')
  expect(rows.find(r => r.dataset.harnessRow === 'claude')?.textContent).toContain('Sem leitura')
})
