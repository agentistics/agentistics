/**
 * The chat's busy line starts at the same left edge as the tool-activity rows above it. It used to
 * sit 36px in (`paddingLeft: 36`), so "pensando" read as misaligned next to "Executou 5 comandos".
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let mods: { WorkingNote: typeof import('./WorkingNote').WorkingNote; INSET: number; ToolActivity: typeof import('./ToolActivity').ToolActivity; stepsOfTurn: typeof import('../../lib/toolActivity').stepsOfTurn }
let originalActEnvironment: boolean | undefined

beforeAll(async () => {
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  const wn = await import('./WorkingNote')
  mods = {
    WorkingNote: wn.WorkingNote, INSET: wn.WORKING_NOTE_INSET,
    ToolActivity: (await import('./ToolActivity')).ToolActivity, stepsOfTurn: (await import('../../lib/toolActivity')).stepsOfTurn,
  }
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

const leftInset = (el: HTMLElement) => parseFloat(el.style.paddingLeft || '0') + parseFloat(el.style.marginLeft || '0')

test('the busy line has no left inset of its own, like the tool-activity row (every harness)', () => {
  for (const props of [{ thinking: true }, { tools: [{ name: 'Bash' }] }, {}, { composing: 'question' as const }]) {
    act(() => root.render(createElement(mods.WorkingNote, { lang: 'pt', ...props })))
    const note = host.querySelector<HTMLElement>('[role="status"]')!
    expect(mods.INSET).toBe(0)
    expect(leftInset(note)).toBe(0)
  }
})

test('the busy line and the tool row share one left edge', () => {
  const group = { key: 'k', steps: mods.stepsOfTurn({ role: 'assistant', text: '', tools: [{ name: 'Bash' }] }), running: false }
  act(() => root.render(createElement('div', null,
    createElement(mods.ToolActivity, { group, lang: 'pt', variant: 'inline' }),
    createElement(mods.WorkingNote, { lang: 'pt', thinking: true }))))
  const tool = host.querySelector<HTMLElement>('button[aria-expanded]')!
  const note = host.querySelector<HTMLElement>('[role="status"]')!
  expect(leftInset(note)).toBe(leftInset(tool))
})
