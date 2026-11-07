/**
 * OPENCODE.GO: the provider login ("Connect provider") and the OpenCode plan/limits card live on the
 * Usage screen, in the accounts area — the same panel Settings → Billing now redirects to. They are
 * the one component (`OpenCodeProviders`), mounted by `BillingAccountsPanel`, never a second copy.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom')
let Billing: typeof import('../settings/BillingSettings')
let root: Root | undefined
const originalFetch = globalThis.fetch

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  ;({ createRoot } = await import('react-dom/client'))
  Router = await import('react-router-dom')
  Billing = await import('../settings/BillingSettings')
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/accounts') return Response.json({ accounts: [] })
    if (url === '/api/opencode/auth') {
      return Response.json({
        installed: true,
        connected: [{ id: 'opencode-go', label: 'OpenCode Go', type: 'api' }],
        providers: [{ id: 'opencode-go', label: 'OpenCode Go', url: 'https://opencode.ai/auth', kind: 'go' }],
      })
    }
    return Response.json({})
  }) as typeof fetch
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

function mount(at: string, lang: 'en' | 'pt' = 'en') {
  const { MemoryRouter, Routes, Route, Outlet } = Router
  const ctx = { lang, billing: { profiles: {} }, data: { harnesses: ['claude', 'opencode'] }, isCentral: false, saveBilling: async () => {} }
  const el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  act(() => root!.render(h(MemoryRouter, { initialEntries: [at] },
    h(Routes, null, h(Route, { element: h(Outlet, { context: ctx }) },
      h(Route, { path: 'usage', element: h(Billing.BillingAccountsPanel) }),
      h(Route, { path: 'settings/billing', element: h(Billing.default) }),
    )))))
  return el
}

describe('OpenCode provider login and plan on the Usage screen', () => {
  test('/usage shows the provider section, the connected provider and the connect entry', async () => {
    const el = mount('/usage')
    await flush()
    const section = el.querySelector('[data-opencode-providers]')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('OpenCode providers')
    expect(section!.querySelector('[data-opencode-provider="opencode-go"]')).not.toBeNull()
    expect(Array.from(section!.querySelectorAll('button')).some(b => b.textContent?.includes('Connect provider'))).toBe(true)
  })

  test('the Portuguese entry is "Conectar provedor"', async () => {
    const el = mount('/usage', 'pt')
    await flush()
    const section = el.querySelector('[data-opencode-providers]')
    expect(Array.from(section!.querySelectorAll('button')).some(b => b.textContent?.includes('Conectar provedor'))).toBe(true)
  })

  test('the old Settings → Billing route lands on the same panel', async () => {
    const el = mount('/settings/billing')
    await flush()
    expect(el.querySelector('[data-opencode-providers]')).not.toBeNull()
  })
})
