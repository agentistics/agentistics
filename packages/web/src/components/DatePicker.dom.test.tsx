import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { DatePicker } from './DatePicker'

let createRoot: typeof import('react-dom/client').createRoot
let root: Root | undefined
let host: HTMLDivElement
let previousAct: unknown
beforeAll(async () => {
  GlobalRegistrator.register()
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  previousAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
})
afterEach(async () => { await act(async () => { root?.unmount() }); root = undefined; host?.remove() })
afterAll(async () => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousAct; await GlobalRegistrator.unregister() })

// The calendar sits on a themed surface, so only a selected day (solid orange) may be literal white.
test('enabled, disabled and selected days take readable colours in either theme', async () => {
  host = document.createElement('div'); document.body.append(host)
  await act(async () => {
    root = createRoot(host)
    root.render(<DatePicker inline value="2020-03-10" min="2020-03-05" max="2020-03-20" onChange={() => {}} label="Day" placeholder="Day" lang="en" />)
  })
  const day = (d: string) => host.querySelector<HTMLButtonElement>(`[aria-label="2020-03-${d}"]`)!
  expect(day('12').style.color).toBe('var(--text-primary)')
  expect(day('02').disabled).toBe(true)
  expect(day('02').style.color).toBe('var(--text-tertiary)')
  expect(day('02').style.opacity).toBe('')
  expect(day('25').style.color).toBe('var(--text-tertiary)')
  expect(['#fff', '#ffffff']).toContain(day('10').style.color)
  expect(day('10').style.background).toContain('var(--anthropic-orange)')
})
