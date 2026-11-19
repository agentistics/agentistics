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
  grant: string | undefined
  readyState = 1
  onopen = null
  onmessage = null
  onerror: ((e: Event) => void) | null = null
  closed = false
  listeners = new Map<string, Set<Listener>>()
  constructor(url: string, grant?: string) { this.url = url; this.grant = grant; FakeStream.all.push(this) }
  addEventListener(t: string, fn: Listener) { (this.listeners.get(t) ?? this.listeners.set(t, new Set()).get(t)!).add(fn) }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn) }
  close() { this.closed = true }
  emit(t: string, data: unknown) { for (const fn of this.listeners.get(t) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent) }
}
class FakeWs {
  static all: FakeWs[] = []
  url: string
  protocols: string | string[] | undefined
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string, protocols?: string | string[]) { this.url = url; this.protocols = protocols; FakeWs.all.push(this) }
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
}
const openStream = (url: string, grant?: string) => new FakeStream(url, grant)

let createRoot: typeof import('react-dom/client').createRoot
let Panel: typeof import('./BrowserPanel').BrowserPanel
let Drawer: typeof import('./BrowserDrawer').BrowserDrawer
let drawerStore: typeof import('../../lib/browserDrawer')
let grantStore: typeof import('../../lib/personalGrant')
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
  grantStore = await import('../../lib/personalGrant')
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
  // S10 r3: the panel is the person's only with the owner's proof — most tests are about the person who HAS it.
  grantStore.setPersonalGrant('grant-aaaaaaaaaaaaaaaaaaaaaaaa', Date.now() + 3_600_000)
  ;(globalThis as { fetch?: unknown }).fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); drawerStore.setBrowserDrawerOpen(false); grantStore.clearPersonalGrant() })

