import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { headerLeftMenus } from '../../lib/leftMenus'

let createRoot: typeof import('react-dom/client').createRoot
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let AreaRail: typeof import('./AreaRail').AreaRail
let AreaTree: typeof import('./AreaTree').AreaTree
let root: Root | undefined
let host: HTMLDivElement
let oldAct: unknown
let originalFetch: typeof fetch
beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async () => Response.json({ surfaces: [] })) as unknown as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  AreaRail = (await import('./AreaRail')).AreaRail
  AreaTree = (await import('./AreaTree')).AreaTree
})
afterEach(async () => { await act(async () => { root?.unmount() }); root = undefined; host?.remove() })
afterAll(async () => { globalThis.fetch = originalFetch; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

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
