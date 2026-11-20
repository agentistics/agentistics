/** USO.LENTO r3c — the Usage page asks for the account list ONCE per mount, never from a re-render, and a hover → open → remount is one request. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom')
let Page: typeof import('./UsageNowPage')
let Warm: typeof import('../../lib/usageWarmup')
let root: Root | undefined
const originalFetch = globalThis.fetch
const realNow = Date.now
let clock = 1_000_000
let accountCalls = 0

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1440, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, writable: true, value: undefined })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;({ createRoot } = await import('react-dom/client'))
  Router = await import('react-router-dom')
  Page = await import('./UsageNowPage')
  Warm = await import('../../lib/usageWarmup')
})
afterAll(async () => { globalThis.fetch = originalFetch; Date.now = realNow; await GlobalRegistrator.unregister() })
beforeEach(() => {
  accountCalls = 0; clock = 1_000_000
  Date.now = () => clock
  Warm.resetUsageWarmup()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === '/api/accounts') { accountCalls++; return Response.json({ accounts: [] }) }
    return Response.json({})
  }) as typeof fetch
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const ctx = { lang: 'en', billing: { profiles: {} }, data: { harnesses: ['claude'] }, saveBilling: async () => {} }
const tree = (n: number) => {
  const { MemoryRouter, Routes, Route, Outlet } = Router
  return h(MemoryRouter, { initialEntries: ['/usage'] },
    h(Routes, null, h(Route, { element: h(Outlet, { context: ctx }) },
      h(Route, { path: 'usage', element: h(Page.UsageNowContent, { lang: 'en', harnesses: ['claude'], sessions: [], key: undefined, ...{ n } } as never) }))))
}
function mount() { const el = document.createElement('div'); document.body.append(el); root = createRoot(el); act(() => root!.render(tree(0))) }

describe('Usage page account requests', () => {
  test('tab open and idle for 60 s with re-renders: no extra /api/accounts', async () => {
    mount()
    await flush()
    expect(accountCalls).toBe(1)
    for (let s = 0; s < 6; s++) {
      clock += 10_000 // the slot goes stale between renders
      act(() => root!.render(tree(s + 1)))
      await flush()
    }
    expect(accountCalls).toBe(1)
  })
  test('hover → open → remount is ONE request', async () => {
    Warm.warmUsageAccounts('hover')
    mount()
    await flush()
    act(() => root!.unmount())
    clock += 2_000
    root = createRoot(document.body.appendChild(document.createElement('div')))
    act(() => root!.render(tree(0)))
    await flush()
    expect(accountCalls).toBe(1)
  })
})
