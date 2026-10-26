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
let originalFetch: typeof globalThis.fetch
let originalEventSource: typeof globalThis.EventSource
let originalActEnvironment: boolean | undefined
let originalPins: readonly string[]
let originalScrollIntoView: PropertyDescriptor | undefined


beforeAll(async () => {
  originalFetch = globalThis.fetch
  originalEventSource = globalThis.EventSource
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Element.prototype.scrollIntoView = () => {}
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  createRoot = (await import('react-dom/client')).createRoot
  SessionTabStrip = (await import('./SessionTabStrip')).SessionTabStrip
  store = await import('../../lib/sessionTabsStore')
  pins = await import('../../lib/pinnedSessions')
  originalPins = [...pins.getPinnedIds()]
  for (const k of originalPins) pins.togglePinnedSession(k)
})
afterAll(async () => {
  for (const k of originalPins) pins.togglePinnedSession(k)
  // React's scheduler posts a macrotask even after an act/unmount. Keep window alive until it runs.
  await new Promise(resolve => setTimeout(resolve, 50))
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  else delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})

const mk = (id: string, harness = 'claude') => ({
  id, title: `Title ${id}`, harness, cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'needs you',
  actionable: true, attachCommand: '', verbs: [],
}) as unknown as ControlSession
const rows = [mk('a'), mk('b', 'codex'), mk('c', 'gemini')]

let host: HTMLDivElement
let root: Root
let went: string[]
const render = (shown = rows, onReopen = async (_row: ControlSession) => ({ ok: true, message: '' })) => act(() => {
  root.render(createElement(SessionTabStrip, { lang: 'en', rows: shown, fleetReady: true, active: shown[0]!, onReopen, onGo: id => { went.push(id) }, onNone: () => {} }))
})
const tab = (id: string) => host.querySelector(`[data-session-tab="${id}"]`) as HTMLElement
const close = (id: string) => tab(id).querySelector('[aria-label="Close tab"]') as HTMLElement | null
const opacity = (el: HTMLElement) => el.style.opacity

beforeEach(() => {
  store.resetOpenTabsCache()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); went = []
  act(() => { store.setOpenTabs('main', ['a', 'b', 'c']) })
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
    for (const k of pins.getPinnedIds()) pins.togglePinnedSession(k)
  })
  host.remove()
})

