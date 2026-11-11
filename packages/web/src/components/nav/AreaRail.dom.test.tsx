import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, StrictMode, useState } from 'react'
import type { Root } from 'react-dom/client'
import { headerLeftMenus } from '../../lib/leftMenus'
import { areaOpenStore } from '../../lib/areaOpen'

let createRoot: typeof import('react-dom/client').createRoot
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let useLocation: typeof import('react-router-dom').useLocation
let AreaRail: typeof import('./AreaRail').AreaRail
let AreaTree: typeof import('./AreaTree').AreaTree
let root: Root | undefined
let host: HTMLDivElement
let oldAct: unknown
let originalFetch: typeof fetch
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView
let scrolled: Element[] = []
beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async () => Response.json({ surfaces: [] })) as unknown as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  useLocation = (await import('react-router-dom')).useLocation
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this) }
  AreaRail = (await import('./AreaRail')).AreaRail
  AreaTree = (await import('./AreaTree')).AreaTree
})
afterEach(async () => { await act(async () => { root?.unmount() }); root = undefined; host?.remove(); scrolled = []; areaOpenStore.set({}) })
afterAll(async () => { globalThis.fetch = originalFetch; HTMLElement.prototype.scrollIntoView = originalScrollIntoView; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

for (const lang of ['pt', 'en'] as const) test(`rail opens only by click, top toggle is first, headings never navigate (${lang})`, async () => {
  const visits: string[] = []
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<MemoryRouter><AreaRail lang={lang} pathname="/sessions" onNavigate={to => visits.push(to)} /></MemoryRouter>) })
  const rail = () => host.querySelector<HTMLElement>('[data-area-rail]')!
  const toggle = () => rail().querySelector<HTMLButtonElement>('button')!
  expect(toggle().getAttribute('aria-label')).toBe(lang === 'pt' ? 'Expandir' : 'Expand')
  await act(async () => { rail().dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' })) })
  expect(rail().dataset.open).toBe('false')
  await act(async () => { toggle().focus() })
  expect(rail().dataset.open).toBe('false')
  await act(async () => { toggle().click() })
  expect(toggle().textContent).toContain(lang === 'pt' ? 'Recolher' : 'Collapse')
  const heading = host.querySelector<HTMLButtonElement>('[data-area-heading="tasks"]')!
  const was = heading.getAttribute('aria-expanded')
  await act(async () => { heading.click() })
  expect(visits).toEqual([])
  expect(heading.getAttribute('aria-expanded')).not.toBe(was)
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-area-heading="vault"]')!.click() })
  expect(visits).toEqual(['/vault'])
})

test('phone tree headings only expand; child items remain the navigation targets', async () => {
  const visits: string[] = []
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<MemoryRouter><AreaTree variant="sheet" lang="en" pathname="/sessions" onNavigate={to => visits.push(to)} /></MemoryRouter>) })
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-area-heading="tasks"]')!.click() })
  expect(visits).toEqual([])
  await act(async () => { host.querySelector<HTMLAnchorElement>('a[href="/tasks/calendar"]')!.click() })
  expect(visits).toEqual(['/tasks/calendar'])
})

test('the header collapses the main area menu and sessions list together when both are open', () => {
  expect(headerLeftMenus(true, false)).toEqual({ areasOpen: false, sessionsCollapsed: true })
  expect(headerLeftMenus(false, false)).toEqual({ areasOpen: false, sessionsCollapsed: true })
  expect(headerLeftMenus(false, true)).toEqual({ areasOpen: false, sessionsCollapsed: false })
})

for (const mode of ['rail', 'aside'] as const) for (const alreadyOpen of [false, true]) test(`${mode}: collapsed group (stored open=${alreadyOpen}) expands the menu, preserves groups and does not navigate`, async () => {
  const visits: string[] = []
  areaOpenStore.set({ sessions: false, usage: true, tasks: false })
  // Render the same controlled expansion contract used by the app's aside.
  function Menu() {
    const [open, setOpen] = useState(false)
    const location = useLocation()
    return <><output data-location>{location.pathname}</output>{mode === 'rail'
      ? <AreaRail lang="en" pathname="/sessions" open={open} onOpenChange={setOpen} onNavigate={to => visits.push(to)} />
      : <div data-open={open}><AreaTree lang="en" pathname="/sessions" collapsed={!open}
          onExpand={() => setOpen(true)} onNavigate={to => visits.push(to)} /></div>}</>
  }
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<StrictMode><MemoryRouter initialEntries={['/sessions']}><Menu /></MemoryRouter></StrictMode>) })
  // A previous explicit selection can remain open while the menu is collapsed.
  await act(async () => { areaOpenStore.set({ sessions: false, usage: true, tasks: alreadyOpen }) })
  const group = host.querySelector<HTMLButtonElement>(mode === 'rail' ? '[aria-label="Agentask"]' : '[data-area-heading="tasks"]')!
  expect(group.getAttribute('aria-expanded')).toBe('false')
  await act(async () => { group.click() })
  expect(host.querySelector('[data-open]')!.getAttribute('data-open')).toBe('true')
  const heading = host.querySelector<HTMLButtonElement>('[data-area-heading="tasks"]')!
  expect(heading.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelector('a[href="/tasks/calendar"]')).not.toBeNull()
  expect(areaOpenStore.get()).toEqual({ sessions: false, usage: true, tasks: true })
  expect(document.activeElement).toBe(heading)
  expect(scrolled).toContain(heading)
  expect(host.querySelector('[data-location]')!.textContent).toBe('/sessions')
  expect(visits).toEqual([])
})

test('a collapsed destination still navigates without expanding the rail', async () => {
  const visits: string[] = []
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<MemoryRouter><AreaRail lang="en" pathname="/sessions" onNavigate={to => visits.push(to)} /></MemoryRouter>) })
  const destination = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === 'Vault')!
  expect(destination.hasAttribute('aria-expanded')).toBe(false)
  await act(async () => { destination.click() })
  expect(visits).toEqual(['/vault'])
  expect(host.querySelector('[data-area-rail]')!.getAttribute('data-open')).toBe('false')
})