const JPEG = '/9j/4AAQSkZJRg=='
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null
const post = (answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }) => async (u: string, b: unknown) => { posts.push([u, b]); return answer }
const render = (o: { live: boolean; post?: ReturnType<typeof post>; hideCloseButton?: boolean; onClose?: () => void; tabsOverride?: { tabs: Array<{ id: string; active: boolean }>; asOf: number } }) => act(() => {
  root.render(createElement(Panel, { lang: 'pt', onClose: o.onClose ?? (() => {}), openStream, liveOverride: o.live, post: o.post ?? post(), ...(o.hideCloseButton ? { hideCloseButton: true } : {}), ...(o.tabsOverride ? { tabsOverride: o.tabsOverride } : {}) }))
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
    expect(stream().grant).toBe('grant-aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(stream().url).not.toContain('grant')
    expect((q('[data-browser-url-input]') as HTMLInputElement).value).toBe('exemplo.com/docs/comecar')
    expect(q('[data-browser-screen] img')?.getAttribute('src')).toBe(`data:image/jpeg;base64,${JPEG}`)
    expect(q('[data-browser-pill]')).toBeNull()
    expect(host.querySelector('[aria-label*="adeado"], [aria-label*="adlock"]')).toBeNull()
  })

  test('the person\'s own input reaches the page from the first frame (no padlock to open)', () => {
    render({ live: true }); feed()
    expect(FakeWs.all.length).toBe(1)
    expect(FakeWs.all[0]!.url).toBe(`ws://${window.location.host}/api/browser/input?owner=personal`)
    // the grant rides the sub-protocol, never the URL
    expect(FakeWs.all[0]!.protocols).toEqual(['agentop-personal', 'grant-aaaaaaaaaaaaaaaaaaaaaaaa'])
    expect(FakeWs.all[0]!.url).not.toContain('grant')
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

const tabEls = () => Array.from(host.querySelectorAll('[data-browser-tab]')) as HTMLElement[]
const state2 = (id: string, url: string, title: string, tabs = state().tabs) => state({ tab: id, activeTab: id, url, title, tabs: tabs.map(t => ({ ...t, active: t.id === id })) })
const feedFor = (id: string, url: string, title: string) => act(() => { stream().emit('state', state2(id, url, title)); stream().emit('frame', { ...frame, tab: id, seq: 2, url, title }) })

describe('F1 — switching tab switches the screen AND the address (S10 QA)', () => {
  test('a picked tab STAYS chosen: the stream and the input socket re-open on that tab, the old stream closes', async () => {
    render({ live: true }); feed()
    const first = stream()
    await act(async () => { tabEls()[1]!.click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/tab_select', { tab: 'T2' }])
    expect(first.closed).toBe(true)
    expect(stream().url).toBe('/api/browser/stream?owner=personal&tab=T2')
    expect(FakeWs.all.at(-1)!.url).toBe(`ws://${window.location.host}/api/browser/input?owner=personal&tab=T2`)
    feedFor('T2', 'https://exemplo.com/loja', 'Loja exemplo')
    expect((q('[data-browser-url-input]') as HTMLInputElement).value).toBe('exemplo.com/loja')
    expect(host.querySelector('[data-browser-screen] img')?.getAttribute('src')).toBe(`data:image/jpeg;base64,${JPEG}`)
  })

  test('the list button picks a tab the same way', async () => {
    render({ live: true }); feed()
    await act(async () => { (q('[data-browser-tabs] button[aria-label="Abas do navegador"]') as HTMLButtonElement).click() })
    await act(async () => { (Array.from(host.querySelectorAll('[data-browser-tab-list] [role="menuitem"]'))[2] as HTMLElement).click() })
    expect(stream().url).toBe('/api/browser/stream?owner=personal&tab=T3')
  })

  test('navigating, back and reload then act on the CHOSEN tab', async () => {
    render({ live: true }); feed()
    await act(async () => { tabEls()[1]!.click() })
    feedFor('T2', 'https://exemplo.com/loja', 'Loja exemplo')
    const [back] = Array.from(host.querySelectorAll('[data-browser-address] button')) as HTMLButtonElement[]
    await act(async () => { back!.click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/back', { tab: 'T2' }])
  })

  test('F1-r2a: "+" pins the tab tab_new ANSWERED, so the stream, the socket and the address open on it (also when a tab was pinned)', async () => {
    render({ live: true, post: post({ status: 200, body: { ok: true, tab: 'T9', url: 'about:blank' } }) }); feed()
    await act(async () => { (q('[data-browser-tabs] button[aria-label="Nova aba"]') as HTMLButtonElement).click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/tab_new', {}])
    expect(stream().url).toBe('/api/browser/stream?owner=personal&tab=T9')
    expect(FakeWs.all.at(-1)!.url).toBe(`ws://${window.location.host}/api/browser/input?owner=personal&tab=T9`)
    // …and with an OLD tab pinned first
    await act(async () => { tabEls()[0]!.click() })
    expect(stream().url).toContain('tab=')
    await act(async () => { (q('[data-browser-tabs] button[aria-label="Nova aba"]') as HTMLButtonElement).click() })
    expect(stream().url).toBe('/api/browser/stream?owner=personal&tab=T9')
    feedFor('T9', 'about:blank', '')
    expect((q('[data-browser-url-input]') as HTMLInputElement).value).toBe('about:blank')
  })

  test('F1-r2b: a pinned tab closed by someone else (the stream says gone: tab_closed) lets go and RE-SUBSCRIBES on the survivor', async () => {
    render({ live: true }); feed()
    await act(async () => { tabEls()[1]!.click() })
    const dead = stream()
    expect(dead.url).toContain('tab=T2')
    act(() => { dead.emit('gone', { reason: 'tab_closed' }) })
    expect(dead.closed).toBe(true)
    expect(stream().url).toBe('/api/browser/stream?owner=personal')
    expect(FakeStream.all.filter(x => !x.closed).length).toBe(1)
  })

  test('F1-r2b: …and when the stream is silent, the status poll says the pinned tab is gone (only a poll that started AFTER the pin counts)', async () => {
    render({ live: true, tabsOverride: { tabs: [{ id: 'T1', active: true }, { id: 'T3', active: false }], asOf: Date.now() - 60_000 } }); feed()
    await act(async () => { tabEls()[1]!.click() })
    expect(stream().url).toContain('tab=T2') // an old poll that never heard of T2 must not undo a fresh pin
    act(() => { root.render(createElement(Panel, { lang: 'pt', onClose: () => {}, openStream, liveOverride: true, post: post(), tabsOverride: { tabs: [{ id: 'T1', active: true }, { id: 'T3', active: false }], asOf: Date.now() + 1000 } })) })
    expect(stream().url).toBe('/api/browser/stream?owner=personal')
  })

  test('F1-r2b: also when the panel FOLLOWS the active tab (nothing pinned): its resolved tab missing from a fresh poll re-subscribes', async () => {
    render({ live: true, tabsOverride: { tabs: [{ id: 'T1', active: true }, { id: 'T2', active: false }], asOf: Date.now() - 60_000 } }); feed()
    const first = stream()
    expect(first.url).toBe('/api/browser/stream?owner=personal')
    act(() => { root.render(createElement(Panel, { lang: 'pt', onClose: () => {}, openStream, liveOverride: true, post: post(), tabsOverride: { tabs: [{ id: 'T2', active: true }, { id: 'T3', active: false }], asOf: Date.now() + 1000 } })) })
    expect(first.closed).toBe(true)
    expect(FakeStream.all.filter(x => !x.closed).length).toBe(1)
  })

  test('closing the tab on screen: the close goes FIRST, the stream re-subscribes only after it (else it would pick the tab being closed)', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const slow = async (u: string, b: unknown) => { posts.push([u, b]); if (u.endsWith('tab_close')) await gate; return { status: 200, body: { ok: true } } }
    render({ live: true, post: slow }); feed()
    const before = stream()
    const x = tabEls()[0]!.querySelector('[data-tab-close]') as HTMLElement
    await act(async () => { x.click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/tab_close', { tab: 'T1' }])
    expect(before.closed).toBe(false) // the close has not finished: the stream is untouched
    await act(async () => { release(); await gate })
    expect(before.closed).toBe(true)
    expect(FakeStream.all.filter(s => !s.closed).length).toBe(1)
  })

  test('a chosen tab that is still listed stays chosen', async () => {
    render({ live: true, tabsOverride: { tabs: [{ id: 'T1', active: true }, { id: 'T2', active: false }], asOf: Date.now() + 1000 } }); feed()
    await act(async () => { tabEls()[1]!.click() })
    expect(stream().url).toContain('tab=T2')
  })

  test('closing the chosen tab frees the choice', async () => {
    render({ live: true }); feed()
    await act(async () => { tabEls()[1]!.click() })
    const x = tabEls()[1]!.querySelector('[data-tab-close]') as HTMLElement
    await act(async () => { x.click() })
    expect(posts.at(-1)).toEqual(['/api/browser/personal/tab_close', { tab: 'T2' }])
    expect(stream().url).toBe('/api/browser/stream?owner=personal')
  })
})

describe('F6 — after a link the address shows the URL, never the page title', () => {
  test('the address follows the page\'s url while the tab keeps the title', () => {
    render({ live: true }); feed()
    feedFor('T1', 'https://exemplo.com/loja', 'Loja exemplo')
    const input = q('[data-browser-url-input]') as HTMLInputElement
    expect(input.value).toBe('exemplo.com/loja')
    expect(input.value).not.toContain('Loja exemplo')
  })
})

describe('F3 — the phone\'s close button is a 44px target', () => {
  test('on a phone the header close is 44×44; on a desktop it stays the compact 26×22', () => {
    render({ live: false })
    const desk = host.querySelector('button[aria-label="Fechar o navegador"]') as HTMLElement
    expect([desk.style.width, desk.style.height]).toEqual(['26px', '22px'])
    act(() => root.unmount()); root = createRoot(host)
    const w = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    try {
      render({ live: false })
      const phone = host.querySelector('button[aria-label="Fechar o navegador"]') as HTMLElement
      expect([phone.style.width, phone.style.height]).toEqual(['44px', '44px'])
    } finally { Object.defineProperty(window, 'innerWidth', { value: w, configurable: true }) }
  })
})

describe('r3 — the owner\'s proof', () => {
  const ask = (answer: Awaited<ReturnType<NonNullable<Parameters<typeof grantStore.requestPersonalGrant>[0]>>>) => async () => answer
  test('no grant: a clear "Desbloquear com o Cofre" state — no address bar, no tabs, no stream, no socket, no status poll, no dead control', () => {
    grantStore.clearPersonalGrant()
    render({ live: true })
    expect(q('[data-browser-locked]')?.textContent).toContain('Cofre')
    expect((q('[data-browser-unlock]') as HTMLButtonElement).textContent).toContain('Desbloquear com o Cofre')
    expect(q('[data-browser-address]')).toBeNull()
    expect(q('[data-browser-tabs]')).toBeNull()
    expect(q('[data-browser-empty]')).toBeNull()
    expect(FakeStream.all.length).toBe(0)
    expect(FakeWs.all.length).toBe(0)
  })
  test('the unlock button asks the vault; with the proof the panel opens at once', async () => {
    grantStore.clearPersonalGrant()
    let asked = 0
    const askGrant = async () => { asked++; return { ok: true as const, personalGrant: 'granted-bbbbbbbbbbbbbbbbbbbbbb', expiresAt: Date.now() + 60_000 } }
    act(() => { root.render(createElement(Panel, { lang: 'pt', onClose: () => {}, openStream, liveOverride: true, post: post(), askGrant })) })
    await act(async () => { (q('[data-browser-unlock]') as HTMLButtonElement).click() })
    expect(asked).toBe(1)
    expect(q('[data-browser-locked]')).toBeNull()
    expect(q('[data-browser-address]')).not.toBeNull()
    act(() => { stream().emit('state', state()); stream().emit('frame', frame) })
    expect(stream().grant).toBe('granted-bbbbbbbbbbbbbbbbbbbbbb')
  })
  test('a vault that cannot ask a person says so in words and offers the Vault', async () => {
    grantStore.clearPersonalGrant()
    let opened = 0
    const askGrant = ask({ ok: false, code: 'owner-proof-unavailable', sentence: 'x' })
    act(() => { root.render(createElement(Panel, { lang: 'pt', onClose: () => {}, openStream, liveOverride: true, post: post(), askGrant, onOpenVault: () => { opened++ } })) })
    await act(async () => { (q('[data-browser-unlock]') as HTMLButtonElement).click() })
    expect(q('[data-browser-locked] [role="alert"]')?.textContent).toContain('Abrir o Cofre')
    await act(async () => { (q('[data-browser-open-vault]') as HTMLButtonElement).click() })
    expect(opened).toBe(1)
    expect(q('[data-browser-locked]')).not.toBeNull()
  })
  test('a cancelled gesture leaves the panel locked, with no Vault button', async () => {
    grantStore.clearPersonalGrant()
    const askGrant = ask({ ok: false, code: 'presence-cancelled', sentence: '' })
    act(() => { root.render(createElement(Panel, { lang: 'pt', onClose: () => {}, openStream, liveOverride: true, post: post(), askGrant })) })
    await act(async () => { (q('[data-browser-unlock]') as HTMLButtonElement).click() })
    expect(q('[data-browser-locked] [role="alert"]')).not.toBeNull()
    expect(q('[data-browser-open-vault]')).toBeNull()
  })
  test('the status poll sends the grant in a header, and `personalAccess: false` (a restart) clears it', async () => {
    const seen: Array<Record<string, string>> = []
    ;(globalThis as { fetch?: unknown }).fetch = async (_u: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers ?? {})
      return new Response(JSON.stringify({ live: [], personalAccess: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    act(() => { root.render(createElement(Panel, { lang: 'pt', onClose: () => {}, openStream, post: post() })) })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(seen[0]).toEqual({ 'X-Agentop-Personal-Grant': 'grant-aaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(grantStore.getPersonalGrant()).toBeNull()
    expect(q('[data-browser-locked]')).not.toBeNull()
  })
  test('a verb the server refuses for want of the grant sends the panel back to the unlock state (a restart forgets every grant)', async () => {
    render({ live: false, post: post({ status: 403, body: { ok: false, error: 'personal_proof_required', sentence: 'x' } }) })
    type(q('[data-browser-url-input]') as HTMLInputElement, 'exemplo.com')
    await act(async () => { submit() })
    expect(grantStore.getPersonalGrant()).toBeNull()
    expect(q('[data-browser-locked]')).not.toBeNull()
  })
})

describe('F8 — a long tab title ends in an ellipsis on ONE line on the phone', () => {
  test('on a phone the tab title is nowrap + ellipsis; on a desktop the strip is unchanged', () => {
    render({ live: true }); feed()
    const title = () => tabEls()[0]!.querySelector('span:not([data-tab-close])') as HTMLElement
    const spans = Array.from(tabEls()[0]!.querySelectorAll('span')) as HTMLElement[]
    expect(spans.some(sp => sp.style.textOverflow === 'ellipsis')).toBe(false)
    act(() => root.unmount()); root = createRoot(host)
    const w = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    try {
      render({ live: true }); feed()
      const t = (Array.from(tabEls()[0]!.querySelectorAll('span')) as HTMLElement[]).find(sp => sp.textContent === 'Documentação')!
      expect([t.style.whiteSpace, t.style.textOverflow, t.style.overflow]).toEqual(['nowrap', 'ellipsis', 'hidden'])
      void title
    } finally { Object.defineProperty(window, 'innerWidth', { value: w, configurable: true }) }
  })
})

describe('F5 — the server\'s refusal reads in the interface language', () => {
  test('a blocked file: address says it in Portuguese in the pt panel', async () => {
    render({ live: false, post: post({ status: 200, body: { ok: false, error: 'blocked', reason: 'scheme', sentence: 'Refused: file:///etc/passwd points at that kind of address (file:, chrome:, devtools:… are never loaded).' } }) })
    type(q('[data-browser-url-input]') as HTMLInputElement, 'file:///etc/passwd')
    await act(async () => { submit() })
    const t = q('[data-browser-refusal]')?.textContent ?? ''
    expect(t).toContain('Recusado')
    expect(t).not.toContain('Refused')
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
