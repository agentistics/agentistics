/**
 * The overlay stack's ONE rule, driven through real components in a real DOM: Escape closes the
 * top-most registered overlay, always — wherever the focus is, so it can never be swallowed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useState, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import type { FleetRow } from './fleet'

let createRoot: typeof import('react-dom/client').createRoot
let CommentComposer: typeof import('../components/tasks/CommentComposer').CommentComposer
let MultiPicker: typeof import('../pages/settings/primitives').MultiPicker
let Select: typeof import('../pages/settings/primitives').Select
let stack: typeof import('./overlayStack')
let chip: typeof import('../components/sessions/AwayChip')
let SessionActions: typeof import('../components/sessions/SessionActions').SessionActions

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1000, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  CommentComposer = (await import('../components/tasks/CommentComposer')).CommentComposer
  const prim = await import('../pages/settings/primitives')
  MultiPicker = prim.MultiPicker; Select = prim.Select
  stack = await import('./overlayStack')
  chip = await import('../components/sessions/AwayChip')
  SessionActions = (await import('../components/sessions/SessionActions')).SessionActions
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); await GlobalRegistrator.unregister() })

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); chip.__resetAwayDialogForTest(); act(() => {}) })

const mount = (el: ReactElement) => act(() => { root.render(el) })
const escOn = (el: Element) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

/** A dialog that closes on Escape through the stack, with a real close button. */
function Dialog({ log, children }: { log: string[]; children?: React.ReactNode }) {
  stack.useEscapeOwner(true, () => log.push('dialog'))
  return createElement('div', { role: 'dialog' }, createElement('button', { id: 'close' }, 'x'), children)
}

describe('Escape closes the top entry, always', () => {
  test('MultiPicker: Escape in its own search field closes the picker, the next one the dialog', async () => {
    const log: string[] = []
    mount(createElement(Dialog, { log }, createElement(MultiPicker, {
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onCommit() {}, placeholder: 'tags',
      searchPlaceholder: 'search', confirmLabel: n => `Add ${n}`, selectAllLabel: 'all', emptyLabel: 'none',
    })))
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click() })
    await flush()
    const search = host.querySelector<HTMLInputElement>('[role="listbox"] input[type="text"], [role="listbox"] input:not([type])')
      ?? host.querySelector<HTMLInputElement>('[role="listbox"] input')!
    expect(search).toBeTruthy()
    escOn(search)
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(log).toEqual([])
    escOn(document.body)
    expect(log).toEqual(['dialog'])
  })

  test('mention picker open, focus on the dialog close button: Escape closes the picker, then the dialog', () => {
    const log: string[] = []
    const draft = { v: '' }
    function D() {
      const [value, setValue] = useState('')
      draft.v = value
      return createElement(Dialog, { log }, createElement(CommentComposer, {
        lang: 'en', value, onChange: setValue, attachments: [], onAttachments() {}, ariaLabel: 'c', placeholder: 'p',
        submitLabel: 's', busy: false, onSubmit() {},
        mentions: { sessions: [{ id: 's1', title: 'Alpha', shortId: 's1' } as never], comments: [] },
      }))
    }
    mount(createElement(D))
    const ta = host.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'hi #')
      ta.selectionStart = ta.selectionEnd = 4
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.dispatchEvent(new Event('select', { bubbles: true }))
    })
    expect(host.querySelector('[data-mention-picker]')).toBeTruthy()
    const close = host.querySelector<HTMLButtonElement>('#close')!
    act(() => close.focus())
    escOn(close)
    expect(host.querySelector('[data-mention-picker]')).toBeNull()
    expect(log).toEqual([])
    expect(draft.v).toBe('hi #')
    escOn(close)
    expect(log).toEqual(['dialog'])
  })

  test('the away dialog with a Select opened over it: Select first, then the dialog, focus back on the trigger', () => {
    const row = { id: 'agentop-abc', title: 'a session', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'waiting', actionable: true, attachCommand: '', verbs: [] } as unknown as FleetRow
    mount(createElement('div', null,
      createElement(SessionActions, { row, lang: 'en', act: async () => ({ ok: true, message: '' }), extra: chip.awayMenuItems({ id: row.id, actionable: true, away: true }, false, false) }),
      createElement(chip.AwayDialogHost),
      createElement(Select, { value: 'a', onChange() {}, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })))
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')!
    act(() => trigger.click())
    act(() => Array.from(host.querySelectorAll('button')).find(b => /away mode on this session/i.test(b.textContent ?? ''))!.click())
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click() })
    expect(document.querySelector('[role="listbox"]')).toBeTruthy()
    escOn(document.activeElement ?? document.body)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    escOn(document.activeElement ?? document.body)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    expect(document.activeElement).toBe(trigger)
  })

  test('an unmounted overlay leaves no stale entry: Escape then closes the next one down', () => {
    const log: string[] = []
    const base = stack.overlayDepth()
    function Screen({ name }: { name: string }) { stack.useEscapeOwner(true, () => log.push(name)); return null }
    mount(createElement('div', null, createElement(Screen, { key: 'a', name: 'a' }), createElement(Screen, { key: 'b', name: 'b' })))
    expect(stack.overlayDepth()).toBe(base + 2)
    mount(createElement('div', null, createElement(Screen, { key: 'a', name: 'a' })))
    expect(stack.overlayDepth()).toBe(base + 1)
    escOn(document.body)
    expect(log).toEqual(['a'])
    act(() => root.unmount())
    expect(stack.overlayDepth()).toBe(base)
    root = createRoot(host)
  })

  test('a route change unmounting an open picker leaves nothing behind', async () => {
    const base = stack.overlayDepth()
    mount(createElement(MultiPicker, { options: [{ value: 'a', label: 'A' }], onCommit() {}, placeholder: 'p', searchPlaceholder: 's', confirmLabel: () => 'ok', selectAllLabel: 'all', emptyLabel: 'none' }))
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click() })
    expect(stack.overlayDepth()).toBe(base + 1)
    mount(createElement('div'))
    expect(stack.overlayDepth()).toBe(base)
  })

  test('a busy top entry keeps the key: nothing beneath it closes', () => {
    const log: string[] = []
    function Busy() { stack.useEscapeOwner(true, () => log.push('busy'), () => false); return null }
    mount(createElement(Dialog, { log }))
    mount(createElement(Dialog, { log }, createElement(Busy)))
    escOn(document.body)
    expect(log).toEqual([])
  })

  test('inside a terminal or Monaco the key is not a dismissal', () => {
    const log: string[] = []
    mount(createElement(Dialog, { log }, createElement('div', { className: 'xterm' }, createElement('textarea', { id: 't' }))))
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { host.querySelector('#t')!.dispatchEvent(ev) })
    expect(log).toEqual([])
    expect(ev.defaultPrevented).toBe(false)
  })

  test('IME composition is never a dismissal', () => {
    const log: string[] = []
    mount(createElement(Dialog, { log }))
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })) })
    expect(log).toEqual([])
  })
})
