/**
 * The floating browsers in a real DOM (happy-dom), NAVEGADOR S11: the A1 and B1 windows (button order of the
 * prototype's `a1-floating` / `b1-floating`), the window surviving navigation with frames still arriving, the
 * minimized chip, "Voltar" back to the conversation / the sidebar, and the one-place rule (a floating browser's
 * card or panel is a placeholder, never a second stream).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, type ReactNode } from 'react'
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
  closed = false
  constructor(url: string) { this.url = url; FakeWs.all.push(this) }
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close() { this.closed = true; this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
}
const openStream = (url: string) => new FakeStream(url)

let createRoot: typeof import('react-dom/client').createRoot
let RR: typeof import('react-router-dom')
let W: typeof import('./BrowserWindows')
let FC: typeof import('./BrowserFollowChip')
let chipRows: Parameters<typeof import('./BrowserFollowChip').BrowserFollowChip>[0]['rows'] = []
let SB: typeof import('./SessionBrowser')
let BP: typeof import('./BrowserPanel')
let store: typeof import('../../lib/browserWindows')
let slots: typeof import('../../lib/panelSlots')
let grant: typeof import('../../lib/personalGrant')
let originalWs: typeof globalThis.WebSocket
let originalFetch: typeof globalThis.fetch
let originalResize: typeof ResizeObserver
let originalAct: boolean | undefined

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
  RR = await import('react-router-dom')
  W = await import('./BrowserWindows')
  FC = await import('./BrowserFollowChip')
  SB = await import('./SessionBrowser')
  BP = await import('./BrowserPanel')
  store = await import('../../lib/browserWindows')
  slots = await import('../../lib/panelSlots')
  grant = await import('../../lib/personalGrant')
})
afterAll(async () => {
  await new Promise(r => setTimeout(r, 50))
  store.resetBrowserWindows()
  globalThis.WebSocket = originalWs
  globalThis.fetch = originalFetch
  globalThis.ResizeObserver = originalResize
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
let path = '/'
beforeEach(() => {
  FakeStream.all = []; FakeWs.all = []
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  store.resetBrowserWindows()
  slots.resetPanelSlots()
  grant.clearPersonalGrant()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const q = (sel: string) => host.querySelector(sel) as HTMLElement | null
const qa = (sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[]
const JPEG = '/9j/4AAQSkZJRg=='
const state = (lock: 'locked' | 'unlocked') => ({
  tab: 'T1', activeTab: 'T1', lock, url: 'https://loja.exemplo/entrar', title: 'Loja exemplo', loading: false,
  tabs: [{ id: 'T1', title: 'Loja exemplo', active: true }], lastAction: { kind: 'click', label: 'Entrar', x: 742, y: 400, at: 1 },
})
const frame = (seq: number) => ({ tab: 'T1', seq, w: 1280, h: 800, jpeg: JPEG, url: 'https://loja.exemplo/entrar', title: 'Loja exemplo', at: seq })
const live = () => FakeStream.all.filter(s => !s.closed)
const click = (el: Element | null) => act(() => { (el as HTMLElement).click() })

/** The app shell: three pages and the root-level windows, plus a probe of where the router is. */
function Shell({ children }: { children?: ReactNode }) {
  const loc = RR.useLocation()
  path = loc.pathname
  const nav = RR.useNavigate()
  return createElement('div', null,
    createElement('nav', null,
      createElement('button', { 'data-go': '/sessions', onClick: () => nav('/sessions') }),
      createElement('button', { 'data-go': '/tasks', onClick: () => nav('/tasks') }),
      createElement('button', { 'data-go': '/usage', onClick: () => nav('/usage') })),
    createElement(RR.Routes, null,
      createElement(RR.Route, { path: '/sessions/*', element: createElement('main', { 'data-page': 'sessions' }, children) }),
      createElement(RR.Route, { path: '/tasks', element: createElement('main', { 'data-page': 'tasks' }) }),
      createElement(RR.Route, { path: '/usage', element: createElement('main', { 'data-page': 'usage' }) })),
    createElement(FC.BrowserFollowChip, { lang: 'pt', rows: chipRows }),
    createElement(W.BrowserWindows, { lang: 'pt', openStream, personal: { liveOverride: true, openStream: (u: string) => new FakeStream(u) as never } }))
}
const render = (at = '/sessions', children?: ReactNode) => act(() => {
  root.render(createElement(RR.MemoryRouter, { initialEntries: [at] }, createElement(Shell, null, children)))
})
const floatA1 = () => act(() => { store.updateBrowserWindows((s, vp) => store.floatBrowser(s, 's:m1', vp, 'Testar login da loja')) })
const floatB1 = () => act(() => { store.updateBrowserWindows((s, vp) => store.floatBrowser(s, 'personal', vp)) })
/** The window header's controls, in order, by their accessible names. */
const headerButtons = () => qa('[role="complementary"] header button').map(b => b.getAttribute('aria-label') ?? b.textContent ?? '')

