/** Usage → Accounts: the pencil opens the one editor, it saves through the existing APIs, and every old route lands here. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom')
let Billing: typeof import('../settings/BillingSettings')
let LimitsPage: typeof import('./UsageLimitsPage').default
let PlanPage: typeof import('./UsagePlanPage').default
let root: Root | undefined
const originalFetch = globalThis.fetch
let patches: { url: string; body: Record<string, unknown> }[]
let account: Record<string, unknown>

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1440, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  ;({ createRoot } = await import('react-dom/client'))
  Router = await import('react-router-dom')
  Billing = await import('../settings/BillingSettings')
  LimitsPage = (await import('./UsageLimitsPage')).default
  PlanPage = (await import('./UsagePlanPage')).default
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })
beforeEach(() => {
  patches = []
  account = { id: 'c1', harness: 'claude', key: 'c1', label: 'me@example.test', root: null, available: true }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      patches.push({ url, body })
      account = { ...account, ...body }
      return Response.json({ account })
    }
    if (url === '/api/accounts') return Response.json({ accounts: [account] })
    return Response.json({})
  }) as typeof fetch
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

function mount(at: string, saves: unknown[] = []) {
  const { MemoryRouter, Routes, Route, Outlet, useLocation } = Router
  const ctx = {
    lang: 'en', billing: { profiles: {} }, data: { harnesses: ['claude'] }, isCentral: false,
    saveBilling: async (next: unknown) => { saves.push(next) },
  }
  const Where = () => { const l = useLocation(); return h('output', { 'data-where': `${l.pathname}${l.hash}` }) }
  const el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
  act(() => root!.render(h(MemoryRouter, { initialEntries: [at] },
    h(Routes, null, h(Route, { element: h(Outlet, { context: ctx }) },
      h(Route, { path: 'usage', element: h('div', null, h(Where), h(Billing.BillingAccountsPanel)) }),
      h(Route, { path: 'usage/limits', element: h(LimitsPage) }),
      h(Route, { path: 'usage/plan', element: h(PlanPage) }),
      h(Route, { path: 'settings/billing', element: h(Billing.default) }),
    )))))
  return el
}
const where = () => document.querySelector('[data-where]')?.getAttribute('data-where')

describe('old routes land on Usage', () => {
  for (const [from, to] of [['/settings/billing', '/usage#contas'], ['/usage/limits', '/usage#contas'], ['/usage/plan', '/usage']] as const) {
    test(`${from} → ${to}`, async () => {
      mount(from)
      await flush()
      expect(where()).toBe(to)
    })
  }
})

describe('the account row and its editor', () => {
  test('one compact row per account, with the switch and the pencil', async () => {
    const el = mount('/usage#contas')
    await flush()
    expect(el.querySelectorAll('[data-billing-row]').length).toBe(1)
    expect(el.querySelector('#contas')).not.toBeNull()
    expect(el.querySelector('[role=switch][aria-label="Agents · me@example.test"]')).not.toBeNull()
    expect(el.querySelector('button[aria-label="Set plan · me@example.test"] .lucide-pencil')).not.toBeNull()
    expect(el.textContent).toContain('Billing')
  })

  test('the pencil opens the editor; the nickname and agent use save through PATCH /api/accounts/:id', async () => {
    const el = mount('/usage')
    await flush()
    act(() => (el.querySelector('button[aria-label="Set plan · me@example.test"]') as HTMLButtonElement).click())
    await flush()
    const dialog = document.querySelector('[role=dialog]') as HTMLElement
    expect(dialog).not.toBeNull()
    // Agent use is editable from inside the editor too.
    act(() => (dialog.querySelector('[data-account-agents] [role=switch]') as HTMLButtonElement).click())
    await flush()
    expect(patches).toEqual([{ url: '/api/accounts/c1', body: { available: false } }])

    const input = dialog.querySelector('input[maxlength="40"]') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Work')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLButtonElement
    act(() => save.click())
    await flush()
    expect(patches.at(-1)).toEqual({ url: '/api/accounts/c1', body: { nickname: 'Work' } })
  })
})

describe('#contas lands on the list (QA P2-1)', () => {
  let scrolled: string[]
  let original: typeof Element.prototype.scrollIntoView
  beforeEach(() => {
    scrolled = []
    original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id) }
  })
  afterEach(() => { Element.prototype.scrollIntoView = original })

  for (const at of ['/usage#contas', '/usage/limits', '/settings/billing']) {
    test(`${at} scrolls the Contas section into view once the accounts answered`, async () => {
      mount(at)
      await flush()
      await act(async () => { await new Promise(r => setTimeout(r, 30)) })
      expect(scrolled).toContain('contas')
    })
  }

  test('plain /usage does not jump to the list', async () => {
    mount('/usage')
    await flush()
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(scrolled).toEqual([])
  })

  test('a failed accounts request still scrolls to the section', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    mount('/usage#contas')
    await flush()
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(scrolled).toContain('contas')
  })
})

describe('the Agentes switch is a 44px target on a phone (QA P2-2)', () => {
  test('at 390px the switch sits in a 44×44 label, and tapping the label toggles it', async () => {
    const prev = window.innerWidth
    ;(window as { innerWidth: number }).innerWidth = 390
    try {
      const el = mount('/usage')
      await flush()
      const target = el.querySelector('[data-agents-target]') as HTMLLabelElement
      expect(target.tagName).toBe('LABEL')
      expect(target.style.minWidth).toBe('44px')
      expect(target.style.minHeight).toBe('44px')
      expect(target.querySelector('[role=switch]')).not.toBeNull()
      act(() => (target.querySelector('span[aria-hidden]') as HTMLElement).click())
      await flush()
      expect(patches).toEqual([{ url: '/api/accounts/c1', body: { available: false } }])
    } finally { (window as { innerWidth: number }).innerWidth = prev }
  })
})

