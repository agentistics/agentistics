import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let Bar: typeof import('./MobileAreaBar').MobileAreaBar

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 844 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  Bar = (await import('./MobileAreaBar')).MobileAreaBar
})
afterEach(async () => {
  await act(async () => root?.unmount())
  const { areaOpenStore } = await import('../../lib/areaOpen')
  areaOpenStore.set({})
  root = undefined
  document.body.innerHTML = ''
})
afterAll(async () => GlobalRegistrator.unregister())

for (const lang of ['pt', 'en'] as const) test(`mobile deep link navigates leadership pages inside Sessions (${lang})`, async () => {
  let destination = ''
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Router, { initialEntries: ['/leadership/away'] },
    createElement(Bar, { lang, pathname: '/leadership/away', badges: { sessions: 3 }, actions: [], onNavigate: to => { destination = to } }))))
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  expect(trigger.getAttribute('aria-label')).toContain(lang === 'pt' ? 'Sessões › Modo ausente' : 'Sessions › Away mode')
  await act(async () => trigger.click())
  const sheet = document.querySelector('[role="dialog"]')!
  const area = sheet.querySelector('button[aria-expanded="true"]')!
  expect(area.getAttribute('aria-label')).toBe(lang === 'pt' ? 'Recolher Sessões' : 'Collapse Sessions')
  expect(sheet.querySelector('.lucide-crown')).toBeNull()
  expect(sheet.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe('/leadership/away')
  const link = sheet.querySelector<HTMLAnchorElement>('a[href="/leadership/checkins"]')!
  await act(async () => link.click())
  expect(destination).toBe('/leadership/checkins')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