describe('A1 floating (a1-floating)', () => {
  test('the top-bar chip: title + live state word while it floats elsewhere; the state follows; click restores; own page and minimized draw none', () => {
    chipRows = [{ id: 'm1', title: 'Testar login da loja', state: 'working' }]
    render('/tasks')
    expect(q('[data-browser-follow-chip]')).toBeNull()
    floatA1()
    expect(q('[data-browser-follow-chip="m1"]')!.textContent).toBe('Testar login da loja · trabalhando')
    chipRows = [{ id: 'm1', title: 'Testar login da loja', state: 'waiting' }]
    render('/tasks')
    expect(q('[data-browser-follow-chip="m1"]')!.textContent).toBe('Testar login da loja · precisa de você')
    chipRows = [{ id: 'm1', title: 'Testar login da loja', state: 'exited' }]
    render('/tasks')
    expect(q('[data-browser-follow-chip="m1"]')!.textContent).toBe('Testar login da loja · encerrada')
    act(() => { store.updateBrowserWindows(s => store.minimizeBrowser(s, 's:m1')) })
    expect(q('[data-browser-follow-chip]')).toBeNull()
    click(q('[data-browser-chip="s:m1"] button'))
    act(() => { store.updateBrowserWindows(s => store.focusBrowser(s, 's:m1')) })
    expect(store.placeOf(store.getBrowserWindows(), 's:m1')).toBe('floating')
    click(q('[data-browser-follow-chip]'))
    expect(q('[data-browser-follow-chip="m1"]')).not.toBeNull()
    chipRows = []
  })

  test('the chip click restores a minimized-then-restored window to the front', () => {
    chipRows = [{ id: 'm1', title: 'T', state: 'working' }]
    render('/tasks')
    floatA1()
    act(() => { store.updateBrowserWindows((s, vp) => store.floatBrowser(s, 'personal', vp)) })
    const z = (id: string) => store.getBrowserWindows().windows.find(w => w.id === id)!.z
    expect(z('personal')).toBeGreaterThan(z('s:m1'))
    click(q('[data-browser-follow-chip]'))
    expect(z('s:m1')).toBeGreaterThan(z('personal'))
    chipRows = []
  })

  test('own page: no chip (the conversation strip says it there)', () => {
    chipRows = [{ id: 'm1', title: 'T', state: 'working' }]
    render('/sessions/m1')
    floatA1()
    expect(q('[data-browser-follow-chip]')).toBeNull()
    chipRows = []
  })

  test('opens at the prototype\'s x=400 at 1280 and the address back arrow has its own label', () => {
    render('/tasks')
    floatA1()
    expect(q('[data-browser-window="s:m1"]')!.getAttribute('data-geometry')!.split(',')[0]).toBe('400')
    expect(q('[data-browser-address] button[aria-label="Voltar"]')).toBeNull()
    expect(qa('[role="complementary"] header button').filter(b => b.getAttribute('aria-label') === 'Voltar')).toHaveLength(0)
  })

  test('the window: title, and the prototype\'s button order — padlock, full screen, Voltar para a conversa, minimize', () => {
    render('/tasks')
    floatA1()
    expect(q('[role="complementary"] header')!.textContent).toContain('Navegador · Testar login da loja')
    const b = headerButtons()
    expect(b).toHaveLength(4)
    expect(b[0]).toContain('Travado')
    expect(b[1]).toBe('Tela cheia')
    expect(b[2]).toBe('Voltar para a conversa')
    expect(b[3]).toBe('Minimizar')
    expect(q('[data-browser-address]')).not.toBeNull()
    expect(q('[data-browser-caption]')).not.toBeNull()
  })

  test('the window follows the person: Sessões → Tarefas → Uso, ONE stream, never reopened, frames still arriving', () => {
    render('/sessions')
    floatA1()
    expect(live()).toHaveLength(1)
    const s = live()[0]!
    expect(s.url).toContain('owner=m1')
    act(() => { s.emit('state', state('locked')); s.emit('frame', frame(1)) })
    for (const [i, to] of (['/tasks', '/usage'] as const).entries()) {
      click(q(`[data-go="${to}"]`))
      expect(q(`[data-page="${to.slice(1)}"]`)).not.toBeNull()
      expect(q('[data-browser-window="s:m1"]')).not.toBeNull()
      expect(FakeStream.all).toHaveLength(1) // no second stream, the first never closed
      expect(s.closed).toBe(false)
      act(() => { s.emit('frame', frame(i + 2)) })
      expect(q('[data-browser-window="s:m1"] img')).not.toBeNull()
    }
  })

  test('minimize → a chip and NO stream (nobody watches); restore → the window and the stream again', () => {
    render('/tasks')
    floatA1()
    click(qa('[role="complementary"] header button').find(b => b.getAttribute('aria-label') === 'Minimizar')!)
    expect(q('[role="complementary"]')).toBeNull()
    expect(q('[data-browser-chip="s:m1"]')!.textContent).toContain('Navegador · Testar login da loja')
    expect(live()).toHaveLength(0)
    click(q('[data-browser-chip="s:m1"] button'))
    expect(q('[data-browser-window="s:m1"]')).not.toBeNull()
    expect(live()).toHaveLength(1)
  })

  test('"Voltar para a conversa" docks it and opens the session', () => {
    render('/usage')
    floatA1()
    click(qa('[role="complementary"] header button').find(b => b.textContent === 'Voltar para a conversa')!)
    expect(store.placeOf(store.getBrowserWindows(), 's:m1')).toBe('docked')
    expect(path).toBe('/sessions/m1')
    expect(q('[role="complementary"]')).toBeNull()
  })

  test('the chip has its own Voltar', () => {
    render('/tasks')
    floatA1()
    act(() => { store.updateBrowserWindows(s => store.minimizeBrowser(s, 's:m1')) })
    click(q('[data-browser-chip="s:m1"] button[aria-label="Voltar o navegador para a conversa da sessão"]'))
    expect(store.getBrowserWindows().windows).toHaveLength(0)
    expect(path).toBe('/sessions/m1')
  })

  test('full screen covers the viewport; Esc leaves it', () => {
    render('/tasks')
    floatA1()
    click(qa('[role="complementary"] header button').find(b => b.getAttribute('aria-label') === 'Tela cheia')!)
    const frameEl = q('[role="complementary"]')!
    expect(q('[data-browser-window="s:m1"]')!.hasAttribute('data-full')).toBe(true)
    expect(frameEl.querySelector('[data-browser-window]')!.getAttribute('data-geometry')).toBe('0,0,1280,800')
    act(() => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event) })
    expect(q('[data-browser-window="s:m1"]')!.hasAttribute('data-full')).toBe(false)
  })

  test('back / forward / reload: disabled while locked; unlocked, they go through the padlocked input channel', () => {
    render('/tasks')
    floatA1()
    const s = live()[0]!
    act(() => { s.emit('state', state('locked')); s.emit('frame', frame(1)) })
    const back = () => q('[data-browser-address] button[aria-label="Página anterior"]') as HTMLButtonElement
    expect(back().disabled).toBe(true)
    act(() => { s.emit('state', state('unlocked')) })
    act(() => { FakeWs.all.at(-1)!.open() })
    expect(back().disabled).toBe(false)
    click(back())
    click(q('[data-browser-address] button[aria-label="Recarregar"]'))
    expect(FakeWs.all.at(-1)!.sent).toEqual([{ op: 'history', action: 'back', seq: 1 }, { op: 'history', action: 'reload', seq: 2 }])
    expect((q('[data-browser-url-input]') as HTMLInputElement).readOnly).toBe(true)
  })
})

