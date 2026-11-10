import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { ComposerTaskButton, ComposerTaskFields, useComposerTask } from './ComposerTask'

let createRoot: typeof import('react-dom/client').createRoot
let root: Root | undefined
let host: HTMLDivElement
let previousAct: unknown
beforeAll(async () => {
  GlobalRegistrator.register()
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
      <ComposerTaskFields options={state.options} onChange={state.setOptions} pt={false} />
      <button onClick={() => sent.push(state.take('Fix calendar'))}>Send</button></>
  }
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<Harness />) })
  const toggle = () => host.querySelector<HTMLButtonElement>('[aria-pressed]')!
  const send = () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Send')!
  expect(toggle().getAttribute('aria-pressed')).toBe('false')
  await act(async () => { toggle().click() })
  expect(host.querySelector('select')?.value).toBe('medium')
  expect(host.querySelector('input')?.type).toBe('date')
  await act(async () => { send().click() })
  expect(toggle().getAttribute('aria-pressed')).toBe('false')
  expect(host.querySelector('select')).toBeNull()
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
