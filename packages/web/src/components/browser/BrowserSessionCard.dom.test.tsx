/**
 * The session browser card in a real DOM (happy-dom), NAVEGADOR S5: what the person sees and what reaches
 * the page. The stream is a fake `openEventStream`; the input socket a fake WebSocket that records sends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

type Listener = (e: MessageEvent) => void
class FakeStream {
  static all: FakeStream[] = []
  url: string
  readyState = 1
  onopen = null
  onmessage = null
  onerror: ((e: Event) => void) | null = null
  closed = false
  listeners = new Map<string, Set<Listener>>()
  constructor(url: string) { this.url = url; FakeStream.all.push(this) }
  addEventListener(t: string, fn: Listener) { (this.listeners.get(t) ?? this.listeners.set(t, new Set()).get(t)!).add(fn) }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn) }
  close() { this.closed = true }
  emit(t: string, data: unknown) { for (const fn of this.listeners.get(t) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent) }
}
class FakeWs {
  static all: FakeWs[] = []
  url: string
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(url: string) { this.url = url; FakeWs.all.push(this) }
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close() { this.closed = true; this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
}

// The stream is INJECTED (`openStream`), never `mock.module`: a module mock is process-wide in bun and would
// replace the stream mux for every test file that runs after this one.
const openStream = (url: string) => new FakeStream(url)

let createRoot: typeof import('react-dom/client').createRoot
let Card: typeof import('./BrowserSessionCard').BrowserSessionCard
let SessionTabStrip: typeof import('../sessions/SessionTabStrip').SessionTabStrip
let TabStripView: typeof import('../sessions/SessionTabStrip').TabStripView
let store: typeof import('../../lib/sessionTabsStore')
let originalWs: typeof globalThis.WebSocket
let originalFetch: typeof globalThis.fetch
let originalAct: boolean | undefined
let originalResize: typeof ResizeObserver

beforeAll(async () => {
  originalWs = globalThis.WebSocket
  originalFetch = globalThis.fetch
  originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 800 })
  originalResize = globalThis.ResizeObserver
  globalThis.ResizeObserver = undefined as never
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  Element.prototype.scrollIntoView = () => {}
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWs
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  createRoot = (await import('react-dom/client')).createRoot
  Card = (await import('./BrowserSessionCard')).BrowserSessionCard
  const sts = await import('../sessions/SessionTabStrip')
  SessionTabStrip = sts.SessionTabStrip
  TabStripView = sts.TabStripView
  store = await import('../../lib/sessionTabsStore')
})
afterAll(async () => {
  await new Promise(r => setTimeout(r, 50))
  store.resetOpenTabsCache()
  globalThis.WebSocket = originalWs
  globalThis.fetch = originalFetch
  globalThis.ResizeObserver = originalResize
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  FakeStream.all = []; FakeWs.all = []
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const JPEG = '/9j/4AAQSkZJRg=='
const state = (lock: 'locked' | 'unlocked', extra: Record<string, unknown> = {}) => ({
  tab: 'T1', activeTab: 'T1', lock, url: 'https://loja.exemplo/entrar', title: 'Loja exemplo', loading: false,
  tabs: [{ id: 'T1', title: 'Loja exemplo', active: true }],
  lastAction: { kind: 'click', label: 'Entrar', x: 742, y: 400, at: 1 }, ...extra,
})
const frame = { tab: 'T1', seq: 1, w: 1280, h: 800, jpeg: JPEG, url: 'https://loja.exemplo/entrar', title: 'Loja exemplo', at: 1 }

interface Opts { maximized?: boolean; onToggleMax?: () => void; onOpenVault?: () => void; setLock?: (id: string, l: 'locked' | 'unlocked', pt: boolean) => Promise<never> | Promise<{ ok: true; lock: 'locked' | 'unlocked' } | { ok: false; code: string; sentence: string; openVault: boolean }> }
const render = (o: Opts = {}) => act(() => {
  root.render(createElement(Card, {
    managedId: 'm1', lang: 'pt', maximized: o.maximized ?? false, openStream,
    onToggleMax: o.onToggleMax ?? (() => {}), onOpenVault: o.onOpenVault ?? (() => {}),
    ...(o.setLock ? { setLock: o.setLock as never } : {}),
  }))
})
const stream = () => FakeStream.all.find(s => !s.closed)!
const feed = (lock: 'locked' | 'unlocked', extra: Record<string, unknown> = {}) => act(() => { stream().emit('state', state(lock, extra)); stream().emit('frame', frame) })
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null
const stubRect = () => {
  const img = q('[data-browser-screen] img') as HTMLImageElement
  img.getBoundingClientRect = () => ({ left: 100, top: 50, width: 640, height: 400, right: 740, bottom: 450, x: 100, y: 50, toJSON() {} }) as DOMRect
}
const pointer = (el: Element, type: string, x: number, y: number) => {
  const ev = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }) as unknown as Event
  el.dispatchEvent(ev)
}

describe('locked (a1-locked)', () => {
  test('stream opens at the screen size and only reopens after a 250ms resize debounce', async () => {
    let resize = () => {}
    let width = 800
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 })
    globalThis.ResizeObserver = class { constructor(cb: () => void) { resize = cb } observe() {} disconnect() {} } as never
    try {
      render()
      expect(stream().url).toBe(`/api/browser/stream?owner=m1&width=800&height=300&dpr=${window.devicePixelRatio || 1}`)
      width = 900
      act(() => resize())
      await act(async () => { await new Promise(r => setTimeout(r, 150)) })
      expect(FakeStream.all.length).toBe(1)
      width = 1000
      act(() => resize())
      await act(async () => { await new Promise(r => setTimeout(r, 150)) })
      expect(FakeStream.all.length).toBe(1)
      await act(async () => { await new Promise(r => setTimeout(r, 130)) })
      expect(stream().url).toContain('width=1000&height=300')
      expect(FakeStream.all.length).toBe(2)
    } finally {
      globalThis.ResizeObserver = undefined as never
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientHeight', heightDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    }
  })
  test('the screen comes through the stream mux for this session', () => {
    render()
    expect(stream().url).toBe('/api/browser/stream?owner=m1')
  })

  test('shows the picture, the pill, the ring and the model\'s action — and NO input path', () => {
    render(); feed('locked')
    expect(q('[data-browser-screen] img')?.getAttribute('src')).toBe(`data:image/jpeg;base64,${JPEG}`)
    expect(q('[data-browser-pill]')?.textContent).toBe('Só olhando · clique no cadeado para usar')
    expect(q('[data-browser-caption]')?.textContent).toBe('Clicando em Entrar')
    const ring = q('[data-browser-ring]')!
    expect(ring.style.left).toBe(`${(742 / 1280) * 100}%`)
    expect(ring.style.top).toBe('50%')
    expect(q('[data-browser-url]')?.textContent).toBe('loja.exemplo/entrar')
    // No input path: no socket, no focus stop, no handler surface, no text field.
    expect(FakeWs.all.length).toBe(0)
    expect(q('[data-browser-input]')).toBeNull()
    expect(host.querySelectorAll('[data-browser-screen] [tabindex], [data-browser-screen] input, [data-browser-screen] textarea').length).toBe(0)
    pointer(q('[data-browser-screen] [role="img"]')!, 'pointerdown', 300, 200)
    expect(FakeWs.all.length).toBe(0)
    expect(q('[data-browser-card]')?.dataset.lock).toBe('locked')
    expect(host.textContent).toContain('O modelo continua aqui embaixo enquanto navega.')
  })

  test('there is no Flutuar until S11 hands the card somewhere to float to', () => {
    render(); feed('locked')
    expect(host.textContent).not.toContain('Flutuar')
  })
})

describe('unlocked (a1-unlocked)', () => {
  test('the input socket opens for this session and a click reaches the page, normalized', () => {
    render(); feed('unlocked')
    expect(FakeWs.all.length).toBe(1)
    const ws = FakeWs.all[0]!
    expect(ws.url).toBe(`ws://${window.location.host}/api/browser/input?owner=m1`)
    act(() => ws.open())
    stubRect()
    const target = q('[data-browser-input]')!
    expect(target.getAttribute('tabindex')).toBe('0')
    act(() => { pointer(target, 'pointerdown', 420, 250); pointer(target, 'pointerup', 420, 250) })
    expect(ws.sent).toEqual([
      { op: 'pointer', type: 'down', x: 0.5, y: 0.5, button: 'left', clicks: 1, mods: 0, seq: 1 },
      { op: 'pointer', type: 'up', x: 0.5, y: 0.5, button: 'left', clicks: 1, mods: 0, seq: 2 },
    ])
  })

  test('keys go as key events, typed characters carry their text', () => {
    render(); feed('unlocked')
    const ws = FakeWs.all[0]!
    act(() => ws.open())
    const target = q('[data-browser-input]')!
    act(() => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }) as unknown as Event) })
    expect(ws.sent).toEqual([{ op: 'key', type: 'down', key: 'a', code: 'KeyA', text: 'a', mods: 0, seq: 1 }])
  })

  test('the pill, the caption and the orange frame say it is yours; no ring, no "continues below"', () => {
    render(); feed('unlocked')
    expect(q('[data-browser-pill]')?.textContent).toBe('Você está usando · o modelo espera')
    expect(q('[data-browser-caption]')?.textContent).toBe('Sua vez. Trave o cadeado para devolver ao modelo.')
    expect(q('[data-browser-ring]')).toBeNull()
    expect(q('[data-browser-card]')!.style.boxShadow).toContain('var(--anthropic-orange)')
    expect(host.textContent).not.toContain('continua aqui embaixo')
  })

  test('locking again closes the socket: nothing more can be sent', () => {
    render(); feed('unlocked')
    const ws = FakeWs.all[0]!
    feed('locked')
    expect(ws.closed).toBe(true)
    expect(q('[data-browser-input]')).toBeNull()
  })
})

describe('the padlock button', () => {
  test('locked → asks to UNLOCK this session\'s browser', async () => {
    const calls: Array<[string, string]> = []
    render({ setLock: async (id, l) => { calls.push([id, l]); return { ok: true, lock: 'unlocked' } } }); feed('locked')
    await act(async () => { (q('button[aria-pressed="false"]') as HTMLButtonElement).click() })
    expect(calls).toEqual([['m1', 'unlocked']])
    expect(q('[data-browser-card]')?.dataset.lock).toBe('unlocked')
  })

  test('owner_proof_unavailable: the sentence in pt and the Open-the-Vault action', async () => {
    let opened = 0
    render({
      onOpenVault: () => { opened++ },
      setLock: async () => ({ ok: false, code: 'owner_proof_unavailable', sentence: 'Abra o Cofre e crie uma senha.', openVault: true }),
    }); feed('locked')
    await act(async () => { (q('button[aria-pressed="false"]') as HTMLButtonElement).click() })
    expect(q('[data-browser-refusal]')?.textContent).toContain('Abra o Cofre e crie uma senha.')
    expect(q('[data-browser-card]')?.dataset.lock).toBe('locked')
    expect(FakeWs.all.length).toBe(0)
    const btn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Abrir o Cofre') as HTMLButtonElement
    act(() => btn.click())
    expect(opened).toBe(1)
  })
})

describe('full screen (a1-max)', () => {
  test('focused unlocked page cannot swallow Escape or receive either Escape event in max', () => {
    let exits = 0
    render({ maximized: true, onToggleMax: () => { exits++ } }); feed('unlocked')
    const ws = FakeWs.all[0]!
    act(() => ws.open())
    const target = q('[data-browser-input]')!
    target.focus()
    act(() => {
      for (const type of ['keydown', 'keyup']) target.dispatchEvent(new window.KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }) as unknown as Event)
    })
    expect(exits).toBe(1)
    expect(ws.sent).toEqual([])
  })

  test('SessionBrowser mounts exactly one screen when maximized (QA M4)', async () => {
    const { SessionBrowserBlock, SessionBrowserOverlay } = await import('./SessionBrowser')
    for (const maximized of [false, true, false]) {
      const props = { managedId: 'm1', lang: 'pt' as const, openStream, onOpenVault: () => {}, model: { anchor: 0, live: true, maximized, setMaximized: () => {} } }
      act(() => root.render(createElement('div', {}, createElement(SessionBrowserBlock, props), createElement(SessionBrowserOverlay, props))))
      expect(host.querySelectorAll('[data-browser-screen]').length).toBe(1)
      expect(host.querySelectorAll('[data-browser-card]').length).toBe(1)
      expect(host.querySelectorAll('[data-browser-max] [data-browser-screen]').length).toBe(maximized ? 1 : 0)
    }
  })
  test('the button toggles, and says which way', () => {
    let n = 0
    render({ onToggleMax: () => { n++ } }); feed('locked')
    const max = q('button[aria-label="Tela cheia"]') as HTMLButtonElement
    act(() => max.click())
    expect(n).toBe(1)
    render({ maximized: true, onToggleMax: () => { n++ } })
    expect(q('button[aria-label="Sair da tela cheia"]')).not.toBeNull()
    expect(q('[data-browser-card]')!.style.height).toBe('100%')
    expect(host.textContent).not.toContain('continua aqui embaixo')
  })

  test('Esc leaves full screen, and only while maximized', () => {
    let n = 0
    render({ onToggleMax: () => { n++ } })
    act(() => { q('[data-browser-card]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event) })
    expect(n).toBe(0)
    render({ maximized: true, onToggleMax: () => { n++ } })
    act(() => { q('[data-browser-card]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event) })
    expect(n).toBe(1)
  })
})

describe('tabs reuse the session tab strip', () => {
  const two = { tabs: [{ id: 'T1', title: 'Loja exemplo', active: true }, { id: 'T2', title: 'Busca', active: false }] }

  test('one tab: no strip (the prototype\'s A1); two: a strip, and picking one changes what is watched', () => {
    render(); feed('locked')
    expect(q('[data-browser-tabs]')).toBeNull()
    feed('locked', two)
    expect(host.querySelectorAll('[data-browser-tab]').length).toBe(2)
    expect(host.querySelectorAll('[data-browser-tabs] button[aria-haspopup="menu"]').length).toBe(0)
    act(() => (q('[data-browser-tab="T2"]') as HTMLElement).click())
    expect(stream().url).toBe('/api/browser/stream?owner=m1&tab=T2')
    // the model's tabs are the model's: no × on them
    expect(host.querySelectorAll('[data-browser-tab] [data-tab-close]').length).toBe(0)
  })

  test('identical markup: the browser\'s active/idle tab, tablist and list button wear the session tabs\' exact styles', () => {
    const mk = (id: string) => ({ id, title: `T ${id}`, harness: 'claude', cwd: '/x', project: 'x', state: 'idle', stateLabel: 'x', actionable: true, attachCommand: '', verbs: [] }) as unknown as ControlSession
    const rows = [mk('a'), mk('b')]
    store.resetOpenTabsCache()
    act(() => { store.setOpenTabs('main', ['a', 'b']) })
    act(() => { root.render(createElement(SessionTabStrip, { lang: 'pt', rows, fleetReady: true, active: rows[0]!, onReopen: async () => ({ ok: true, message: '' }), onGo: () => {}, onNone: () => {} })) })
    const sActive = (q('[data-session-tab="a"]') as HTMLElement).style.cssText
    const sIdle = (q('[data-session-tab="b"]') as HTMLElement).style.cssText
    const sList = (q('[data-session-tabs] button[aria-haspopup="menu"]') as HTMLElement).style.cssText
    const sTrack = (q('[data-session-tabs] [role="tablist"]') as HTMLElement).style.cssText
    act(() => {
      root.render(createElement(TabStripView, {
        items: [{ key: 'T1', title: 'Loja', tooltip: '', leading: null, closable: false }, { key: 'T2', title: 'Busca', tooltip: '', leading: null, closable: false }],
        activeKey: 'T1', pt: true, stripAttr: 'data-browser-tabs', tabAttr: 'data-browser-tab', tablistLabel: 'x',
        list: { label: 'x', count: 2, expanded: false, onToggle: () => {} }, onPick: () => {},
      }))
    })
    expect((q('[data-browser-tab="T1"]') as HTMLElement).style.cssText).toBe(sActive)
    expect((q('[data-browser-tab="T2"]') as HTMLElement).style.cssText).toBe(sIdle)
    expect((q('[data-browser-tabs] button[aria-haspopup="menu"]') as HTMLElement).style.cssText).toBe(sList)
    expect((q('[data-browser-tabs] [role="tablist"]') as HTMLElement).style.cssText).toBe(sTrack)
    expect(sActive).toContain('border-radius: 10px 10px 0px 0px')
    expect(sActive).toContain('background: var(--bg-card)')
    expect(sActive).not.toContain('orange')
  })
})
