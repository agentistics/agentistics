import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Router: typeof import('react-router-dom').MemoryRouter
let Tree: typeof import('./AreaTree').AreaTree
let Rail: typeof import('./AreaRail').AreaRail
let Header: typeof import('./PageHeader').PageHeader

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1440, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Router = (await import('react-router-dom')).MemoryRouter
  Tree = (await import('./AreaTree')).AreaTree
  Rail = (await import('./AreaRail')).AreaRail
  Header = (await import('./PageHeader')).PageHeader
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})
afterAll(async () => GlobalRegistrator.unregister())

for (const lang of ['pt', 'en'] as const) {
  for (const variant of ['aside', 'sheet'] as const) test(`Usage uses the Agentask beta chip in ${variant}, ${lang}`, async () => {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(Router, null,
      createElement(Tree, { lang, pathname: '/usage', variant }))))
    const usage = document.querySelector('a[href="/usage"]')!
    const tasks = document.querySelector('a[href="/tasks"]')!
    const chip = usage.querySelector('span[title]') as HTMLElement
    const reference = tasks.querySelector('span[title]') as HTMLElement
    expect(chip.textContent).toBe('beta')
    expect(chip.style.cssText).toBe(reference.style.cssText)
    expect(chip.title).toContain(lang === 'pt' ? 'Uso está em beta' : 'Usage is in beta')
  })
  test(`rail tooltip and every Usage page title carry beta, ${lang}`, async () => {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(Router, null,
      createElement(Rail, { lang, pathname: '/sessions' }),
      ...['now', 'history', 'accounts'].map(pageId => createElement(Header, { key: pageId, lang, areaId: 'usage', pageId })))))
    const link = document.querySelector('a[href="/usage"]')!
    await act(async () => link.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const tip = document.querySelector('[role="tooltip"]')!
    expect(tip.textContent).toContain(lang === 'pt' ? 'Uso' : 'Usage')
    expect(tip.querySelector('span[title]')?.textContent).toBe('beta')
    expect(Array.from(document.querySelectorAll('h1')).every(h => h.querySelector('span[title]')?.textContent === 'beta')).toBe(true)
  })
}
