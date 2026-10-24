import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalCard } from './ApprovalCard'

describe('ApprovalCard', () => {
  // `useIsMobile` reads the viewport on its first render; a desktop width, removed afterwards so no
  // other file sees a `window` it did not set up.
  const hadWindow = typeof window !== 'undefined'
  beforeAll(() => { if (!hadWindow) (globalThis as { window?: unknown }).window = { innerWidth: 1280 } })
  afterAll(() => { if (!hadWindow) delete (globalThis as { window?: unknown }).window })

  test('renders a pre-conversation trust dialog with actionable choices', () => {
    const html = renderToStaticMarkup(<ApprovalCard
      lang="en"
      row={{
        id: 'agy-1', title: 'Antigravity', state: 'waiting-approval',
        approvalLines: ['Do you trust this folder?'],
        dialogOptions: [
          { number: 1, label: 'Yes, I trust this folder', selected: true },
          { number: 2, label: 'No, exit', selected: false },
        ],
        verbs: [{ action: 'approve', label: 'Answer', enabled: true }],
      } as never}
      act={async () => ({ ok: true, message: 'answered' })}
    />)
    expect(html).toContain('This session is asking')
    expect(html).toContain('Do you trust this folder?')
    expect(html).toContain('Yes, I trust this folder')
    expect(html).toContain('No, exit')
  })

  const form = (dialogForm: Record<string, unknown>, options: Record<string, unknown>[]) => renderToStaticMarkup(<ApprovalCard
    lang="en"
    row={{
      id: 'c-1', title: 'Claude', state: 'waiting-approval',
      approvalLines: ['Which fruits?'],
      dialogOptions: options,
      dialogForm,
      verbs: [{ action: 'approve', label: 'Answer', enabled: true }],
    } as never}
    act={async () => ({ ok: true, message: 'ok' })}
  />)

  test('a multi-select step draws CHECKBOXES, its steps and the step buttons', () => {
    const html = form(
      { multi: true, canStep: true, steps: [{ label: 'Fruit', done: true }, { label: 'Color', done: false }] },
      [
        { number: 1, label: 'Apple', selected: true, checked: true },
        { number: 2, label: 'Banana', selected: false, checked: false },
        { number: 3, label: 'Type something', selected: false, checked: false, freeText: true },
      ],
    )
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-checked="false"')
    // The box is drawn, the `[ ]` text never is.
    expect(html).not.toContain('[ ]')
    expect(html).toContain('Fruit')
    expect(html).toContain('Color')
    expect(html).toContain('Next')
    expect(html).toContain('Previous question')
    expect(html).toContain('Tick as many as you want')
  })

  test('no step buttons where the harness has no driven step keys', () => {
    const html = form({ multi: true, steps: [{ label: 'Fruit', done: false }] }, [
      { number: 1, label: 'Apple', selected: true, checked: false },
      { number: 2, label: 'Banana', selected: false, checked: false },
    ])
    expect(html).not.toContain('Previous question')
    expect(html).not.toContain('>Next<')
  })

  test('the review step offers its own options and no Next', () => {
    const html = form({ review: true, canStep: true, steps: [{ label: 'Fruit', done: true }, { label: 'Color', done: true }] }, [
      { number: 1, label: 'Submit answers', selected: true },
      { number: 2, label: 'Cancel', selected: false },
    ])
    expect(html).toContain('Submit answers')
    expect(html).toContain('Previous question')
    expect(html).not.toContain('role="checkbox"')
    expect(html).not.toMatch(/>Next</)
  })

  test("agy's `Question n of m`; no Previous on the first", () => {
    const html = form({ multi: true, canStep: true, position: { at: 1, of: 2 } }, [
      { number: 1, label: 'Apple', selected: true, checked: false },
      { number: 2, label: 'Banana', selected: false, checked: false },
    ])
    expect(html).toContain('Question 1 of 2')
    expect(html).not.toContain('Previous question')
    expect(html).toContain('Next')
  })

  test('a STRUCTURED multi-select keeps its ticks and sends them together', () => {
    const html = form({ multi: true, together: true }, [
      { number: 1, label: 'Apple', selected: true, checked: false },
      { number: 2, label: 'Banana', selected: false, checked: false },
    ])
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('Send answer (0)')
    expect(html).toContain('then send')
    expect(html).not.toContain('Previous question')
  })

  test('"Send answer" counts the typed option while the composer holds it', () => {
    const html = renderToStaticMarkup(<ApprovalCard
      lang="en" answering={3} onSendAnswering={() => {}}
      row={{ id: 's', title: 'S', state: 'waiting-approval', approvalLines: ['Colors: Which?', '', '1. Red', '2. Green', '3. Type something'],
        dialogOptions: [{ number: 1, label: 'Red', selected: true, checked: false }, { number: 2, label: 'Green', selected: false, checked: false }, { number: 3, label: 'Type something', selected: false, checked: false, freeText: true }],
        dialogForm: { multi: true, together: true }, verbs: [{ action: 'approve', label: 'Answer', enabled: true }] } as never}
      act={async () => ({ ok: true, message: 'ok' })}
    />)
    expect(html).toContain('Send answer (1)')
    expect(html).toContain('Colors: Which?')
  })
})
