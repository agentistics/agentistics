import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'
import { PlanUsageScroll } from './PlanUsageScroll'

let createRoot: typeof import('react-dom/client').createRoot
let root: Root | undefined
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
})
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

function render() {
  const host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(h(PlanUsageScroll, { lang: 'pt', children: Array.from({ length: 10 }, (_, i) => h('div', { key: i, 'data-plan-scroll-item': true }, `Account ${i}`)) })))
  const el = host.querySelector<HTMLElement>('[data-plan-usage-scroll]')!
  Object.defineProperties(el, { clientHeight: { configurable: true, value: 250 }, scrollHeight: { configurable: true, value: 1000 } })
  for (const item of Array.from(host.querySelectorAll<HTMLElement>('[data-plan-scroll-item]'))) item.getBoundingClientRect = () => ({ height: 96 }) as DOMRect
  act(() => el.dispatchEvent(new Event('scroll', { bubbles: true })))
  return { host, el }
}

test('overflow shows an accessible arrow; end and no overflow hide it; resize updates it', () => {
  const { host, el } = render()
  expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Rolar para mais contas')
  el.scrollTop = 750
  act(() => el.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(host.querySelector('button')).toBeNull()
  el.scrollTop = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 250 })
  act(() => window.dispatchEvent(new Event('resize')))
  expect(host.querySelector('button')).toBeNull()
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
  act(() => window.dispatchEvent(new Event('resize')))
  expect(host.querySelector('button')).not.toBeNull()
})

test('click advances a rounded number of visible items smoothly and caps at the end', () => {
  const { host, el } = render()
  const scroll = mock(() => {})
  el.scrollBy = scroll
  act(() => host.querySelector('button')!.click())
  expect(scroll).toHaveBeenLastCalledWith({ top: 300, behavior: 'smooth' })
  el.scrollTop = 700
  act(() => host.querySelector('button')!.click())
  expect(scroll).toHaveBeenLastCalledWith({ top: 50, behavior: 'smooth' })
})