describe('B1 floating (b1-floating)', () => {
  test('the prototype\'s button order — full screen, Voltar para a barra, minimize, close — and the vault lock still applies', () => {
    render('/tasks')
    floatB1()
    expect(q('[role="complementary"] header')!.textContent).toContain('Navegador')
    expect(headerButtons()).toEqual(['Tela cheia', 'Voltar para a barra', 'Minimizar', 'Fechar a janela'])
    // No grant: the person's browser stays locked behind the vault, exactly as in the rail (S10).
    expect(q('[data-browser-window="personal"] [data-browser-locked]')).not.toBeNull()
    expect(live()).toHaveLength(0)
  })

  test('with the owner\'s grant, the panel inside the window streams the personal browser', () => {
    act(() => { grant.setPersonalGrant('g', Date.now() + 60_000) })
    render('/tasks')
    floatB1()
    expect(q('[data-browser-window="personal"] [data-browser-locked]')).toBeNull()
    expect(live().some(s => s.url.includes('owner=personal'))).toBe(true)
  })

  test('"Voltar para a barra" docks it, goes back to the session page it floated from and opens the rail panel', () => {
    render('/usage')
    act(() => { store.updateBrowserWindows((s, vp) => store.floatBrowser(s, 'personal', vp, undefined, '/sessions/m9')) })
    click(qa('[role="complementary"] header button').find(b => b.textContent === 'Voltar para a barra')!)
    expect(store.getBrowserWindows().windows).toHaveLength(0)
    expect(path).toBe('/sessions/m9')
    expect(slots.getPanelLayout('main').right).toBe('browser')
  })

  test('"Voltar para a barra" with no remembered page goes to Sessões; on a session page it stays there', () => {
    render('/usage')
    floatB1()
    click(qa('[role="complementary"] header button').find(b => b.textContent === 'Voltar para a barra')!)
    expect(path).toBe('/sessions')
    act(() => { root.unmount() }); root = createRoot(host)
    render('/sessions/m2')
    act(() => { store.updateBrowserWindows((s, vp) => store.floatBrowser(s, 'personal', vp, undefined, '/sessions/m9')) })
    click(qa('[role="complementary"] header button').find(b => b.textContent === 'Voltar para a barra')!)
    expect(path).toBe('/sessions/m2')
  })

  test('close: the window goes, nothing is navigated, the rail is not reopened', () => {
    render('/tasks')
    floatB1()
    click(q('[role="complementary"] header button[aria-label="Fechar a janela"]'))
    expect(store.getBrowserWindows().windows).toHaveLength(0)
    expect(path).toBe('/tasks')
    expect(slots.getPanelLayout('main').right).not.toBe('browser')
  })
})

