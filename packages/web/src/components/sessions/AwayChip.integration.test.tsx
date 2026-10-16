/**
 * The away dialog, driven through the REAL menus in a real DOM (happy-dom): open the session's ⋯
 * menu, CLICK the away row and look at what the document holds. Nothing here reads a source file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import type { FleetRow } from '../../lib/fleet'

let createRoot: typeof import('react-dom/client').createRoot
let SessionActions: typeof import('./SessionActions').SessionActions
let AwayChip: typeof import('./AwayChip').AwayChip
let AwayDialogHost: typeof import('./AwayChip').AwayDialogHost
let awayMenuItems: typeof import('./AwayChip').awayMenuItems
let reset: () => void
let ConfirmModal: typeof import('../../pages/settings/primitives').ConfirmModal

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  SessionActions = (await import('./SessionActions')).SessionActions
  const chip = await import('./AwayChip')
  AwayChip = chip.AwayChip; AwayDialogHost = chip.AwayDialogHost; awayMenuItems = chip.awayMenuItems
  reset = chip.__resetAwayDialogForTest
  ConfirmModal = (await import('../../pages/settings/primitives')).ConfirmModal
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const row = { id: 'agentop-abc', title: 'a session', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'waiting', actionable: true, attachCommand: '', verbs: [] } as unknown as FleetRow
const act0 = async () => ({ ok: true, message: '' })

let host: HTMLDivElement
let root: Root
const mount = (el: ReactElement) => { act(() => { root.render(el) }) }
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); reset(); act(() => {}) })

const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"]'))
const tab = (shift = false) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true })) })
const key = (k: string) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
const click = (el: Element) => act(() => { (el as HTMLElement).click() })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

/** Everything the real screens mount for one session: its ⋯ menu (with the real away row), the chip and ONE host. */
const screen = (pt = false) => createElement('div', null,
  createElement(SessionActions, { row, lang: pt ? 'pt' : 'en', act: act0, extra: awayMenuItems({ id: row.id, actionable: true, away: true }, pt, false) }),
  createElement(AwayChip, { id: row.id, away: true, pt }),
  createElement(AwayDialogHost),
)

function openFromMenu(pt = false) {
  mount(screen(pt))
  const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${pt ? 'Ações da sessão' : 'Session actions'}"]`)!
  expect(trigger).toBeTruthy()
  click(trigger)
  const item = Array.from(host.querySelectorAll('button')).find(b => /away mode on this session|Modo ausente nesta sessão/i.test(b.textContent ?? ''))!
  expect(item).toBeTruthy()
  click(item)
  return trigger
}

describe.each([['desktop', 1280], ['mobile', 390]])('away dialog from the real ⋯ menu — %s', (_n, width) => {
  beforeEach(() => { (window as unknown as { happyDOM: { setViewport(v: object): void } }).happyDOM.setViewport({ width, height: 800 }) })

  test.each([false, true])('clicking the menu row opens exactly ONE dialog (pt=%s)', pt => {
    openFromMenu(pt)
    expect(dialogs()).toHaveLength(1)
    const d = dialogs()[0]!
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toMatch(/away mode|modo ausente/i)
  })

  test('Tab and Shift+Tab stay inside the dialog', () => {
    openFromMenu()
    const d = dialogs()[0]!
    for (let i = 0; i < 8; i++) { tab(); expect(d.contains(document.activeElement)).toBe(true) }
    for (let i = 0; i < 8; i++) { tab(true); expect(d.contains(document.activeElement)).toBe(true) }
  })

  test('Escape and Cancel give the focus back to the ⋯ trigger', () => {
    const trigger = openFromMenu()
    key('Escape')
    expect(dialogs()).toHaveLength(0)
    expect(document.activeElement).toBe(trigger)
    const t2 = openFromMenu()
    const cancel = Array.from(dialogs()[0]!.querySelectorAll('button')).find(b => b.textContent === 'Cancel')!
    click(cancel)
    expect(dialogs()).toHaveLength(0)
    expect(document.activeElement).toBe(t2)
  })

  test('Apply awaits the store: the dialog stays until the PUT answers', async () => {
    let release!: (r: Response) => void
    const real = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = ((url: string) => {
      if (String(url) !== '/api/away/session') return Promise.resolve(new Response('{}', { status: 200 })) // the global away poll
      calls.push(String(url)); return new Promise<Response>(r => { release = r })
    }) as never
    try {
      openFromMenu()
      const apply = Array.from(dialogs()[0]!.querySelectorAll('button')).find(b => /Apply|Saving/.test(b.textContent ?? ''))!
      click(apply)
      await flush()
      expect(calls).toEqual(['/api/away/session'])
      expect(dialogs()).toHaveLength(1)
      await act(async () => { release(new Response(JSON.stringify({ ok: true }), { status: 200 })); await new Promise(r => setTimeout(r, 0)) })
      expect(dialogs()).toHaveLength(0)
    } finally { globalThis.fetch = real }
  })
})

describe('ConfirmModal restores the opener even when a child autofocuses', () => {
  test.each([
    ['requireText', { requireText: 'DELETE' }],
    ['focusCancel', { focusCancel: true }],
  ])('%s', (_n, props) => {
    const Harness = ({ open }: { open: boolean }) => createElement('div', null,
      createElement('button', { id: 'opener' }, 'open'),
      createElement(ConfirmModal, { open, title: 't', message: 'm', confirmLabel: 'ok', cancelLabel: 'no', onConfirm() {}, onCancel() {}, ...props }))
    mount(createElement(Harness, { open: false }))
    const opener = document.getElementById('opener')!
    opener.focus()
    mount(createElement(Harness, { open: true }))
    expect(document.activeElement).not.toBe(opener) // the child really took the focus
    expect(dialogs()[0]!.contains(document.activeElement)).toBe(true)
    mount(createElement(Harness, { open: false }))
    expect(document.activeElement).toBe(opener)
  })
})
