import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Content: typeof import('./BenchmarkPage').BenchmarkContent
const calls: { url: string; method: string }[] = []
const realFetch = globalThis.fetch

const cov = (v: number | null) => ({ value: v, interval: null, gaps: [], n: 1, covered: 1, total: 1, missing: [], formula: 'f', origin: { records: [], formula: 'f', n: 1, coverage: '1 of 1' } })
const observed = {
  label: 'observed-biased', period: { from: null, to: null }, deliveries: 1,
  scope: { published: 1, open: 0, withPhaseHistory: 1, abandonedWithSessions: 0 },
  metrics: Object.fromEntries(['costPerDelivery', 'wallMedian', 'activeMedian', 'coordinationShare', 'qaFirstRoundRejection', 'qaRoundsMedian', 'escapedDefectRate', 'wastedCostShare', 'throughputPerWeek'].map(k => [k, cov(1)])),
  coordinationShareRange: { lo: null, hi: null }, roleUnknownSessions: 0, coverage: {}, notStructured: { qaVerdict: 0, escapedLink: 0 },
}

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (u: unknown, init?: { method?: string }) => { calls.push({ url: String(u), method: init?.method ?? 'GET' }); return new Response('{}') }) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  Content = (await import('./BenchmarkPage')).BenchmarkContent
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => { globalThis.fetch = realFetch; GlobalRegistrator.unregister() })

for (const [lang, expected] of [['pt', 'Chega com o teste controlado: ainda não dá para criar um benchmark novo.'], ['en', 'Arrives with the controlled test: a new benchmark cannot be created yet.']] as const) {
  test(`"New benchmark" (${lang}): click shows a status note and writes nothing`, async () => {
    calls.length = 0
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(MemoryRouter, null, createElement(Content, { lang, observed: observed as never, status: 'ready' }))))
    const btn = document.querySelector('[data-testid="benchmark-new"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(document.querySelector('[role="status"]')).toBeNull()
    await act(async () => { btn.click() })
    const note = document.querySelector('[role="status"]')
    expect(note?.textContent).toBe(expected)
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })
}