describe('390: almost full width, "Voltar" is its icon alone', () => {
  test('geometry 8 / 84 and the icon-only Voltar keeps its name', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    render('/tasks')
    floatA1()
    const f = q('[role="complementary"]')!
    expect(f.querySelector('[data-browser-window]')!.getAttribute('data-geometry')).toBe('8,84,374,380')
    const voltar = qa('[role="complementary"] header button').find(b => b.getAttribute('aria-label') === 'Voltar para a conversa')!
    expect(voltar.textContent).toBe('')
  })
})

describe('one place on screen', () => {
  const model = { anchor: 0, live: true, maximized: false, setMaximized: () => {} }

  test('A1 floating: the card is a strip with "Voltar para a conversa" — one stream in the whole app', () => {
    render('/sessions', createElement(SB.SessionBrowserBlock, { managedId: 'm1', lang: 'pt', model, onOpenVault: () => {}, openStream, title: 'Testar login da loja' }))
    expect(q('[data-browser-card="m1"]')).not.toBeNull()
    expect(live()).toHaveLength(1)
    click(qa('[data-browser-card="m1"] button').find(b => b.textContent === 'Flutuar')!)
    expect(q('[data-browser-card="m1"]')).toBeNull()
    expect(q('[data-browser-floating="floating"]')).not.toBeNull()
    expect(q('[data-browser-window="s:m1"]')).not.toBeNull()
    expect(live()).toHaveLength(1) // the card's stream closed, the window's opened
    expect(store.getBrowserWindows().windows[0]!.title).toBe('Testar login da loja')
    click(qa('[data-browser-floating] button').find(b => b.textContent === 'Voltar para a conversa')!)
    expect(q('[data-browser-window="s:m1"]')).toBeNull()
    expect(q('[data-browser-card="m1"]')).not.toBeNull()
    expect(live()).toHaveLength(1)
  })

  test('A1 minimized: still a strip (the chip owns it), never the card', () => {
    render('/sessions', createElement(SB.SessionBrowserBlock, { managedId: 'm1', lang: 'pt', model, onOpenVault: () => {}, openStream }))
    floatA1()
    act(() => { store.updateBrowserWindows(s => store.minimizeBrowser(s, 's:m1')) })
    expect(q('[data-browser-floating="minimized"]')).not.toBeNull()
    expect(q('[data-browser-card="m1"]')).toBeNull()
    expect(live()).toHaveLength(0)
  })

  test('A1 from full screen: Flutuar leaves full screen first', () => {
    let maximized = true
    const m = { ...model, maximized: true, setMaximized: (v: boolean) => { maximized = v } }
    render('/sessions', createElement(SB.SessionBrowserOverlay, { managedId: 'm1', lang: 'pt', model: m, onOpenVault: () => {}, openStream }))
    click(qa('[data-browser-max] button').find(b => b.textContent === 'Flutuar')!)
    expect(maximized).toBe(false)
    expect(q('[data-browser-max]')).toBeNull()
    expect(store.placeOf(store.getBrowserWindows(), 's:m1')).toBe('floating')
  })

  test('B1: the rail panel has Flutuar; floating makes it a placeholder with "Voltar para a barra"', () => {
    act(() => { grant.setPersonalGrant('g', Date.now() + 60_000) })
    let floated = 0
    render('/sessions', createElement(BP.BrowserPanel, { lang: 'pt', onClose: () => {}, liveOverride: true, openStream: (u: string) => new FakeStream(u) as never, onFloat: () => { floated++; store.updateBrowserWindows((s, vp) => store.floatBrowser(s, 'personal', vp)) } }))
    expect(live()).toHaveLength(1)
    click(q('[data-browser-float]'))
    expect(floated).toBe(1)
    expect(q('[data-browser-panel][data-browser-floating="floating"]')).not.toBeNull()
    expect(live()).toHaveLength(1) // the window's; the panel streams nothing
    click(qa('[data-browser-panel][data-browser-floating] button').find(b => b.textContent === 'Voltar para a barra')!)
    expect(q('[data-browser-panel][data-browser-floating]')).toBeNull()
    expect(q('[data-browser-window="personal"]')).toBeNull()
  })
})
