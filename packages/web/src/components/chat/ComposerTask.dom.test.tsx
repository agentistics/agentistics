import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { ComposerTaskButton, useComposerTask } from './ComposerTask'

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

test('one send turns the toggle off; retry keeps its id, a new send gets a new id', async () => {
  const sent: Array<{ messageId?: string; asTask?: unknown }> = []
  let state!: ReturnType<typeof useComposerTask>
  function Harness() {
    state = useComposerTask()
    return <><ComposerTaskButton options={state.options} onChange={state.setOptions} disabled={false} pt={false} />
      <button onClick={() => sent.push(state.take('Fix calendar'))}>Send</button></>
  }
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<Harness />) })
  const toggle = () => host.querySelector<HTMLButtonElement>('[aria-pressed]')!
  const send = () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Send')!
  expect(toggle().getAttribute('aria-pressed')).toBe('false')
  await act(async () => { toggle().click() })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Medium')
  expect(document.querySelector('input')?.type).toBe('time')
  await act(async () => { send().click() })
  expect(toggle().getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(sent[0]?.asTask).toEqual({ priority: 'medium' })
  await act(async () => { state.setOptions({ priority: 'medium' }) }) // refused send restores its options
  await act(async () => { send().click() })
  expect(sent[1]?.messageId).toBe(sent[0]?.messageId)
  state.complete()
  await act(async () => { toggle().click() })
  await act(async () => { send().click() })
  expect(sent[2]?.messageId).not.toBe(sent[0]?.messageId)
  await act(async () => { send().click() })
  expect(sent[3]).toEqual({})
})

test('glass tooltip, shared priority menu, Today, local time and dismissals preserve the next send', async () => {
  let state!: ReturnType<typeof useComposerTask>
  function Harness() {
    state = useComposerTask()
    return <ComposerTaskButton options={state.options} onChange={state.setOptions} disabled={false} pt={false} />
  }
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<Harness />) })
  const trigger = host.querySelector<HTMLButtonElement>('[data-composer-task-trigger]')!
  expect(trigger.style.borderStyle).toContain('none')
  expect(trigger.classList.contains('ag-composer-icon')).toBe(true)
  await act(async () => trigger.focus())
  expect(document.querySelector('[role="tooltip"][data-composer-menu]')?.textContent).toContain('Agentask task with the chosen priority and due date')
  expect(document.querySelector('[role="tooltip"] svg')?.getAttribute('stroke')).toBe('var(--anthropic-orange)')
  await act(async () => trigger.click())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  const priority = document.querySelector<HTMLButtonElement>('[title="Priority"]')!
  await act(async () => priority.click())
  const choices = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-chip-select-panel] button'))
  expect(choices.map(b => b.textContent)).toEqual(['Urgent', 'High', 'Medium', 'Low'])
  await act(async () => choices[0]!.click())
  expect(state.options?.priority).toBe('urgent')
  const today = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Today')!
  await act(async () => today.click())
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  expect(state.options?.dueDate).toBe(day)
  const time = document.querySelector<HTMLInputElement>('input[type="time"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(time, '14:35')
    time.dispatchEvent(new Event('input', { bubbles: true }))
    time.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(state.options?.dueDate).toBe(`${day}T14:35`)
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(trigger.style.color).toBe('var(--anthropic-orange)')
  await act(async () => trigger.click())
  await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  let taken: ReturnType<typeof state.take> = {}
  await act(async () => { taken = state.take('Deadline task') })
  expect(taken.asTask).toEqual({ priority: 'urgent', dueDate: `${day}T14:35` })
})

test('turn off is explicit and deadline selection can navigate to future months', async () => {
  function Harness() {
    const state = useComposerTask()
    return <ComposerTaskButton options={state.options} onChange={state.setOptions} disabled={false} pt />
  }
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<Harness />) })
  const trigger = host.querySelector<HTMLButtonElement>('[data-composer-task-trigger]')!
  await act(async () => trigger.click())
  const next = document.querySelector<HTMLButtonElement>('[aria-label="Próximo mês"]')!
  expect(next.disabled).toBe(false)
  await act(async () => next.click())
  const day = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find(b => /-15$/.test(b.getAttribute('aria-label') ?? ''))!
  await act(async () => day.click())
  expect(day.getAttribute('aria-pressed')).toBe('true')
  const off = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Desligar')!
  await act(async () => off.click())
  expect(trigger.getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
