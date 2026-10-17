/** An Escape pressed while a popup inside an overlay is open dismisses the popup first, the overlay next. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, useState } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let CommentComposer: typeof import('../components/tasks/CommentComposer').CommentComposer
let useEscapeOwner: typeof import('./overlayStack').useEscapeOwner

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1000, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  CommentComposer = (await import('../components/tasks/CommentComposer')).CommentComposer
  useEscapeOwner = (await import('./overlayStack')).useEscapeOwner
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); await GlobalRegistrator.unregister() })

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

function Dialog({ log, draft }: { log: string[]; draft: { v: string } }) {
  const [value, setValue] = useState('')
  draft.v = value
  useEscapeOwner(true, () => log.push('dialog'))
  return createElement('div', { role: 'dialog' },
    createElement(CommentComposer, {
      lang: 'en', value, onChange: setValue, attachments: [], onAttachments() {}, ariaLabel: 'c', placeholder: 'p',
      submitLabel: 's', busy: false, onSubmit() {},
      mentions: { sessions: [{ id: 's1', title: 'Alpha', shortId: 's1' } as never], comments: [] },
    }))
}

describe('Escape with an inner popup open', () => {
  test('mention picker: first Escape closes the picker and keeps the draft, second closes the dialog', () => {
    const log: string[] = []
    const draft = { v: '' }
    act(() => root.render(createElement(Dialog, { log, draft })))
    const ta = host.querySelector('textarea')!
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(ta, 'hi #')
      ta.selectionStart = ta.selectionEnd = 4
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.dispatchEvent(new Event('select', { bubbles: true }))
    })
    expect(host.querySelector('[data-mention-picker]')).toBeTruthy()
    const press = () => act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    press()
    expect(host.querySelector('[data-mention-picker]')).toBeNull()
    expect(log).toEqual([])
    expect(draft.v).toBe('hi #')
    press()
    expect(log).toEqual(['dialog'])
  })

  test('an inline role=menu inside a dialog is left to its own handler', () => {
    const log: string[] = []
    function D() {
      const [open, setOpen] = useState(true)
      useEscapeOwner(true, () => log.push('dialog'))
      return createElement('div', { role: 'dialog' },
        createElement('button', { id: 'b' }),
        open && createElement('div', { role: 'menu', onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) } },
          createElement('button', { id: 'mi', role: 'menuitem' })))
    }
    act(() => root.render(createElement(D)))
    const press = () => act(() => { (host.querySelector<HTMLElement>('[role="menu"] #mi') ?? host.querySelector<HTMLElement>('#b')!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    press()
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(log).toEqual([])
    press()
    expect(log).toEqual(['dialog'])
  })
})
