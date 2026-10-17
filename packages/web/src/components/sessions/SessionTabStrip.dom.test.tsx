/**
 * The tab strip in a real DOM (happy-dom): what the person can see and click. Nothing here reads a
 * source file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

let createRoot: typeof import('react-dom/client').createRoot
let SessionTabStrip: typeof import('./SessionTabStrip').SessionTabStrip
let store: typeof import('../../lib/sessionTabsStore')
let pins: typeof import('../../lib/pinnedSessions')

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  Element.prototype.scrollIntoView = () => {}
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  createRoot = (await import('react-dom/client')).createRoot
  SessionTabStrip = (await import('./SessionTabStrip')).SessionTabStrip
  store = await import('../../lib/sessionTabsStore')
  pins = await import('../../lib/pinnedSessions')
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const mk = (id: string, harness = 'claude') => ({
  id, title: `Title ${id}`, harness, cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'needs you',
  actionable: true, attachCommand: '', verbs: [],
}) as unknown as ControlSession
const rows = [mk('a'), mk('b', 'codex'), mk('c', 'gemini')]

let host: HTMLDivElement
let root: Root
let went: string[]
const render = () => act(() => {
  root.render(createElement(SessionTabStrip, { lang: 'en', rows, fleetReady: true, active: rows[0]!, onGo: id => { went.push(id) }, onNone: () => {} }))
})
const tab = (id: string) => host.querySelector(`[data-session-tab="${id}"]`) as HTMLElement
const close = (id: string) => tab(id).querySelector('[aria-label="Close tab"]') as HTMLElement | null
const opacity = (el: HTMLElement) => el.style.opacity

beforeEach(() => {
  store.resetOpenTabsCache()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); went = []
  act(() => { store.setOpenTabs('main', ['a', 'b', 'c']) })
})
afterEach(() => { act(() => root.unmount()); host.remove(); act(() => { for (const k of pins.getPinnedIds()) pins.togglePinnedSession(k) }) })

describe('desktop', () => {
  test('the active tab shows its ×; the others hide it until hover; the harness icon is drawn', () => {
    render()
    expect(host.querySelectorAll('[role="tab"]').length).toBe(3)
    expect(opacity(close('a')!)).toBe('1')
    expect(opacity(close('b')!)).toBe('0')
    act(() => { tab('b').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
    expect(opacity(close('b')!)).toBe('1')
    for (const id of ['a', 'b', 'c']) expect(tab(id).querySelector('[title]:not([role="button"]) , img, svg')).not.toBeNull()
  })

  test('clicking × closes that tab, and the neighbour is not opened by the click', () => {
    render()
    act(() => { close('b')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    expect(store.getOpenTabs('main')).not.toContain('b')
    expect(went).toEqual([])
  })

  test('middle click closes an unpinned tab', () => {
    render()
    act(() => { tab('c').dispatchEvent(new window.MouseEvent('auxclick', { bubbles: true, button: 1 })) })
    expect(store.getOpenTabs('main')).not.toContain('c')
  })

  test('a pinned tab shows the pin instead of ×; clicking the pin unpins; middle click does not close it', () => {
    act(() => { pins.togglePinnedSession('b') })
    render()
    expect(close('b')).toBeNull()
    expect(tab('b').querySelector('[aria-label="Unpin"]')).not.toBeNull()
    act(() => { tab('b').dispatchEvent(new window.MouseEvent('auxclick', { bubbles: true, button: 1 })) })
    expect(store.getOpenTabs('main')).toContain('b')
    act(() => { (tab('b').querySelector('[aria-label="Unpin"]') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    expect(pins.getPinnedIds()).not.toContain('b')
    render()
    expect(close('b')).not.toBeNull()
  })
})

describe('narrow / touch', () => {
  test('× is visible on EVERY unpinned tab, with a ≥32px hit target', () => {
    ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 390, height: 800 })
    render()
    for (const id of ['a', 'b', 'c']) {
      const x = close(id)!
      expect(opacity(x)).toBe('1')
      expect(x.style.width).toBe('32px')
      expect(x.style.height).toBe('32px')
    }
  })
})
