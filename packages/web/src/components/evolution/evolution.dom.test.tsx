import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { buildMetricItems, buildMetrics, type Filters, type MetricInput, type MetricsReply } from '@agentistics/core'
import * as realLoader from '../CenteredLoader'

// The loader's WAAPI animation cancels on unmount, which happy-dom reports as an unhandled rejection. A module mock
// outlives its file, so the real one is put back afterwards.
const realLoaderSnapshot = { ...realLoader }
afterAll(() => { mock.module('../CenteredLoader', () => realLoaderSnapshot) })
mock.module('../CenteredLoader', () => ({ ...realLoader, CenteredLoader: () => null }))

const H = 3_600_000
const NOW = Date.parse('2026-11-07T15:00:00Z')
const T0 = Date.parse('2026-11-03T12:00:00Z')
const input = (id: string, o: Partial<MetricInput> = {}): MetricInput => ({
  subtaskId: id, taskId: 'T1', taskTitle: 'Esteira', title: `Peça ${id}`, priority: 'high', version: '2.201.0', phase: 'publicado', createdAtMs: T0, requestedAtMs: null,
  publishedAtMs: T0 + 28 * H, authorModel: 'claude-opus-5', qaModel: null, harness: 'claude', costUSD: 12, tokens: 1000,
  history: [
    { from: 'fila', to: 'executando', atMs: T0 + 2 * H, detail: '' }, { from: 'executando', to: 'qa', atMs: T0 + 14 * H, detail: '' },
    { from: 'qa', to: 'ajuste', atMs: T0 + 20 * H, detail: '' }, { from: 'ajuste', to: 'qa', atMs: T0 + 23 * H, detail: '' },
    { from: 'qa', to: 'publicado', atMs: T0 + 28 * H, detail: '' },
  ], ...o,
})
const reply = (inputs: MetricInput[], f = {}): MetricsReply => buildMetrics(buildMetricItems(inputs, NOW), f, NOW)

const base: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Page: typeof import('./DeliveryEvolution').DeliveryEvolution
let Router: typeof import('react-router-dom').MemoryRouter
let seen: string[] = []

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  // The push channels the hook subscribes to are not under test; a stream that never emits is exactly "no push".
  class QuietEventSource { addEventListener() {} removeEventListener() {} close() {} }
  ;(globalThis as { EventSource?: unknown }).EventSource = QuietEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  Page = (await import('./DeliveryEvolution')).DeliveryEvolution
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

const answer = (r: MetricsReply | number) => {
  seen = []
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url))
    return typeof r === 'number' ? new Response('boom', { status: r }) : new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}
const mount = async (lang: 'pt' | 'en' = 'pt') => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Page, { lang, filters: base, currency: 'USD', brlRate: 5 }))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}

test('a populated reply draws the story: lead sentence, six KPI cards, funnel, bottleneck, the QA-by-model bar and the table', async () => {
  answer(reply([input('a'), input('b', { authorModel: 'sol', costUSD: null })]))
  await mount()
  expect(seen[0]).toContain('/api/deliveries/metrics?')
  expect(seen[0]).toContain('groupBy=day')
  expect(document.querySelector('[data-evo-lead]')!.textContent).toContain('2 de 2 entregas foram publicadas')
  expect(Array.from(document.querySelectorAll('[data-evo-kpi]')).map(e => e.getAttribute('data-evo-kpi'))).toEqual(['lead', 'published', 'qa', 'eta', 'cost', 'blocks'])
  expect(document.querySelector('[data-evo-kpi="lead"]')!.textContent).toContain('28 h')
  // no prediction was ever recorded: the ETA card says so instead of drawing a number
  expect(document.querySelector('[data-evo-kpi="eta"]')!.textContent).toContain('—')
  expect(document.querySelector('[data-evo-kpi="eta"]')!.textContent).toContain('Ainda não há previsões guardadas')
  expect(document.querySelectorAll('[data-evo-funnel-stage]').length).toBe(7)
  expect(document.querySelector('[data-evo-bottleneck]')!.getAttribute('data-evo-bottleneck')).toBe('running')
  expect(document.querySelector('[data-evo-bar="claude-opus-5"]')!.textContent).toContain('100%')
  expect(document.querySelectorAll('[data-evo-row]').length).toBe(2)
  // the unpriced delivery shows "—", not a zero cost
  expect(document.querySelector('[data-evo-row="b"]')!.textContent).toContain('—')
})

test('the same reply reads in English', async () => {
  answer(reply([input('a')]))
  await mount('en')
  expect(document.querySelector('[data-evo-lead]')!.textContent).toContain('1 of 1 deliveries were published')
  expect(document.body.textContent).toContain('Delivery evolution')
  expect(document.body.textContent).toContain('Where the time goes')
})

test('no deliveries at all, and filters that match nothing, are different empty states', async () => {
  answer(reply([]))
  await mount()
  expect(document.querySelector('[data-evo-empty]')!.getAttribute('data-evo-empty')).toBe('no-data')
  expect(document.querySelector('[data-evo-kpis]')).toBeNull()
  await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  answer(reply([input('a')], { versions: ['9.9.9'] }))
  await mount()
  expect(document.querySelector('[data-evo-empty]')!.getAttribute('data-evo-empty')).toBe('no-match')
})

test('a failed read says so and offers to try again; it draws no number', async () => {
  answer(500)
  await mount()
  expect(document.querySelector('[data-evo-error]')!.textContent).toContain('Não foi possível ler')
  expect(document.querySelector('[data-evo-kpis]')).toBeNull()
})

test('the fixed bar\'s harness and period reach the query', async () => {
  answer(reply([input('a')]))
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null, createElement(Page, { lang: 'pt', filters: { ...base, dateRange: '7d', harnesses: ['codex'] }, currency: 'USD', brlRate: 5 }))) })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  const q = new URLSearchParams(seen[0]!.split('?')[1])
  expect(q.get('harness')).toBe('codex')
  expect(q.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(q.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})
