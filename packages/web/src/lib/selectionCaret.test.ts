import { describe, expect, test } from 'bun:test'
import { caretOfSelection } from './selectionCaret'

describe('caretOfSelection — no re-render while text is being selected (iOS copy)', () => {
  test('a collapsed selection is a caret', () => {
    expect(caretOfSelection(7, 7)).toBe(7)
    expect(caretOfSelection(0, 0)).toBe(0)
  })
  test('a ranged selection is not a caret: nothing to update', () => {
    expect(caretOfSelection(3, 12)).toBeNull()
  })
  test('an unknown position is not a caret', () => {
    expect(caretOfSelection(null, null)).toBeNull()
  })
})
