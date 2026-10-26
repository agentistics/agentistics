import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { PlanLimits } from '@agentistics/core'

let createRoot: typeof import('react-dom/client').createRoot
let Modal: typeof import('./PlanUsageModal').PlanUsageModal
let Router: typeof import('react-router-dom').MemoryRouter
let setLimits: typeof import('../lib/planLimits').__setPlanLimitsForTest
let useNotifications: typeof import('../lib/notifications').useNotifications
let root: Root | undefined
let originalFetch: typeof fetch
let patches: { path: string; body: unknown }[]
let finishPatch: (response: Response) => void
let failPatch: (error: Error) => void
let available = true
const account = { id: 'acc_work', harness: 'claude', available: true }
const now = Date.now()
const reading = (id: string): PlanLimits => ({ harness: 'claude', account: id, plan: 'Pro', source: 'claude-stream', updatedAt: now,
  windows: [{ kind: '5h', usedPct: 24, resetsAt: now + 3600000 }] })

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/accounts' && !init?.method) return Response.json({ accounts: [
      { ...account, available }, { id: 'acc_pending', harness: 'codex', available: false },
    ] })
    if (init?.method === 'PATCH') {
      patches.push({ path, body: JSON.parse(String(init.body)) })
      return new Promise<Response>((resolve, reject) => { finishPatch = resolve; failPatch = reject })
    }
    if (path === '/api/plan-limits') return Response.json({ limits: [reading('acc_work'), reading('default')],
      registered: [{ harness: 'codex', account: 'acc_pending', plan: 'Plus', accountLabel: 'Codex CLI #2' }],
      budgets: available ? [{ harness: 'claude', account: 'acc_work', accountLabel: 'Work' }] : [],
      hiddenFromAgents: available ? [] : [{ harness: 'claude', account: 'acc_work', accountLabel: 'Work' }],
    })
    return Response.json({})
  }) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  Modal = (await import('./PlanUsageModal')).PlanUsageModal
  Router = (await import('react-router-dom')).MemoryRouter
  useNotifications = (await import('../lib/notifications')).useNotifications
  setLimits = (await import('../lib/planLimits')).__setPlanLimitsForTest
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

function Notices() {
  const notices = useNotifications()
  return createElement('div', { 'data-notices': true }, notices.map(n => n.title).join(' | '))
}
async function mount(lang: 'pt' | 'en' = 'en') {
  patches = []
  setLimits([], now)
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Router, null,
    createElement(Modal, { lang, onClose() {} }), createElement(Notices))) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const switches = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="switch"]'))
const workSwitch = () => switches().find(b => b.getAttribute('aria-label')?.includes('Work'))!

describe('Plan usage account availability', () => {
  test('renders registry availability, including hidden accounts and pending plans; omits legacy readings', async () => {
    available = false
    await mount()
    expect(switches()).toHaveLength(2)
    expect(workSwitch().getAttribute('aria-checked')).toBe('false')
    expect(document.querySelectorAll('[data-plan-usage-card]')).toHaveLength(3)
    expect(document.body.textContent).toContain("Agents won't use this account")
    expect(document.body.textContent).toContain('Claude Code · Work')
    expect(document.body.textContent).toContain('Codex CLI #2')
    expect(patches).toEqual([])
  })
  test('saves through the existing account API, updates optimistically and keeps the card', async () => {
    available = true
    await mount()
    const button = workSwitch()
    expect(button.getAttribute('aria-checked')).toBe('true')
    await act(async () => button.click())
    expect(patches).toEqual([{ path: '/api/accounts/acc_work', body: { available: false } }])
    expect(button.getAttribute('aria-checked')).toBe('false')
    expect(button.disabled).toBe(true)
    expect(document.querySelectorAll('[data-plan-usage-card]')).toHaveLength(3)
    await act(async () => finishPatch(Response.json({ account: { ...account, available: false } })))
    expect(workSwitch().getAttribute('aria-checked')).toBe('false')
    expect(workSwitch().disabled).toBe(false)
    await act(async () => workSwitch().click())
    expect(patches.at(-1)).toEqual({ path: '/api/accounts/acc_work', body: { available: true } })
    await act(async () => finishPatch(Response.json({ account })))
    expect(workSwitch().getAttribute('aria-checked')).toBe('true')
  })
  for (const networkFailure of [false, true]) {
    test(`restores the previous state and delivers a toast on ${networkFailure ? 'network' : 'HTTP'} failure`, async () => {
      available = true
      await mount('pt')
      await act(async () => workSwitch().click())
      expect(document.body.textContent).toContain('Agentes não usam esta conta')
      await act(async () => networkFailure ? failPatch(new Error('Offline')) : finishPatch(Response.json({}, { status: 500 })))
      expect(workSwitch().getAttribute('aria-checked')).toBe('true')
      expect(workSwitch().disabled).toBe(false)
      expect(document.querySelector('[data-notices]')?.textContent).toContain('Não foi possível alterar o uso por agentes')
    })
  }
  test('a hidden account can be enabled and returns to off if saving fails', async () => {
    available = false
    await mount()
    await act(async () => workSwitch().click())
    expect(patches).toEqual([{ path: '/api/accounts/acc_work', body: { available: true } }])
    expect(workSwitch().getAttribute('aria-checked')).toBe('true')
    await act(async () => finishPatch(Response.json({}, { status: 403 })))
    expect(workSwitch().getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain("Agents won't use this account")
  })
  test('mobile switches retain a 44px tap target', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    available = true
    try {
      await mount('pt')
      expect(workSwitch().getAttribute('aria-label')).toBe('Uso por agentes · Claude Code · Work')
      expect(workSwitch().style.padding).toBe('13px 6px')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    }
  })
})
