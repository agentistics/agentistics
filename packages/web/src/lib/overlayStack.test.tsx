/** Escape belongs to the top-most open overlay only — real DOM, real ConfirmModals. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let ConfirmModal: typeof import('../pages/settings/primitives').ConfirmModal
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let Select: typeof import('../pages/settings/primitives').Select
let PlanUsageModal: typeof import('../components/PlanUsageModal').PlanUsageModal
let DockSettingsScreen: typeof import('../components/nay/DockSettings').DockSettingsScreen
let useEscapeOwner: typeof import('./overlayStack').useEscapeOwner

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  ;(Element.prototype as unknown as { getAnimations: () => [] }).getAnimations = () => []
  ;(Element.prototype as unknown as { animate: () => unknown }).animate = () => ({ cancel() {}, play() {}, pause() {}, finished: Promise.resolve() })
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  ConfirmModal = (await import('../pages/settings/primitives')).ConfirmModal
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  Select = (await import('../pages/settings/primitives')).Select
  PlanUsageModal = (await import('../components/PlanUsageModal')).PlanUsageModal
  DockSettingsScreen = (await import('../components/nay/DockSettings')).DockSettingsScreen
  useEscapeOwner = (await import('./overlayStack')).useEscapeOwner
})
afterAll(async () => { await new Promise(r => setTimeout(r, 50)); await GlobalRegistrator.unregister() })

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const mount = (el: ReactElement) => act(() => { root.render(el) })
const esc = () => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })

/** Stands in for a screen (Nay settings, Drawer) that closes on Escape through the same hook. */
function Screen({ onBack }: { onBack: () => void }) {
  useEscapeOwner(true, onBack)
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

  test('an open Select inside a screen closes first, then the screen', () => {
    const log: string[] = []
    mount(createElement('div', null, createElement(Screen, { onBack: () => log.push('screen') }),
      createElement(Select, { value: 'a', onChange() {}, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })))
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click() })
    expect(document.querySelector('[role="listbox"]')).toBeTruthy()
    esc()
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(log).toEqual([])
    esc()
    expect(log).toEqual(['screen'])
  })

  test('PlanUsageModal over the real Nay settings screen: one Escape closes only the modal', () => {
    const log: string[] = []
    const settings = createElement(DockSettingsScreen, { key: 's', pt: false, isMobile: false, chat: {} as never, onLeave() {}, onBack: () => log.push('settings') })
    const wrap = (...kids: ReactElement[]) => createElement(MemoryRouter, null, createElement('div', null, ...kids))
    mount(wrap(settings))
    mount(wrap(settings, createElement(PlanUsageModal, { key: 'p', lang: 'en', onClose: () => log.push('usage') })))
    esc()
    expect(log).toEqual(['usage'])
    mount(wrap(settings))
    esc()
    expect(log).toEqual(['usage', 'settings'])
  })
})
