/**
 * A RUNNING tool group in a real DOM (happy-dom): the click toggles it, and the choice survives
 * live updates and the end of the run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { ActivityGroup } from '../../lib/toolActivity'

let createRoot: typeof import('react-dom/client').createRoot
let ToolActivity: typeof import('./ToolActivity').ToolActivity
let stepsOfTurn: typeof import('../../lib/toolActivity').stepsOfTurn
let originalActEnvironment: boolean | undefined

beforeAll(async () => {
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  ToolActivity = (await import('./ToolActivity')).ToolActivity
  stepsOfTurn = (await import('../../lib/toolActivity')).stepsOfTurn
})
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const group = (n: number, running: boolean): ActivityGroup => {
  const steps = []
  for (let i = 0; i < n; i++) {
    const [s] = stepsOfTurn({ role: 'assistant', text: '', tools: [{ name: 'Bash', ref: `r${i}` }] })
    s!.status = running && i === n - 1 ? 'running' : 'done'
    steps.push(s!)
  }
  return { key: 'g', steps, running }
}
const show = (g: ActivityGroup) => act(() => { root.render(createElement(ToolActivity, { group: g, lang: 'en', variant: 'live', now: 0 })) })
const toggle = () => host.querySelector('button[aria-expanded]') as HTMLButtonElement
const stepRows = () => host.querySelectorAll('button.ag-act-row').length
const click = () => act(() => { toggle().click() })

test('a running group opens on click and COLLAPSES on the next one, instead of falling back to the tail', () => {
  show(group(2, true))
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(stepRows()).toBe(2) // the live tail, before anybody has chosen
  click()
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(stepRows()).toBe(2)
  click()
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(stepRows()).toBe(0) // genuinely collapsed — no tail card
})

test('the choice persists across live updates and after the run finishes', () => {
  show(group(2, true))
  click(); click() // collapsed by the reader
  show(group(3, true)) // a live update
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(stepRows()).toBe(0)
  click() // opened by the reader
  show(group(4, true))
  expect(stepRows()).toBe(4)
  show(group(4, false)) // the run ends
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(stepRows()).toBe(4)
})

// Item 35 (OPENCODE.TRAVA-FORM MED-1): a command shows what it PRINTED — collapsed by default, opened on demand.
test('a step that carries output offers it collapsed, and opens it on click', () => {
  const steps = stepsOfTurn({ role: 'assistant', text: '', pending: true, tools: [{ name: 'bash', canonical: 'execute', detail: 'echo hi; ls /nope', ref: 'c1', output: 'hi\nls: /nope: No such file' }] })
  act(() => { root.render(createElement(ToolActivity, { group: { key: 'o', steps, running: true }, lang: 'pt', variant: 'live', now: 0 })) })
  const outToggle = () => Array.from(host.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') ?? '').includes('saída'))!
  expect(outToggle()).toBeTruthy()
  expect(outToggle().getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('[data-testid="tool-output"]')).toBeNull()
  act(() => { outToggle().click() })
  expect(host.querySelector('[data-testid="tool-output"]')!.textContent).toBe('hi\nls: /nope: No such file')
  act(() => { outToggle().click() })
  expect(host.querySelector('[data-testid="tool-output"]')).toBeNull()
  // a step with no output draws no toggle
  const bare = stepsOfTurn({ role: 'assistant', text: '', tools: [{ name: 'bash', ref: 'c2' }] })
  act(() => { root.render(createElement(ToolActivity, { group: { key: 'b', steps: bare, running: false }, lang: 'pt', variant: 'live', now: 0, defaultOpen: true })) })
  expect(outToggle()).toBeUndefined()
})
