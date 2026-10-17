/** Escape belongs to the top-most open overlay only — real DOM, real ConfirmModals. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let ConfirmModal: typeof import('../pages/settings/primitives').ConfirmModal
let useEscapeOwner: typeof import('./overlayStack').useEscapeOwner

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  ConfirmModal = (await import('../pages/settings/primitives')).ConfirmModal
  useEscapeOwner = (await import('./overlayStack')).useEscapeOwner
})
afterAll(async () => { await GlobalRegistrator.unregister() })

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const mount = (el: ReactElement) => act(() => { root.render(el) })
const esc = () => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })

/** Stands in for a screen (Nay settings, Drawer) that closes on Escape through the same hook. */
function Screen({ onBack }: { onBack: () => void }) {
  useEscapeOwner(true, onBack, () => !document.querySelector('[role="listbox"]'))
  return createElement('div')
}
const confirm = (title: string, onCancel: () => void) =>
  createElement(ConfirmModal, { key: title, open: true, title, message: 'm', confirmLabel: 'ok', cancelLabel: 'cancel', onConfirm() {}, onCancel })

describe('overlay stack', () => {
  test('a settings screen with a confirmation on top: Escape closes only the confirmation', () => {
    const log: string[] = []
    const back = () => log.push('screen')
    mount(createElement('div', null, createElement(Screen, { onBack: back })))
    mount(createElement('div', null, createElement(Screen, { onBack: back }), confirm('away', () => log.push('dialog'))))
    esc()
    expect(log).toEqual(['dialog'])
  })

  test('once the confirmation is gone the screen owns Escape again', () => {
    const log: string[] = []
    const back = () => log.push('screen')
    mount(createElement('div', null, createElement(Screen, { onBack: back })))
    mount(createElement('div', null, createElement(Screen, { onBack: back }), confirm('away', () => log.push('dialog'))))
    mount(createElement('div', null, createElement(Screen, { onBack: back })))
    esc()
    expect(log).toEqual(['screen'])
  })

  test('two stacked ConfirmModals: one Escape closes only the top one', () => {
    const log: string[] = []
    mount(createElement('div', null, confirm('first', () => log.push('first'))))
    mount(createElement('div', null, confirm('first', () => log.push('first')), confirm('second', () => log.push('second'))))
    esc()
    expect(log).toEqual(['second'])
  })
})