describe('desktop', () => {
  test('needs-you tabs keep their status dot and bold title without an underline', () => {
    render()
    const needs = tab('b')
    expect(needs.style.fontWeight).toBe('650')
    expect(needs.style.color).toBe('var(--text-primary)')
    expect(needs.style.boxShadow).toBe('none')
    expect(needs.style.borderBottomStyle).toBe('none')
    expect(needs.querySelector('[role="img"][aria-label="needs you"]')).not.toBeNull()
  })

  test('the desktop band leaves room for the active tab to overlap the header without scroll clipping', () => {
    render()
    const band = host.querySelector<HTMLElement>('[data-session-tabs]')!
    const track = host.querySelector<HTMLElement>('[role="tablist"]')!
    expect(band.style.height).toBe('44px')
    expect(band.style.background).toBe('var(--bg-base)')
    expect(band.style.borderBottomWidth).toBe('')
    expect(tab('a').style.background).toBe('var(--bg-card)')
    expect(tab('a').style.borderTopLeftRadius).toBe('10px')
    expect(tab('a').style.borderBottomLeftRadius).toBe('0px')
    expect(tab('a').style.borderBottomRightRadius).toBe('0px')
    expect(tab('a').style.boxShadow).toBe('0 2px 0 var(--bg-card)')
    expect(track.style.height).toBe('38px')
    expect(track.style.paddingBottom).toBe('2px')
    expect(track.style.marginBottom).toBe('-2px')
    expect(track.style.zIndex).toBe('1')
  })

  test('the active tab shows its ×; the others hide it until hover; the harness icon is drawn', () => {
    render()
    expect(host.querySelectorAll('[role="tab"]').length).toBe(3)
    expect(opacity(close('a')!)).toBe('1')
    expect(opacity(close('b')!)).toBe('0')
    act(() => { tab('b').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
    expect(opacity(close('b')!)).toBe('1')
    for (const [id, h] of [['a', 'claude'], ['b', 'codex'], ['c', 'gemini']] as const) {
      const mark = tab(id).querySelector('[data-harness-mark]') ?? tab(id).querySelector(`[aria-label*="${h}" i], [title*="${h}" i]`)
      expect(mark).not.toBeNull()
    }
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
    const track = host.querySelector<HTMLElement>('[role="tablist"]')!
    expect(track.style.padding).toBe('3px')
    expect(track.style.margin).toBe('4px 6px')
    expect(track.style.borderRadius).toBe('10px')
    expect(tab('a').style.minHeight).toBe('44px')
    expect(tab('a').style.borderRadius).toBe('8px')
    expect(tab('a').style.background).toBe('var(--bg-elevated)')
    for (const id of ['a', 'b', 'c']) {
      const x = close(id)!
      expect(opacity(x)).toBe('1')
      expect(x.style.width).toBe('32px')
      expect(x.style.height).toBe('32px')
    }
  })
})

describe('keyboard and coarse pointer', () => {
  const key = (el: HTMLElement, k: string) => act(() => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })

  test('the × and the pin are real buttons in the tab order', () => {
    act(() => { pins.togglePinnedSession('b') })
    render()
    expect(close('a')!.tagName).toBe('BUTTON')
    expect(tab('b').querySelector('[aria-label="Unpin"]')!.tagName).toBe('BUTTON')
  })

  test.each(['Enter', ' '])('%j on × closes the tab without activating it', k => {
    render()
    key(close('b')!, k)
    expect(went).toEqual([]) // the key did not reach the tab's own Enter/Space handler
    act(() => { close('b')!.click() }) // a browser turns Enter/Space on a <button> into this click; happy-dom does not
    expect(store.getOpenTabs('main')).not.toContain('b')
    expect(went).toEqual([])
  })

  test.each(['Enter', ' '])('%j on the pin unpins without activating the tab', k => {
    act(() => { pins.togglePinnedSession('b') })
    render()
    key(tab('b').querySelector('[aria-label="Unpin"]') as HTMLElement, k)
    // a real <button> turns Enter/Space into a click in a browser; happy-dom does not, so click too
    act(() => { (tab('b').querySelector('[aria-label="Unpin"]') as HTMLElement).click() })
    expect(pins.getPinnedIds()).not.toContain('b')
    expect(went).toEqual([])
  })

  test('a coarse pointer at 1024px shows a 32px × on every unpinned tab', () => {
    ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1024, height: 800 })
    const prev = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('pointer: coarse'), addEventListener() {}, removeEventListener() {} })) as never
    try {
      render()
      for (const id of ['a', 'b', 'c']) {
        const x = close(id)!
        expect(opacity(x)).toBe('1')
        expect(x.style.width).toBe('32px')
        expect(x.style.height).toBe('32px')
      }
    } finally { window.matchMedia = prev }
  })
})


describe('sleeping tabs', () => {
  test.each([1200, 390])('menu stays first and outside the track, and counts only drawn tabs (%spx)', width => {
    ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 800 })
    act(() => { pins.togglePinnedSession('b') })
    const shown = rows.map(r => r.id === 'b' ? { ...r, state: 'closed' as const, title: '[ LEADER ] - Sleeping conversation' } : r)
    render(shown)
    expect(tab('b')).toBeNull()
    expect(pins.getPinnedIds()).toContain('b')
    const button = host.querySelector('[aria-label="Open and sleeping tabs"]') as HTMLButtonElement
    const track = host.querySelector('[role="tablist"]')!
    expect(button.nextElementSibling).toBe(track)
    expect(track.contains(button)).toBe(false)
    expect(button.textContent).toBe('2')
    expect(button.querySelector('.lucide-moon')).not.toBeNull()
    expect(button.style.flexShrink).toBe('0')
    expect(button.style.height).toBe(width === 390 ? '44px' : '30px')
    button.getBoundingClientRect = () => ({ left: 12, right: 88, bottom: 70 } as DOMRect)
    act(() => button.click())
    const menu = document.querySelector('[role="menu"]') as HTMLElement
    expect(menu.style.left).toBe(width === 390 ? '8px' : '12px')
    expect(menu.style.top).toBe('74px')
    const entries = Array.from(menu.querySelectorAll('button'))
    const header = entries.find(e => e.textContent === 'Sleeping')!
    expect(header.disabled).toBe(true)
    expect(entries.find(e => e.querySelector('[data-menu-title]')?.textContent === 'Sleeping conversation')).toBeDefined()
    expect(menu.querySelector('[role="separator"]')).not.toBeNull()
  })

  test('picking a sleeping entry invokes reopen; a live update restores its pinned tab', async () => {
    act(() => { pins.togglePinnedSession('b') })
    const shown = rows.map(r => r.id === 'b' ? { ...r, state: 'exited' as const } : r)
    const reopened: string[] = []
    render(shown, async row => { reopened.push(row.id); return { ok: true, message: '' } })
    act(() => (host.querySelector('[aria-label="Open and sleeping tabs"]') as HTMLButtonElement).click())
    await act(async () => {
      const entry = Array.from(document.querySelectorAll('[role="menu"] button')).find(e => e.querySelector('[data-menu-title]')?.textContent === 'Title b') as HTMLButtonElement
      entry.click()
    })
    expect(reopened).toEqual(['b'])
    expect(went).toEqual([])
    render()
    expect(tab('b')).not.toBeNull()
    expect(tab('b').querySelector('[aria-label="Unpin"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Open and sleeping tabs"] .lucide-moon')).toBeNull()
  })

  test('an unpinned ended tab is still drawn and no moon is shown', () => {
    render(rows.map(r => r.id === 'b' ? { ...r, state: 'exited' as const } : r))
    expect(tab('b')).not.toBeNull()
    expect(host.querySelector('[aria-label="Open and sleeping tabs"] .lucide-moon')).toBeNull()
  })
})


