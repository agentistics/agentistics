import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Root } from 'react-dom/client'
import { followOffset, restOffset } from '../../lib/bottomNavDrag'

let createRoot: typeof import('react-dom/client').createRoot
let MobileAreaBar: typeof import('./MobileAreaBar').MobileAreaBar
let host: HTMLDivElement, root: Root
let went: string[], scrolls: number
let reduced: MediaQueryList
let oldRect: typeof HTMLElement.prototype.getBoundingClientRect
let oldScroll: typeof window.scrollTo
let oldAct: boolean | undefined

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 844 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  oldRect = HTMLElement.prototype.getBoundingClientRect
  oldScroll = window.scrollTo
  HTMLElement.prototype.getBoundingClientRect = () => ({ left: 12, top: 700, width: 356, height: 56, right: 368, bottom: 756 }) as DOMRect
  createRoot = (await import('react-dom/client')).createRoot
  MobileAreaBar = (await import('./MobileAreaBar')).MobileAreaBar
})
beforeEach(() => {
  went = []; scrolls = 0
  reduced = Object.assign(new EventTarget(), { matches: false, media: '(prefers-reduced-motion: reduce)' }) as unknown as MediaQueryList
  window.matchMedia = (() => reduced) as typeof window.matchMedia
  window.scrollTo = (() => { scrolls++ }) as typeof window.scrollTo
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove(); sessionStorage.clear() })
afterAll(async () => {
  HTMLElement.prototype.getBoundingClientRect = oldRect
  window.scrollTo = oldScroll
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct
  await GlobalRegistrator.unregister()
})

async function render(pathname = '/sessions') {
  await act(async () => {
    root.render(<MemoryRouter><MobileAreaBar lang="pt" pathname={pathname} onNavigate={to => went.push(to)} actions={[]} badges={{ tasks: 3, usage: 1, sessions: 2 }} /></MemoryRouter>)
  })
  const nav = host.querySelector<HTMLElement>('nav[aria-label="Navegação principal"]')!
  const track = nav.firstElementChild as HTMLElement
  const buttons = Array.from(track.querySelectorAll('button'))
  return { track, buttons, indicator: () => track.querySelector<HTMLElement>('[aria-hidden="true"]')! }
}
const click = (el: HTMLElement) => act(async () => { el.click() })
const pointer = (el: HTMLElement, type: string, x: number) => act(async () => {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'touch', clientX: 12 + x }))
})

test('Home scrolls the session panes to top and an open conversation returns to the list', async () => {
  const panes = [document.createElement('div'), document.createElement('div')]
  panes[0]!.setAttribute('data-mobile-sessions-scroll', '')
  for (const pane of panes) { pane.scrollTop = 300; document.body.appendChild(pane) }
  try {
    let view = await render()
    expect(view.buttons[2]!.textContent).toContain('Início')
    await click(view.buttons[2]!)
    expect(panes[0]!.scrollTop).toBe(0)
    expect(panes[1]!.scrollTop).toBe(300)
    expect(scrolls).toBe(1)
    expect(went).toEqual([])
    view = await render('/sessions/abc')
    await click(view.buttons[2]!)
    expect(went).toEqual(['/sessions'])
  } finally { panes.forEach(el => el.remove()) }
})

test('drag follows the finger through five equal slots and activates only on release', async () => {
  const view = await render('/usage')
  await pointer(view.track, 'pointerdown', 20)
  await pointer(view.track, 'pointermove', 250)
  expect(view.indicator().style.transform).toContain(`translateX(${followOffset(250, 356, 5, 4)}px)`)
  expect(went).toEqual([])
  await pointer(view.track, 'pointerup', 250)
  expect(went).toEqual(['/'])
  // The click synthesized after releasing a drag must not activate a second destination.
  await click(view.buttons[0]!)
  expect(went).toEqual(['/'])
})

test('releasing over More opens the existing area sheet; cancelling a drag restores the indicator', async () => {
  const view = await render()
  await pointer(view.track, 'pointerdown', 20)
  await pointer(view.track, 'pointermove', 345)
  await pointer(view.track, 'pointercancel', 345)
  expect(went).toEqual([])
  expect(view.indicator().style.transform).toContain(`translateX(${restOffset(2, 356, 5, 4)}px)`)
  await pointer(view.track, 'pointerdown', 20)
  await pointer(view.track, 'pointermove', 345)
  await pointer(view.track, 'pointerup', 345)
  expect(host.querySelector('[role="dialog"][aria-label="Ir para"]')).not.toBeNull()
  expect(view.buttons[4]!.getAttribute('aria-expanded')).toBe('true')
  expect(went).toEqual([])
})

test('reduced motion follows the preference, disabling springs, lift and scale during drag', async () => {
  const view = await render()
  await act(async () => { (reduced as any).matches = true; reduced.dispatchEvent(new Event('change')) })
  await pointer(view.track, 'pointerdown', 20)
  await pointer(view.track, 'pointermove', 250)
  expect(view.indicator().style.transition).toBe('none')
  expect(view.indicator().style.transform).toContain('scale(1)')
  expect(view.buttons[3]!.firstElementChild!.getAttribute('style')).toContain('transform: none')
  await act(async () => { (reduced as any).matches = false; reduced.dispatchEvent(new Event('change')) })
  expect(view.indicator().style.transition).toContain('90ms')
})
