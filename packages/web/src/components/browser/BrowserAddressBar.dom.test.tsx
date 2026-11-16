/**
 * BrowserAddressBar in a real DOM — F4 of the S10 QA: what the person is typing is never overwritten by a page
 * that navigates underneath (the `editing` guard), and a blur / Escape gives the field back to the page.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let Bar: typeof import('./BrowserAddressBar').BrowserAddressBar
let originalAct: boolean | undefined

beforeAll(async () => {
  originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  Bar = (await import('./BrowserAddressBar')).BrowserAddressBar
})
afterAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const noop = () => {}
const render = (url: string) => act(() => {
  root.render(createElement(Bar, { url, pt: true, hasPage: true, onGo: noop, onBack: noop, onForward: noop, onReload: noop }))
})
const input = () => host.querySelector('[data-browser-url-input]') as HTMLInputElement
const type = (v: string) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => { set.call(input(), v); input().dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event) })
}
const focus = () => act(() => { input().dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }) as unknown as Event); input().focus() })
const blur = () => act(() => { input().blur() })

describe('BrowserAddressBar', () => {
  test('a page that navigates changes the address while the person is NOT typing', () => {
    render('https://exemplo.com/a')
    expect(input().value).toBe('exemplo.com/a')
    render('https://exemplo.com/b')
    expect(input().value).toBe('exemplo.com/b')
  })

  test('what the person is typing is NOT overwritten by a navigation underneath', () => {
    render('https://exemplo.com/a')
    focus()
    type('exemplo.com/digitando')
    render('https://exemplo.com/b')
    expect(input().value).toBe('exemplo.com/digitando')
  })

  test('leaving the field gives it back to the page\'s address', () => {
    render('https://exemplo.com/a')
    focus()
    type('abc')
    render('https://exemplo.com/b')
    blur()
    expect(input().value).toBe('exemplo.com/b')
  })
})
