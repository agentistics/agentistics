/**
 * Live QA r2 (P2): on a STRUCTURED multi-select, Green ticked and "Type something" typed in the
 * composer, the card's own "Send answer" sent the ticks alone — the typed words were dropped in
 * silence. While the composer holds the typed answer, the button must send THROUGH the composer.
 * Real DOM, real clicks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let ApprovalCard: typeof import('./ApprovalCard').ApprovalCard

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  createRoot = (await import('react-dom/client')).createRoot
  ApprovalCard = (await import('./ApprovalCard')).ApprovalCard
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const row = {
  id: 's', title: 'S', state: 'waiting-approval',
  approvalLines: ['Colors: Which?', '', '1. Red', '2. Green', '3. Type something'],
  dialogOptions: [
    { number: 1, label: 'Red', selected: true, checked: false },
    { number: 2, label: 'Green', selected: false, checked: false },
    { number: 3, label: 'Type something', selected: false, checked: false, freeText: true },
  ],
  dialogForm: { multi: true, together: true },
  verbs: [{ action: 'approve', label: 'Answer', enabled: true }],
}

function mount(props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  act(() => { root.render(createElement(ApprovalCard, { row: row as never, lang: 'en', ...props } as never)) })
  const button = (label: RegExp) => Array.from(el.querySelectorAll('button')).find(b => label.test(b.textContent ?? ''))!
  return { el, root, button }
}

describe('the structured multi-select "Send answer"', () => {
  test('while the composer holds the typed answer, Send goes through the composer — never the ticks alone', () => {
    const acts: unknown[] = []
    const writes: unknown[] = []
    let composerSends = 0
    const m = mount({
      answering: 3,
      act: async (r: unknown) => { acts.push(r); return { ok: true, message: 'ok' } },
      onWrite: (o: unknown) => writes.push(o),
      onSendAnswering: () => { composerSends++ },
    })
    act(() => { m.button(/Green/).click() })
    // The tick reached the composer, which will send it WITH the words.
    expect(writes.at(-1)).toEqual({ number: 3, label: 'Type something', choices: [2] })
    expect(m.button(/Send answer/).textContent).toContain('(2)')
    act(() => { m.button(/Send answer/).click() })
    expect(composerSends).toBe(1)
    expect(acts).toEqual([])
    act(() => m.root.unmount())
  })

  test('with no typed answer, Send sends the ticks itself', async () => {
    const acts: unknown[] = []
    const m = mount({ act: async (r: unknown) => { acts.push(r); return { ok: true, message: 'ok' } }, onSendAnswering: () => {} })
    act(() => { m.button(/Red/).click() })
    act(() => { m.button(/Green/).click() })
    await act(async () => { m.button(/Send answer/).click() })
    expect(acts).toEqual([{ id: 's', action: 'approve', choices: [1, 2] }])
    act(() => m.root.unmount())
  })
})
