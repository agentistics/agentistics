import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'
import type { SwitchInfo } from '../lib/accountSwitch'

let createRoot: typeof import('react-dom/client').createRoot
let Foot: typeof import('./PlanUsageFootButton').PlanUsageFootButton
let Modal: typeof import('./PlanUsageModal').PlanUsageModal
let Dialog: typeof import('./sessions/AccountSwitch').AccountSwitchDialog
let Router: typeof import('react-router-dom').MemoryRouter
let useInfo: typeof import('./sessions/AccountSwitch').useSwitchInfo
let originalFetch: typeof fetch
let root: Root | undefined
let info: SwitchInfo
let posts: unknown[] = []
let reads: string[] = []
let followed = ''
const available: SwitchInfo = {
  ok: true, supported: true, current: { id: 'a', label: 'Work #1', harness: 'claude' },
  options: [{ id: 'b', label: 'Work #2', harness: 'claude' }], limit: null,
}

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url)
    if (path.startsWith('/api/fleet/switch-account') && init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return Response.json({ ok: true, id: 'reopened', message: 'Switched' }) }
    if (path.startsWith('/api/fleet/switch-account')) { reads.push(path); return Response.json(info) }
    return Response.json({ limits: [] })
  }) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  Foot = (await import('./PlanUsageFootButton')).PlanUsageFootButton
  Modal = (await import('./PlanUsageModal')).PlanUsageModal
  const accounts = await import('./sessions/AccountSwitch')
  Dialog = accounts.AccountSwitchDialog
  useInfo = accounts.useSwitchInfo
  Router = (await import('react-router-dom')).MemoryRouter
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  document.body.innerHTML = ''
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

// The shell supplies one selected session to both surfaces and owns the existing account dialog.
function Surface({ modal = false, selected = true, lang = 'en' }: { modal?: boolean; selected?: boolean; lang?: 'pt' | 'en' }) {
  const [switchInfo] = useInfo(selected ? 'open-session' : undefined, lang)
  const [switching, setSwitching] = useState(false)
  const [visible, setVisible] = useState(true)
  const session = selected ? { id: 'open-session', title: 'Fix usage', accountLabel: 'Work #1', info: switchInfo, onSwitch: () => setSwitching(true) } : undefined
  return createElement(Router, null,
    visible && (modal
      ? createElement(Modal, { lang, openSession: session, switchDialogOpen: switching, onClose: () => setVisible(false) })
      : createElement(Foot, { lang, collapsed: false, footBtn: {}, openSession: session })),
    switching && switchInfo && createElement(Dialog, { open: true, sessionId: session!.id, info: switchInfo, lang, fromLimit: false,
      onClose: () => setSwitching(false), onSwitched: id => { followed = id } }),
  )
}
async function mount(props: Parameters<typeof Surface>[0] = {}) {
  posts = []; reads = []; followed = ''
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Surface, props)) })
}
async function hover() {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  await act(async () => { trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  return trigger
}
const switchButton = () => document.querySelector<HTMLButtonElement>('[data-plan-usage-switch]')
const key = (el: Element | Window, value: string, shiftKey = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }))

describe('Plan usage open-session switch', () => {
  for (const modal of [false, true]) {
    test(`${modal ? 'modal' : 'popover'} identifies the session and opens the existing dialog for its id`, async () => {
      info = available
      await mount({ modal, lang: 'pt' })
      if (!modal) await hover()
      expect(document.querySelector('[data-plan-usage-session]')?.textContent).toContain('Sessão aberta: Fix usage · conta Work #1')
      expect(switchButton()?.textContent).toContain('Trocar conta da sessão aberta')
      await act(async () => { switchButton()!.click() })
      if (!modal) expect(document.querySelector('[data-plan-usage-popover]')).toBeNull()
      expect(document.querySelector('[data-account-switch]')).not.toBeNull()
      expect(reads.some(p => p.includes('id=open-session'))).toBe(true)
      const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Confirmar troca')!
      await act(async () => { confirm.click() })
      expect(posts).toEqual([{ id: 'open-session', accountId: 'b', resendPending: false }])
      expect(followed).toBe('reopened')
    })
    test(`${modal ? 'modal' : 'popover'} omits the section without an open session`, async () => {
      info = available
      await mount({ modal, selected: false })
      if (!modal) await hover()
      expect(document.querySelector('[data-plan-usage-session]')).toBeNull()
      expect(switchButton()).toBeNull()
      expect(reads).toEqual([])
    })
    test(`${modal ? 'modal' : 'popover'} keeps the session line and existing unavailable reason`, async () => {
      info = { ...available, supported: false, options: [], unavailable: [{ id: 'b', harness: 'gemini', label: 'Work #2', reason: 'cant_carry' }] }
      await mount({ modal })
      if (!modal) await hover()
      expect(document.querySelector('[data-plan-usage-session]')?.textContent).toContain('Open session: Fix usage · account Work #1')
      expect(document.querySelector('[data-plan-usage-session]')?.textContent).toContain("This assistant can't carry the conversation to another account")
      expect(switchButton()).toBeNull()
    })
  }
  test('an ended or unsupported session keeps its line with the existing generic refusal', async () => {
    info = { ok: true, supported: false, options: [], limit: null }
    await mount({ modal: true })
    expect(document.querySelector('[data-plan-usage-session]')?.textContent).toContain('Open session: Fix usage')
    expect(document.querySelector('[data-plan-usage-session]')?.textContent).toContain('Unavailable right now')
    expect(switchButton()).toBeNull()
  })
  test('the 390px modal uses the existing mobile switch dialog and touch target', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    info = available
    try {
      await mount({ modal: true })
      expect(switchButton()!.style.minHeight).toBe('44px')
      await act(async () => { switchButton()!.click() })
      expect(document.querySelector('[data-account-switch]')).not.toBeNull()
      await act(async () => { key(window, 'Escape') })
      expect(document.querySelector('[data-plan-usage-modal]')).not.toBeNull()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    }
  })
  test('Tab and Shift+Tab traverse both portaled actions, and the hover grace keeps Switch reachable', async () => {
    info = available
    await mount()
    const trigger = await hover()
    await act(async () => { trigger.focus(); key(trigger, 'Tab') })
    const open = document.querySelector('[data-plan-usage-open]')!
    expect(document.activeElement).toBe(open)
    await act(async () => { key(open, 'Tab') })
    expect(document.activeElement).toBe(switchButton())
    await act(async () => { key(switchButton()!, 'Tab', true) })
    expect(document.activeElement).toBe(open)
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      document.querySelector('[data-plan-usage-popover]')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 120))
    })
    expect(switchButton()).not.toBeNull()
  })
  test('Escape closes the account dialog before its usage modal; Tab stays in the account dialog', async () => {
    info = available
    await mount({ modal: true })
    const opener = switchButton()!
    await act(async () => { opener.focus(); opener.click() })
    const dialog = document.querySelector('[data-account-switch]')!.closest('[role="dialog"]')!
    const last = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).at(-1)!
    await act(async () => { last.focus(); key(last, 'Tab') })
    expect(dialog.contains(document.activeElement)).toBe(true)
    await act(async () => { key(window, 'Escape') })
    expect(document.querySelector('[data-account-switch]')).toBeNull()
    expect(document.querySelector('[data-plan-usage-modal]')).not.toBeNull()
    expect(document.activeElement).toBe(opener)
    await act(async () => { key(window, 'Escape') })
    expect(document.querySelector('[data-plan-usage-modal]')).toBeNull()
  })
})
