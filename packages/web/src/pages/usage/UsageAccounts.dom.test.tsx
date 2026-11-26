/** Usage → Accounts: the pencil opens the one editor, it saves through the existing APIs, and every old route lands here. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

function mount(at: string, saves: unknown[] = [], billing: unknown = { profiles: {} }) {
  const { MemoryRouter, Routes, Route, Outlet, useLocation } = Router
  const ctx = {
    lang: 'en', billing, data: { harnesses: ['claude'] },
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

describe('before the accounts arrive', () => {
  test('shows a loading state, never the generic one-row-per-assistant list', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch // /api/accounts never answers
    const el = mount('/usage')
    await flush()
    expect(el.querySelector('[data-accounts-loading]')).not.toBeNull()
    expect(el.querySelectorAll('[data-billing-row]').length).toBe(0)
  })
})

describe('when /api/accounts fails', () => {
  for (const [name, f] of [
    ['not ok', () => Promise.resolve(new Response('{}', { status: 500 }))],
    ['network error', () => Promise.reject(new Error('down'))],
  ] as const) {
    test(`${name}: an error with a retry, never the generic list`, async () => {
      const real = globalThis.fetch
      globalThis.fetch = ((u: unknown) => String(u).includes('/api/accounts') ? f() : real(u as string)) as unknown as typeof fetch
      const el = mount('/usage')
      await flush()
      expect(el.querySelector('[data-accounts-error]')?.textContent).toContain('Could not load the accounts')
      expect(el.querySelector('[data-accounts-retry]')).not.toBeNull()
      expect(el.querySelectorAll('[data-billing-row]').length).toBe(0)
      globalThis.fetch = real
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
    expect(el.textContent).toContain('Plans and cost')
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
  test('at 390px the interactive switch owns the 44×44 target and its text toggles once', async () => {
    const prev = window.innerWidth
    ;(window as { innerWidth: number }).innerWidth = 390
    try {
      const el = mount('/usage')
      await flush()
      const target = el.querySelector('[role=switch]') as HTMLButtonElement
      expect(target.tagName).toBe('BUTTON')
      expect(target.style.minWidth).toBe('44px')
      expect(target.style.minHeight).toBe('44px')
      expect(target.textContent).toBe('Agents')
      act(() => (target.lastElementChild as HTMLElement).click())
      await flush()
      expect(patches).toEqual([{ url: '/api/accounts/c1', body: { available: false } }])
    } finally { (window as { innerWidth: number }).innerWidth = prev }
  })
})

describe('removing a plan (CONTAS.MAC.NOVO)', () => {
  const click = (label: string) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent === label) as HTMLButtonElement | undefined
    expect(b).toBeDefined()
    act(() => b!.click())
  }
  test('the plan in force is removed from its own editor and the account goes back to no plan', async () => {
    const saves: unknown[] = []
    const billing = { profiles: {}, accountProfiles: { 'claude:c1': { periods: [{ id: 'p1', mode: 'subscription', planId: 'claude-max-5x', label: 'Max 5x', price: { amount: 100, currency: 'USD' }, from: '2026-01-01' }] } } }
    const el = mount('/usage', saves, billing)
    await flush()
    act(() => (el.querySelector('button[aria-label="Edit · me@example.test"]') as HTMLButtonElement).click())
    await flush()
    click('Remove this plan')
    await flush()
    click('Remove')
    await flush()
    expect(saves.length).toBe(1)
    expect((saves[0] as (b: unknown) => unknown)(billing)).toEqual({ profiles: {} })
  })
})

describe('removing a plan in the edge cases (CONTAS.MAC.NOVO)', () => {
  const click = (label: string) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent === label) as HTMLButtonElement | undefined
    expect(b).toBeDefined()
    act(() => b!.click())
  }
  const future = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10)
  test('fresh machine, no account listed, a plan that starts later: the row says when, and the pencil removes it', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input) === '/api/accounts' ? Response.json({ accounts: [] }) : Response.json({})) as typeof fetch
    const saves: unknown[] = []
    const billing = { profiles: { claude: { periods: [{ id: 'f1', mode: 'subscription', planId: 'claude-pro', price: { amount: 20, currency: 'USD' }, from: future }] } } }
    const el = mount('/usage', saves, billing)
    await flush()
    expect(el.textContent).toContain('Plan starts')
    expect(el.textContent).not.toContain('No plan')
    act(() => (el.querySelector('button[aria-label="Edit · Claude Code"]') as HTMLButtonElement).click())
    await flush()
    expect(document.querySelector('[data-account-default]')).not.toBeNull()
    click('Remove this plan'); await flush(); click('Remove'); await flush()
    expect((saves[0] as (b: unknown) => unknown)(billing)).toEqual({ profiles: {} })
  })
  test('a "not sure yet" plan can be removed', async () => {
    const saves: unknown[] = []
    const billing = { profiles: {}, accountProfiles: { 'claude:c1': { periods: [{ id: 'u1', mode: 'unknown', from: '2026-01-01' }] } } }
    const el = mount('/usage', saves, billing)
    await flush()
    act(() => (el.querySelector('button[aria-label="Edit · me@example.test"]') as HTMLButtonElement).click())
    await flush()
    click('Remove this plan'); await flush(); click('Remove'); await flush()
    expect((saves[0] as (b: unknown) => unknown)(billing)).toEqual({ profiles: {} })
  })
  test('the plan of an account that left the list is listed and removable', async () => {
    const saves: unknown[] = []
    const billing = { profiles: {}, accountProfiles: { 'claude:gone': { periods: [{ id: 'g1', mode: 'unknown', from: '2026-01-01' }] } } }
    const el = mount('/usage', saves, billing)
    await flush()
    const del = el.querySelector('[data-orphan-plan="claude:gone"] button') as HTMLButtonElement
    expect(del).not.toBeNull()
    act(() => del.click()); await flush(); click('Remove'); await flush()
    expect((saves[0] as (b: unknown) => unknown)(billing)).toEqual({ profiles: {} })
  })
})

describe('the agent use in the account editor (CONTAS.AGENDA-SALVAR)', () => {
  /** The drawer slides out before it unmounts: wait for the end of the transition. */
  const drawerClosed = async () => {
    for (let i = 0; i < 25; i++) {
      if (!document.querySelector('[role=dialog]')) return true
      await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    }
    return false
  }
  const openEditor = async () => {
    const el = mount('/usage')
    await flush()
    act(() => (el.querySelector('button[aria-label="Set plan · me@example.test"]') as HTMLButtonElement).click())
    await flush()
    return document.querySelector('[role=dialog]') as HTMLElement
  }
  const sw = (dialog: HTMLElement, label: string) => dialog.querySelector(`[role=switch][aria-label^="${label}"]`) as HTMLButtonElement
  const press = (name: string) => act(() => (Array.from(document.querySelectorAll('button')).find(b => b.textContent === name) as HTMLButtonElement).click())

  test('there is ONE Save: no schedule Save, and a switch alone writes nothing', async () => {
    const dialog = await openEditor()
    expect(dialog.querySelector('[data-agent-schedule-save]')).toBeNull()
    expect(Array.from(dialog.querySelectorAll('button')).filter(b => b.textContent === 'Save')).toHaveLength(1)
    act(() => sw(dialog, 'Schedule').click())
    await flush()
    expect(patches).toEqual([])
  })

  test('the switches, the schedule and the nickname go in ONE PATCH, at Save', async () => {
    const dialog = await openEditor()
    act(() => sw(dialog, 'Override the schedule').click())
    act(() => (dialog.querySelector('[data-agent-day="sat"]') as HTMLButtonElement).click())
    const input = dialog.querySelector('input[maxlength="40"]') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Work')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(patches).toEqual([])
    press('Save')
    await flush()
    expect(patches).toHaveLength(1)
    const body = patches[0]!.body as { nickname: string; agentOverride: boolean; agentUseEnabled?: boolean; agentSchedule: { enabled: boolean; days: Record<string, { windows: unknown[] }> } }
    expect(patches[0]!.url).toBe('/api/accounts/c1')
    expect(body.nickname).toBe('Work')
    expect(body.agentOverride).toBe(true)
    expect(body.agentUseEnabled).toBeUndefined() // only what changed
    expect(body.agentSchedule.enabled).toBe(true)
    expect(Object.keys(body.agentSchedule.days).sort()).toEqual(['fri', 'mon', 'sat', 'thu', 'tue', 'wed'])
  })

  test('Override is disabled while the Agenda is off, and says to turn the Agenda on first', async () => {
    const dialog = await openEditor()
    act(() => sw(dialog, 'Schedule').click())
    await flush()
    expect(sw(dialog, 'Override the schedule').disabled).toBe(true)
    expect(dialog.querySelector('[data-agent-use-switches]')?.textContent).toContain('Turn the schedule on first.')
    expect(dialog.querySelector('[data-agent-now-pill]')?.getAttribute('data-agent-now-pill')).toBe('off')
  })

  test('leaving with changes lists WHAT changed; Discard closes without writing', async () => {
    const dialog = await openEditor()
    act(() => sw(dialog, 'Schedule').click())
    act(() => (dialog.querySelector('[data-agent-day="sat"]') as HTMLButtonElement).click())
    await flush()
    expect(dialog.querySelector('[data-drawer-unsaved]')?.textContent).toBe('2 unsaved changes')
    act(() => (dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click())
    await flush()
    const list = document.querySelector('[data-leave-changes]') as HTMLElement
    expect(list).not.toBeNull()
    const lines = Array.from(list.querySelectorAll('li')).map(li => li.textContent)
    expect(lines.some(l => l?.includes('Schedule: on → off'))).toBe(true)
    expect(lines.some(l => l?.includes('Saturday joined the schedule'))).toBe(true)
    act(() => (document.querySelector('[data-leave-discard]') as HTMLButtonElement).click())
    await flush()
    expect(patches).toEqual([])
    expect(await drawerClosed()).toBe(true)
  })

  test('leaving with changes and choosing Save writes the same one PATCH', async () => {
    const dialog = await openEditor()
    act(() => sw(dialog, 'Schedule').click())
    await flush()
    act(() => (dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click())
    await flush()
    act(() => (document.querySelector('[data-leave-save]') as HTMLButtonElement).click())
    await flush()
    expect(patches).toEqual([{ url: '/api/accounts/c1', body: { agentUseEnabled: false } }])
  })

  test('U4: the drawer footer is Discard + Save (this drawer only); Discard closes without writing', async () => {
    const dialog = await openEditor()
    const footer = Array.from((dialog.querySelector('[data-drawer-discard]') as HTMLElement).parentElement!.querySelectorAll('button')).map(b => b.textContent)
    expect(footer).toEqual(['Discard', 'Save'])
    const foot = dialog.querySelector('[data-drawer-footer]') as HTMLElement
    expect(foot.style.flexDirection).toBe('row') // Discard then Save, side by side, also at 390
    act(() => sw(dialog, 'Schedule').click())
    await flush()
    act(() => (dialog.querySelector('[data-drawer-discard]') as HTMLButtonElement).click())
    await flush()
    expect(patches).toEqual([])
    expect(await drawerClosed()).toBe(true)
  })

  test('U4: the shared Drawer keeps its own footer slot — no hard-coded "Discard" label', () => {
    const src = readFileSync(join(import.meta.dir, '../../components/Drawer.tsx'), 'utf8')
    expect(src).not.toContain('data-drawer-discard')
  })

  test('U5/U6: the leave dialog reads title, list, buttons, THEN the Esc hint, with no icon by the title', async () => {
    const dialog = await openEditor()
    act(() => sw(dialog, 'Schedule').click())
    await flush()
    act(() => (dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click())
    await flush()
    const panel = (document.querySelector('[data-leave-changes]') as HTMLElement).closest('[role="dialog"]') as HTMLElement
    const kids = Array.from(panel.querySelectorAll('[data-confirm-main] > *, [data-leave-changes], [data-leave-discard], [data-dialog-hint]'))
    const order = (el: Element | null) => kids.indexOf(el!)
    const list = panel.querySelector('[data-leave-changes]')
    const discard = panel.querySelector('[data-leave-discard]')
    const hint = panel.querySelector('[data-dialog-hint]')
    expect(hint?.textContent).toBe('Esc goes back to editing.')
    expect(order(list)).toBeLessThan(order(discard))
    expect(discard!.compareDocumentPosition(hint!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // U6: the title row holds only the title text — no icon chip
    const titleRow = panel.querySelector('[id]')!.parentElement!
    expect(titleRow.querySelector('svg')).toBeNull()
  })

  test('with nothing changed, closing asks nothing', async () => {
    const dialog = await openEditor()
    act(() => (dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click())
    await flush()
    expect(document.querySelector('[data-leave-changes]')).toBeNull()
    expect(await drawerClosed()).toBe(true)
  })

  test('the "Now" line is drawn from the server state', async () => {
    account = { ...account, available: false, agentSchedule: { enabled: true, days: {} }, agentUse: { reason: 'day-off', on: false, enabled: true, override: false, dayUsedPct: null, weekUsedPct: null } }
    const dialog = await openEditor()
    expect(dialog.querySelector('[data-agent-now-pill]')?.textContent).toContain('Day not scheduled')
  })
})

describe('the account drawer geometry and folds (CONTAS.AGENDA-SALVAR r4 · N2 + N3)', () => {
  const openEditor = async () => {
    const el = mount('/usage')
    await flush()
    act(() => (el.querySelector('button[aria-label="Set plan · me@example.test"]') as HTMLButtonElement).click())
    await flush()
    return document.querySelector('[role=dialog]') as HTMLElement
  }
  const folds = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-drawer-fold]'))

  test('N2: at 1280 the drawer is 460px wide and starts BELOW the top bar', async () => {
    const dialog = await openEditor()
    expect(dialog.style.width).toBe('460px')
    expect((dialog.parentElement as HTMLElement).style.top).toBe('var(--ag-topbar-h, 44px)')
  })

  test('N2: at 390 the drawer is unchanged (full width, from the very top)', async () => {
    const prev = window.innerWidth
    ;(window as { innerWidth: number }).innerWidth = 390
    try {
      const dialog = await openEditor()
      expect(dialog.style.width).toBe('100%')
      expect((dialog.parentElement as HTMLElement).style.top).toBe('0px')
    } finally { (window as { innerWidth: number }).innerWidth = prev }
  })

  test('N2: the shared Drawer default is untouched for other screens (680px, top 0)', async () => {
    const src = readFileSync(join(import.meta.dir, '../../components/Drawer.tsx'), 'utf8')
    expect(src).toContain('min(680px')
    expect(src).toMatch(/variant\??: 'account'/)
  })

  test('N3: three folds — spend limits, plan, nickname — closed by default, in that order', async () => {
    await openEditor()
    expect(folds().map(f => f.getAttribute('data-drawer-fold'))).toEqual(['limits', 'plan', 'nickname'])
    for (const f of folds()) {
      expect(f.getAttribute('aria-expanded')).toBe('false')
      expect(document.getElementById(f.getAttribute('aria-controls')!)!.hidden).toBe(true)
    }
    expect(folds()[1]!.textContent).toContain('Plan')
  })

  test('N3: a click opens a fold (aria-expanded) and a second click closes it; it is a real button, so Enter activates it', async () => {
    await openEditor()
    const plan = folds()[1]!
    expect(plan.tagName).toBe('BUTTON')
    expect(plan.type).toBe('button')
    act(() => plan.click())
    expect(plan.getAttribute('aria-expanded')).toBe('true')
    const body = document.getElementById(plan.getAttribute('aria-controls')!)!
    expect(body.hidden).toBe(false)
    expect(body.textContent).toContain('Started on')
    expect(body.textContent).toContain('I still pay for this plan')
    expect(folds()[0]!.getAttribute('aria-expanded')).toBe('false')
    act(() => plan.click())
    expect(plan.getAttribute('aria-expanded')).toBe('false')
    expect(body.hidden).toBe(true)
  })

  test('N3: no field is lost — nickname lives in its fold, plan fields in the plan fold', async () => {
    await openEditor()
    const nick = document.getElementById(folds()[2]!.getAttribute('aria-controls')!)!
    expect(nick.querySelector('input[maxlength="40"]')).not.toBeNull()
    const plan = document.getElementById(folds()[1]!.getAttribute('aria-controls')!)!
    expect(plan.textContent).toContain('Started on')
    expect(plan.textContent).toContain('I still pay for this plan')
    const limits = document.getElementById(folds()[0]!.getAttribute('aria-controls')!)!
    expect(limits).not.toBeNull()
  })

  test('N3: a plan error opens the plan fold by itself — a failed Save is never hidden behind a closed fold', async () => {
    await openEditor()
    const plan = folds()[1]!
    act(() => plan.click()) // open, change something that needs a plan, fold it again
    const body = document.getElementById(plan.getAttribute('aria-controls')!)!
    act(() => (Array.from(body.querySelectorAll('label,button,span')).find(x => x.textContent === 'I still pay for this plan') as HTMLElement).click())
    await flush()
    act(() => plan.click())
    expect(plan.getAttribute('aria-expanded')).toBe('false')
    act(() => (Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLButtonElement).click())
    await flush()
    expect(plan.getAttribute('aria-expanded')).toBe('true') // forced open by the error
    expect(body.hidden).toBe(false)
    expect(body.textContent).toMatch(/plan|date|price/i)
  })
})
