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
  models: [], defaultModel: '', setup: {}, canInstall: true, ...overrides,
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

test('a limit source makes reading available even with zero sessions', async () => {
  const limits = { harness: 'codex', updatedAt: 1, windows: [{ kind: '5h', usedPct: 42, resetsAt: 2 }], source: 'test' } as unknown as PlanLimits
  await mount({ lang: 'pt', statuses: [status()], mode: 'new', planLimits: [limits], now: 1 })
  expect(host!.querySelector('[data-catalog-reading]')!.textContent).toBe('Disponível')
  expect(host!.querySelector('[data-catalog-usage]')!.textContent).toBe('Sem uso')
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

for (const id of ['antigravity', 'kimi', 'opencode']) {
  test(`${id} remains selectable when fleet detects it and catalog status is stale`, async () => {
    let selected = ''
    await mount({ lang: 'pt', statuses: [status({ id, installed: false })], available: [{ id, label: id }], mode: 'new', onSelect: (value: string) => { selected = value } })
    expect(host!.querySelector('[data-catalog-installation]')!.textContent).toBe('Instalado')
    const button = host!.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toBe('Selecionar')
    await act(async () => button.click())
    expect(selected).toBe(id)
  })
}

test('sessions alone never imply a reading; Usage has four columns and no duplicate state or action', async () => {
  await mount({ lang: 'en', statuses: [status()], usage: { codex: { sessions: 3 } }, mode: 'usage' })
  expect(host!.querySelector('[data-catalog-reading]')!.textContent).toBe('No reading')
  expect(host!.querySelector('[data-catalog-usage]')!.textContent).toBe('3 sessions')
  expect(host!.querySelector('[data-catalog-action]')).toBeNull()
  expect(host!.querySelector('[data-catalog-header]')!.children.length).toBe(4)
  const row = host!.querySelector<HTMLElement>('[data-harness-row]')!
  expect(row.children.length).toBe(4)
  expect(row.style.textTransform).toBe('none')
  expect(parseFloat(row.style.minWidth)).toBe(0)
})

for (const id of ['claude', 'codex', 'gemini', 'copilot', 'opencode']) {
  test(`${id} with an integrated installer opens only on explicit action`, async () => {
    let installs = 0
    await mount({ lang: 'en', statuses: [status({ id, installed: false, canInstall: true })], mode: 'new', onInstall: () => { installs++ } })
    expect(installs).toBe(0)
    const button = host!.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toBe('Install')
    await act(async () => button.click())
    expect(installs).toBe(1)
  })
}
for (const id of ['antigravity', 'kimi', 'hermes']) {
  test(`${id} without an installer links official guidance and never invokes installation`, async () => {
    let installs = 0
    const docUrl = `https://official.example/${id}`
    await mount({ lang: 'pt', statuses: [status({ id, installed: false, canInstall: false, setup: { docUrl } })], mode: 'new', onInstall: () => { installs++ } })
    expect(host!.querySelector('button')).toBeNull()
    const link = host!.querySelector('a')!
    expect(link.textContent).toBe('Como instalar')
    expect(link.getAttribute('href')).toBe(docUrl)
    expect(installs).toBe(0)
  })
}

test('mobile cards keep labelled installation, reading, usage and selection in each row', async () => {
  const width = window.innerWidth
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  try {
    await mount({ lang: 'pt', statuses: [status()], available: [{ id: 'codex', label: 'Codex' }], mode: 'new' })
    expect(host!.querySelector('[data-catalog-header]')).toBeNull()
    const row = host!.querySelector<HTMLElement>('[data-harness-row]')!
    expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr) 100px')
    expect(row.textContent).toContain('Instalação: Instalado')
    expect(row.textContent).toContain('Leitura: Sem leitura')
    expect(row.textContent).toContain('Uso: Sem uso')
    expect(row.querySelector('[data-catalog-action] button')!.textContent).toBe('Selecionar')
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }) }
})


test('historical usage readings are a source even without a current limit window', async () => {
  await mount({ lang: 'en', statuses: [status()], readings: [{ harness: 'codex', points: [{ at: 1 }] }], mode: 'usage' })
  expect(host!.querySelector('[data-catalog-reading]')!.textContent).toBe('Available')
  expect(host!.querySelector('[data-catalog-usage]')!.textContent).toBe('No usage')
})
