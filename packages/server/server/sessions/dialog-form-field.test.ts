/**
 * Live QA 2026-10-24 (P2): on claude's multi-select, a typed write-your-own answer TRAPPED the card —
 * the next tick's digit went into the field (`Purple22`) and `Right` moved the caret while the card
 * said "moved". Frames captured from claude 2.1.309 under tmux the same day: typed, after `Up`, after
 * a digit, after `Right`.
 */
import { describe, expect, it } from 'bun:test'
import { formMoved, readDialog } from './dialog-choice'
import { fieldIsOpen } from './approval-spec'
import { leaveField } from '../cli-start'

const RULE = '─'.repeat(118)
const frame = (cursor: 1 | 2 | 3, b: string, c: string, footer: string, q = 'Which fruits?') => [
  '←  ☒ Fruit  ☐ Size  ✔ Submit  →',
  q,
  `${cursor === 1 ? '❯' : ' '} 1. [ ] Apple`, '         Apple',
  `${cursor === 2 ? '❯' : ' '} 2. ${b} Banana`, '         Banana',
  `${cursor === 3 ? '❯' : ' '} 3. ${c}`,
  '     Next', RULE, '  4. Chat about this', footer,
]
const FIELD = 'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in VS Code · Esc to cancel'
const PLAIN = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
const TYPED = frame(3, '[ ]', '[✔] Purple', FIELD)
const TRAPPED = frame(3, '[ ]', '[✔] Purple22', FIELD)
const LEFT = frame(2, '[ ]', '[✔] Purple', PLAIN)
const NEXT_Q = [
  RULE, '←  ☒ Fruit  ☐ Size  ✔ Submit  →', 'Which size?',
  '❯ 1. S', '     S', '  2. M', '     M', '  3. Type something.', RULE, '  4. Chat about this', PLAIN,
]

describe('a typed answer must not trap the form', () => {
  it('the field is seen open while the cursor sits on the typed box, closed once it moves off', () => {
    expect(fieldIsOpen('claude', TYPED)).toBe(true)
    expect(fieldIsOpen('claude', LEFT)).toBe(false)
  })

  it('a caret moving or a digit typed INTO the field is not a move; the next question is', () => {
    expect(formMoved(TYPED, TRAPPED)).toBe(false)
    expect(formMoved(TYPED, frame(3, '[ ]', '[✔] Purpl', FIELD))).toBe(false)
    expect(formMoved(LEFT, frame(2, '[✔]', '[✔] Purple', PLAIN))).toBe(false) // a tick
    expect(formMoved(LEFT, NEXT_Q)).toBe(true)
    expect(readDialog(TYPED).options[2]!.label).toBe('Purple')
  })

  it('leaveField presses Up once and hands back the frame with the field closed', async () => {
    const sent: string[] = []
    const backend = { sendKey: async (_id: string, k: string) => { sent.push(k); return true }, capture: async () => LEFT }
    expect(await leaveField(backend as never, 'm-1', 'claude', TYPED)).toEqual(LEFT)
    expect(sent).toEqual(['Up'])
  })

  it('does nothing when no field is open, and refuses when the field will not close', async () => {
    const sent: string[] = []
    const backend = { sendKey: async (_id: string, k: string) => { sent.push(k); return true }, capture: async () => TYPED }
    expect(await leaveField(backend as never, 'm-1', 'claude', LEFT)).toEqual(LEFT)
    expect(sent).toEqual([])
    expect(await leaveField(backend as never, 'm-1', 'claude', TYPED)).toBeNull()
    expect(sent).toEqual(['Up'])
  })
})
