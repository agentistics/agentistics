/** UI.TABS-LIST fix1: fade only on real overflow, same menu on mobile, real band name, task in header. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { readFileSync } from 'node:fs'

let createRoot: typeof import('react-dom/client').createRoot
let FadeText: typeof import('./FadeText').FadeText
let SessionTabStrip: typeof import('./SessionTabStrip').SessionTabStrip
let store: typeof import('../../lib/sessionTabsStore')
let pins: typeof import('../../lib/pinnedSessions')
let labels: typeof import('../../lib/sessionBandLabels')

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  window.matchMedia = ((q: string) => ({ matches: /max-width/.test(q), addEventListener() {}, removeEventListener() {} })) as never
  Element.prototype.scrollIntoView = () => {}
  createRoot = (await import('react-dom/client')).createRoot
  FadeText = (await import('./FadeText')).FadeText
  SessionTabStrip = (await import('./SessionTabStrip')).SessionTabStrip
  store = await import('../../lib/sessionTabsStore')
  pins = await import('../../lib/pinnedSessions')
  labels = await import('../../lib/sessionBandLabels')
})
afterAll(async () => {
  await new Promise(r => setTimeout(r, 50))
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(async () => {
  await act(async () => { root.unmount(); for (const k of pins.getPinnedIds()) pins.togglePinnedSession(k) })
  host.remove()
})

const widths = (scroll: number, client: number) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => scroll })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => client })
}
const noWidths = () => { delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth; delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth }

describe('FadeText', () => {
  test('a title that fits has no mask', async () => {
    widths(121, 128)
    await act(async () => root.render(createElement(FadeText as never, { 'data-t': '1' } as never, 'QA ao vivo')))
    const el = host.querySelector<HTMLElement>('[data-t]')!
    expect(el.dataset.fade).toBe('off')
    expect(el.style.maskImage ?? '').toBe('')
    noWidths()
  })
  test('a title that overflows is masked', async () => {
    widths(300, 128)
    await act(async () => root.render(createElement(FadeText as never, { 'data-t': '1' } as never, 'A very long title')))
    const el = host.querySelector<HTMLElement>('[data-t]')!
    expect(el.dataset.fade).toBe('on')
    expect(el.getAttribute('style')).toContain('mask-image')
    noWidths()
  })
})

const mk = (id: string, state = 'waiting') => ({
  id, title: `Title ${id}`, harness: 'claude', cwd: '/x', project: 'x', state, stateLabel: state,
  actionable: true, attachCommand: '', verbs: [],
}) as unknown as ControlSession

describe('mobile switcher', () => {
  test('lists the Sleeping section like the desktop menu', () => {
    store.resetOpenTabsCache()
    act(() => { store.setOpenTabs('main', ['a', 'b']) })
    act(() => { pins.togglePinnedSession('c') })
    const rows = [mk('a'), mk('b'), mk('c', 'exited')]
    act(() => root.render(createElement(SessionTabStrip, {
      lang: 'en', rows, fleetReady: true, active: rows[0]!, onReopen: async () => ({ ok: true, message: '' }), onGo: () => {}, onNone: () => {},
      switcher: { leading: null },
    })))
    act(() => (host.querySelector('[data-session-switcher]') as HTMLButtonElement).click())
    const menu = document.querySelector('[role="menu"]')!
    expect(Array.from(menu.querySelectorAll('button')).some(b => b.textContent === 'Sleeping')).toBe(true)
    expect(menu.textContent).toContain('Title c')
    expect(menu.textContent).toContain('reopen')
  })
})

describe('copy and header', () => {
  test('a pin asks for the history rows itself (no aside mounted on a phone), so the sleeping section survives a reload', () => {
    const src = readFileSync(new URL('./SessionTabStrip.tsx', import.meta.url), 'utf8')
    expect(src).toContain('loadClosedFleet()')
  })
  test('the closing bar names the real band', () => {
    const src = readFileSync(new URL('./SessionPanel.tsx', import.meta.url), 'utf8')
    expect(src).toContain('inactiveBandLabel(true)')
    expect(src).not.toContain('salva em Encerradas')
    expect(labels.inactiveBandLabel(true)).toBe('Inativas')
    expect(labels.inactiveBandLabel(false)).toBe('Inactive')
    const aside = readFileSync(new URL('../nav/SessionsAside.tsx', import.meta.url), 'utf8')
    expect(aside).toContain('label: inactiveBandLabel(pt)')
  })
  test('the open session header shows the task title as a fading line, and no ellipsis', () => {
    const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('data-header-task')
    expect(app).toContain('{headerSession.task}')
    const link = readFileSync(new URL('./SessionLinkInfo.tsx', import.meta.url), 'utf8')
    expect(link).not.toContain("textOverflow: 'ellipsis'")
  })
})
