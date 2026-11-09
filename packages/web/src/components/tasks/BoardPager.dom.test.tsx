import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Pager: typeof import('./BoardPager').BoardPager
let resolve: typeof import('./boardPaging').resolveBoardPage

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Pager = (await import('./BoardPager')).BoardPager
  resolve = (await import('./boardPaging')).resolveBoardPage
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

async function mount(total: number, size: 10 | 25 | 50 | 100, page: number, calls: unknown[]) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Pager, {
    info: resolve(total, size, page), pageSize: size, lang: 'en',
    onPage: n => calls.push(['page', n]), onPageSize: n => calls.push(['size', n]),
  })))
}

test('draws nothing while everything fits the smallest page size', async () => {
  await mount(10, 10, 0, [])
  expect(document.querySelector('[data-board-pager]')).toBeNull()
})

test('shows the range, pages forward, and offers 10/25/50/100', async () => {
  const calls: unknown[] = []
  await mount(23, 10, 0, calls)
  const el = document.querySelector('[data-board-pager]')!
  expect(el.textContent).toContain('1–10 of 23')
  expect(Array.from(el.querySelectorAll('button[aria-pressed]')).map(b => b.textContent)).toEqual(['10', '25', '50', '100'])
  await act(async () => (el.querySelector('button[aria-label="Next page"]') as HTMLElement).click())
  await act(async () => (Array.from(el.querySelectorAll('button[aria-pressed]')).find(b => b.textContent === '50') as HTMLElement).click())
  expect(calls).toEqual([['page', 1], ['size', 50]])
})

test('previous is disabled on the first page', async () => {
  await mount(23, 10, 0, [])
  expect((document.querySelector('button[aria-label="Previous page"]') as HTMLButtonElement).disabled).toBe(true)
})