test('opening the check-in modal closes the session info popover', async () => {
  const { SessionLinkInfo } = await import('./SessionLinkInfo')
  const { openCheckinModal, closeCheckinModal } = await import('../../lib/checkinModal')
  act(() => root.render(createElement(SessionLinkInfo, { session: { id: 'session-info' }, links: null, lang: 'en', onGo: () => {} })))
  const button = host.querySelector<HTMLButtonElement>('[data-testid="session-link-info"]')!
  try {
    act(() => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-testid="session-link-panel"]')).not.toBeNull()
    act(() => openCheckinModal('session-info'))
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-testid="session-link-panel"]')).toBeNull()
  } finally { act(() => closeCheckinModal()) }
})

for (const width of [1280, 390]) {
  test(`arrows, Home and End move focus and the roving stop without opening a tab (${width}px)`, () => {
    (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 800 })
    render()
    const key = (el: HTMLElement, k: string) => act(() => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
    act(() => tab('a').focus())
    for (const [from, k, to] of [['a', 'ArrowRight', 'b'], ['b', 'End', 'c'], ['c', 'ArrowRight', 'a'], ['a', 'ArrowLeft', 'c'], ['c', 'Home', 'a']] as const) {
      key(tab(from), k)
      expect(document.activeElement).toBe(tab(to))
      expect(tab(to).tabIndex).toBe(0)
      expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
    }
    expect(went).toEqual([])
    key(tab('a'), 'ArrowRight')
    key(tab('b'), 'Enter')
    expect(went).toEqual(['b'])
    act(() => tab('a').focus())
    expect(tab('a').tabIndex).toBe(0)
    expect(tab('b').tabIndex).toBe(-1)
  })

  test(`full titles wrap in the scrolling strip and menu; sleeping leaders keep their badge (${width}px)`, () => {
    (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 800 })
    act(() => pins.togglePinnedSession('b'))
    const title = 'Agentistics Side Tasks — all the work ready for review'
    render(rows.map(r => ({ ...r, title: `[ LÍDER ] - ${title}`, ...(r.id === 'b' ? { state: 'closed' as const } : {}) })))
    const track = host.querySelector<HTMLElement>('[role="tablist"]')!
    expect(track.style.overflowX).toBe('auto')
    expect(track.style.scrollSnapType).toBe('x mandatory')
    expect(tab('a').textContent).toContain(title)
    expect(tab('a').textContent).not.toContain('[ LÍDER ]')
    expect(tab('a').style.scrollSnapAlign).toBe('center')
    expect(tab('a').style.width).toBe(width === 390 ? '100%' : 'max-content')
    for (const el of Array.from(tab('a').querySelectorAll<HTMLElement>('*'))) expect(el.style.textOverflow).not.toBe('ellipsis')
    act(() => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click())
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(parseFloat(menu.style.width)).toBeLessThanOrEqual(width - 16)
    const sleeping = Array.from(menu.querySelectorAll('button')).find(el => el.textContent?.includes('Reopen'))!
    expect(sleeping.querySelector('[data-menu-title]')?.textContent).toBe(title)
    expect(sleeping.textContent).toContain('Leader')
    expect(sleeping.textContent).not.toContain('[ LÍDER ]')
    expect(sleeping.querySelector('[data-menu-title]')?.parentElement?.style.whiteSpace).toBe('normal')
  })
}
