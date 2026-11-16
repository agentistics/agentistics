/**
 * The person's browser panel in a real DOM (happy-dom), NAVEGADOR S10: empty state, address bar → the existing
 * personal route, tabs through the session tabs' own `TabStripView`, input with no padlock, mobile drawer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

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
  constructor(url: string) { this.url = url; FakeWs.all.push(this) }
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
}
const openStream = (url: string) => new FakeStream(url)

let createRoot: typeof import('react-dom/client').createRoot
let Panel: typeof import('./BrowserPanel').BrowserPanel
let Drawer: typeof import('./BrowserDrawer').BrowserDrawer
let drawerStore: typeof import('../../lib/browserDrawer')
let originalWs: typeof globalThis.WebSocket
let originalFetch: typeof globalThis.fetch
let originalAct: boolean | undefined

beforeAll(async () => {
  originalWs = globalThis.WebSocket
  originalFetch = globalThis.fetch
  originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  Element.prototype.scrollIntoView = () => {}
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWs
  createRoot = (await import('react-dom/client')).createRoot
  Panel = (await import('./BrowserPanel')).BrowserPanel
  Drawer = (await import('./BrowserDrawer')).BrowserDrawer
  drawerStore = await import('../../lib/browserDrawer')
})
afterAll(async () => {
  await new Promise(r => setTimeout(r, 50))
  globalThis.WebSocket = originalWs
  globalThis.fetch = originalFetch
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
let posts: Array<[string, unknown]>
beforeEach(() => {
  FakeStream.all = []; FakeWs.all = []; posts = []
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); drawerStore.setBrowserDrawerOpen(false) })

const JPEG = '/9j/4AAQSkZJRg=='
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null
const post = (answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }) => async (u: string, b: unknown) => { posts.push([u, b]); return answer }
const render = (o: { live: boolean; post?: ReturnType<typeof post>; hideCloseButton?: boolean; onClose?: () => void }) => act(() => {
  root.render(createElement(Panel, { lang: 'pt', onClose: o.onClose ?? (() => {}), openStream, liveOverride: o.live, post: o.post ?? post(), ...(o.hideCloseButton ? { hideCloseButton: true } : {}) }))
})
const state = (extra: Record<string, unknown> = {}) => ({
  tab: 'T1', activeTab: 'T1', lock: 'none', url: 'https://exemplo.com/docs/comecar', title: 'Documentação', loading: false,
  tabs: [{ id: 'T1', title: 'Documentação', active: true }, { id: 'T2', title: 'Loja exemplo', active: false }, { id: 'T3', title: 'Busca', active: false }],
  lastAction: null, ...extra,
})
const frame = { tab: 'T1', seq: 1, w: 1280, h: 800, jpeg: JPEG, url: 'https://exemplo.com/docs/comecar', title: 'Documentação', at: 1 }
const stream = () => FakeStream.all.find(s => !s.closed)!
const feed = () => act(() => { stream().emit('state', state()); stream().emit('frame', frame) })
const type = (el: HTMLInputElement, v: string) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => { set.call(el, v); el.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event) })
}
const submit = () => act(() => { (q('[data-browser-address]') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event) })

describe('nothing open yet', () => {
  test('an honest empty state with a working address bar — no stream, no socket', () => {
    render({ live: false })
    expect(q('[data-browser-empty]')?.textContent).toContain('Abrir uma página')
    expect(q('[data-browser-address]')).not.toBeNull()
    expect(FakeStream.all.length).toBe(0)
    expect(FakeWs.all.length).toBe(0)
    expect(q('[data-browser-tabs]')).toBeNull()
  })

  test('back / forward / reload are disabled with no page, never silently inert', () => {
    render({ live: false })
    const btns = Array.from(host.querySelectorAll('[data-browser-address] button')) as HTMLButtonElement[]
    expect(btns.length).toBe(3)
    expect(btns.every(b => b.disabled)).toBe(true)
  })

  test('typing an address and pressing Enter goes through the personal navigate route', async () => {
    render({ live: false })
    type(q('[data-browser-url-input]') as HTMLInputElement, 'exemplo.com/docs')
    await act(async () => { submit() })
    expect(posts).toEqual([['/api/browser/personal/navigate', { url: 'https://exemplo.com/docs' }]])
  })

  test('text that is not an address says so and posts nothing', async () => {
    render({ live: false })
    type(q('[data-browser-url-input]') as HTMLInputElement, 'bolo de cenoura')
    await act(async () => { submit() })
    expect(posts).toEqual([])
    expect(q('[data-browser-refusal]')?.textContent).toContain('não parece um endereço')
  })

  test('a refusal from the server (blocked URL) is shown in its own words', async () => {
    render({ live: false, post: post({ status: 200, body: { ok: false, sentence: 'That address is blocked.' } }) })
    type(q('[data-browser-url-input]') as HTMLInputElement, 'file:///etc/passwd')
    await act(async () => { submit() })
    expect(q('[data-browser-refusal]')?.textContent).toBe('That address is blocked.')
  })

  test('"nova aba em branco" opens one through tab_new', async () => {
    render({ live: false })
    await act(async () => { (q('[data-browser-empty] button') as HTMLButtonElement).click() })
    expect(posts).toEqual([['/api/browser/personal/tab_new', {}]])
  })
})

describe('open (b1-open)', () => {
  test('watches the PERSONAL browser; the address and the page show; there is no padlock and no "só olhando" pill', () => {
    render({ live: true }); feed()
    expect(stream().url).toBe('/api/browser/stream?owner=personal')
    expect((q('[data-browser-url-input]') as HTMLInputElement).value).toBe('exemplo.com/docs/comecar')
    expect(q('[data-browser-screen] img')?.getAttribute('src')).toBe(`data:image/jpeg;base64,${JPEG}`)
    expect(q('[data-browser-pill]')).toBeNull()
    expect(host.querySelector('[aria-label*="adeado"], [aria-label*="adlock"]')).toBeNull()
  })

  test('the person\'s own input reaches the page from the first frame (no padlock to open)', () => {
    render({ live: true }); feed()
    expect(FakeWs.all.length).toBe(1)
    expect(FakeWs.all[0]!.url).toBe(`ws://${window.location.host}/api/browser/input?owner=personal`)
    expect(q('[data-browser-input]')).not.toBeNull()
  })

  test('the tabs are the session tabs\' own strip: list button with the count, the active one, a "+"', () => {
    render({ live: true }); feed()
    const strip = q('[data-browser-tabs]')!
    expect(strip).not.toBeNull()
    const tabs = Array.from(host.querySelectorAll('[data-browser-tab]'))
    expect(tabs.map(t => t.textContent)).toEqual(['Documentação', 'Loja exemplo', 'Busca'])
    expect(strip.querySelector('button[aria-label="Abas do navegador"]')?.textContent).toContain('3')
    expect(strip.querySelector('button[aria-label="Nova aba"]')).not.toBeNull()
  })

  test('picking a tab, closing one and "+" go through tab_select / tab_close / tab_new', async () => {
    render({ live: true }); feed()
    await act(async () => { (host.querySelectorAll('[data-browser-tab]')[1] as HTMLElement).click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/tab_select', { tab: 'T2' }])
    await act(async () => { (q('[data-browser-tabs] button[aria-label="Nova aba"]') as HTMLButtonElement).click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/tab_new', {}])
  })

  test('back / forward / reload act on the active tab; Enter on a new address navigates that tab', async () => {
    render({ live: true }); feed()
    const [back, fwd, reload] = Array.from(host.querySelectorAll('[data-browser-address] button')) as HTMLButtonElement[]
    await act(async () => { back!.click() })
    await act(async () => { fwd!.click() })
    await act(async () => { reload!.click() })
    expect(posts.map(p => p[0])).toEqual(['/api/browser/personal/back', '/api/browser/personal/forward', '/api/browser/personal/reload'])
    expect(posts.every(p => (p[1] as { tab: string }).tab === 'T1')).toBe(true)
    type(q('[data-browser-url-input]') as HTMLInputElement, 'localhost:5173')
    await act(async () => { submit() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/navigate', { url: 'http://localhost:5173', tab: 'T1' }])
  })

  test('the list button opens every tab and picks one', async () => {
    render({ live: true }); feed()
    await act(async () => { (q('[data-browser-tabs] button[aria-label="Abas do navegador"]') as HTMLButtonElement).click() })
    const rows = Array.from(host.querySelectorAll('[data-browser-tab-list] [role="menuitem"]')) as HTMLElement[]
    expect(rows.length).toBe(3)
    await act(async () => { rows[2]!.click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/tab_select', { tab: 'T3' }])
    expect(q('[data-browser-tab-list]')).toBeNull()
  })
})

describe('the panel header (b1-open)', () => {
  test('globe+search, "Navegador", no Flutuar until S11, own close only when the slot has no fixed controls', () => {
    render({ live: false })
    expect(host.querySelector('header')?.textContent).toContain('Navegador')
    expect(q('[data-globe-search]')).not.toBeNull()
    expect(host.textContent).not.toContain('Flutuar')
    expect(host.querySelector('button[aria-label="Fechar o navegador"]')).not.toBeNull()
    act(() => root.unmount()); root = createRoot(host)
    render({ live: false, hideCloseButton: true })
    expect(host.querySelector('button[aria-label="Fechar o navegador"]')).toBeNull()
  })

  test('the panel is NOT a session\'s browser: it never reads a session owner', () => {
    render({ live: true }); feed()
    expect(FakeStream.all.every(s => s.url.includes('owner=personal'))).toBe(true)
  })
})

describe('the phone drawer', () => {
  test('draws nothing while closed, full screen when opened, closes with the panel\'s own close', async () => {
    ;(globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({ live: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    const w = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    try {
      act(() => { root.render(createElement(Drawer, { lang: 'pt' })) })
      expect(q('[data-browser-drawer]')).toBeNull()
      act(() => drawerStore.setBrowserDrawerOpen(true))
      const d = q('[data-browser-drawer]')!
      expect(d).not.toBeNull()
      expect(d.style.position).toBe('fixed')
      expect(d.style.zIndex).toBe('660')
      expect(q('[data-browser-empty]')).not.toBeNull()
      await act(async () => { (host.querySelector('button[aria-label="Fechar o navegador"]') as HTMLButtonElement).click() })
      expect(q('[data-browser-drawer]')).toBeNull()
    } finally { Object.defineProperty(window, 'innerWidth', { value: w, configurable: true }) }
  })

  test('on a desktop width the drawer never draws (its browser is a rail panel)', () => {
    act(() => { root.render(createElement(Drawer, { lang: 'pt' })) })
    act(() => drawerStore.setBrowserDrawerOpen(true))
    expect(q('[data-browser-drawer]')).toBeNull()
  })
})
